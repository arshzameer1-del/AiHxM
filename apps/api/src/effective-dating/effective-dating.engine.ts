import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

/**
 * A single, shared implementation of the effective-dating pattern this
 * codebase had independently hand-built four times over (employee
 * compensation, shift assignments, leave policy entitlements, tax
 * slabs) before this engine existed. Each of those four copies got the
 * core idea right — versioned rows, "close the prior open one, insert a
 * new one," a history query — but each was its own copy of that logic,
 * with no guarantee a fix or refinement made in one would ever reach
 * the other three. Four independent, hand-copied implementations of the
 * identical pattern is past the point ("the rule of three") where real
 * engineering organizations extract shared infrastructure rather than
 * keep copying — see claude/aihxm-master-audit-and-roadmap.md's Part 4
 * "Reconciling the new Master Development Instruction doc..." entry for
 * the full reasoning behind why this exists now.
 *
 * This engine is deliberately NOT a generic "versioned entity" ORM
 * layer — it stays a thin, explicit set of operations over plain SQL,
 * matching this codebase's existing no-ORM discipline (Decision #2).
 * Every table it's used against still owns its own migration, its own
 * RLS policy, and its own row shape; this engine only centralizes the
 * *behavior* of superseding one version with the next.
 *
 * Every table this engine operates on is expected to have, at minimum:
 *   effective_from date NOT NULL
 *   effective_to   date NULL          -- NULL means "currently open"
 * plus a partial unique index enforcing at most one open row per scope
 * (the same invariant migration 0033 introduced for leave_policy_versions
 * and tax_slabs, and 0010/0026 already relied on informally for
 * employee_compensation/shift_assignments).
 *
 * Two supersession shapes are supported, because the two real patterns
 * in this codebase are genuinely different at this granularity:
 *
 *  - `applyVersionedRow` — ONE open row per scope, versioned in place
 *    (leave policy entitlements, employee compensation, shift
 *    assignments: "this employee's shift" is a single fact at a time).
 *
 *  - `applyVersionedSet` — a WHOLE SET of open rows per scope, replaced
 *    together as one generation (tax slabs: a bracket table is many
 *    rows that only make sense as a set, and a change replaces all of
 *    them at once, not row-by-row).
 *
 * Both share the same two rules, applied identically:
 *   1. Close the currently-open row(s) with `effective_to` set to one
 *      day before the new version's `effective_from` — so consecutive
 *      generations are adjacent with no gap and no overlap.
 *   2. Same-window collapse: if the new change's `effectiveFrom` falls
 *      on or before the day the currently-open version itself became
 *      effective, closing it would produce an invalid
 *      `effective_to < effective_from` range. Rather than reject the
 *      edit, it's applied to the still-open version/set IN PLACE. In
 *      practice every caller today always supersedes as of "today," so
 *      this manifests as the "same-day collapse" guard this session
 *      already designed twice by hand (0033's leave-policy and
 *      tax-slab versions) — the >= comparison here is a safe, slightly
 *      more general form of that same rule, not a behavior change for
 *      either existing caller.
 */

export type Row = Record<string, unknown>;

export interface ScopedTableSpec {
  /** The real table name, e.g. "leave_policy_versions" or "tax_slabs". */
  table: string;
  /** Column/value pairs identifying "which thing's version history this is" — e.g. { policy_id: id } or { company_id: companyId }. AND-ed together. */
  scope: Record<string, string | number>;
}

export interface GetCurrentOptions extends ScopedTableSpec {
  orderBy?: string;
}

export interface GetHistoryOptions extends ScopedTableSpec {
  orderBy?: string;
}

export interface ApplyVersionedRowOptions extends ScopedTableSpec {
  /** The versioned value columns and their new values, e.g. { annual_leave_days: 20 }. Does NOT include scope columns, effective_from/effective_to, or id. */
  data: Record<string, unknown>;
  /** Extra columns to carry on every INSERT that aren't part of the versioned "data" and aren't already in `scope` (e.g. a denormalized company_id alongside a policy_id scope). */
  extraInsertColumns?: Record<string, unknown>;
  /** Defaults to today (server date) when omitted — every existing caller always supersedes as of today. */
  effectiveFrom?: string;
  /**
   * Optional end date for the NEW row itself — for a consumer like shift
   * assignments where a change can be a bounded, temporary assignment
   * rather than an open-ended one. Omitted (the ordinary case, and the
   * only case Leave Policies/Tax Slabs ever use) means the new row is
   * open-ended, same as before.
   */
  effectiveTo?: string | null;
}

export interface ApplyVersionedSetOptions extends ScopedTableSpec {
  /** The new generation's rows, each a full set of non-scope, non-effective-dating columns to insert. */
  rows: Record<string, unknown>[];
  effectiveFrom?: string;
}

export interface ApplyResult<T> {
  collapsed: boolean;
}

export interface ApplyVersionedRowResult<T> extends ApplyResult<T> {
  row: T;
}

export interface ApplyVersionedSetResult<T> extends ApplyResult<T> {
  rows: T[];
}

/** `YYYY-MM-DD`, tolerant of a Date, a driver-returned date string, or already-ISO input — the same normalization every one of the four hand-built copies reimplemented as its own local `toIso`/`toIsoDate` helper. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toIsoDate(value: any): string {
  if (value === null || value === undefined) {
    throw new Error("toIsoDate: value is null/undefined");
  }
  const iso = value?.toISOString ? value.toISOString() : String(value);
  return iso.slice(0, 10);
}

function quoteIdent(name: string): string {
  // Column/table names passed to this engine are always literals from our
  // own source (migration column names, never end-user input), but this
  // guard keeps it that way rather than trusting that discipline forever.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function buildWhere(scope: Record<string, unknown>, startAt = 1): { clause: string; values: unknown[] } {
  const keys = Object.keys(scope);
  const clause = keys.map((k, i) => `${quoteIdent(k)} = $${startAt + i}`).join(" AND ");
  return { clause, values: keys.map((k) => scope[k]) };
}

@Injectable()
export class EffectiveDatingEngine {
  /** All rows currently open (`effective_to IS NULL`) for a scope — the ordinary shape for `applyVersionedSet` tables where "current" is a set of rows, and also usable for a single-row table when the caller wants the raw row array. */
  async getCurrentRows<T = Row>(client: PoolClient, opts: GetCurrentOptions): Promise<T[]> {
    const { clause, values } = buildWhere(opts.scope);
    const order = opts.orderBy ? ` ORDER BY ${opts.orderBy}` : "";
    const result = await client.query(
      `SELECT * FROM ${quoteIdent(opts.table)} WHERE ${clause} AND effective_to IS NULL${order}`,
      values
    );
    return result.rows as T[];
  }

  /** The single currently-open row for a scope, or null — the ordinary shape for `applyVersionedRow` tables. */
  async getCurrentRow<T = Row>(client: PoolClient, opts: GetCurrentOptions): Promise<T | null> {
    const rows = await this.getCurrentRows<T>(client, opts);
    return rows[0] ?? null;
  }

  /** Every generation this scope has ever had, oldest first by default — the shared "reconstruct what was in effect on date X" query every one of the four hand-built copies exposed as its own `get*History` method. */
  async getHistory<T = Row>(client: PoolClient, opts: GetHistoryOptions): Promise<T[]> {
    const { clause, values } = buildWhere(opts.scope);
    const order = opts.orderBy ?? "effective_from ASC";
    const result = await client.query(`SELECT * FROM ${quoteIdent(opts.table)} WHERE ${clause} ORDER BY ${order}`, values);
    return result.rows as T[];
  }

  /**
   * Supersede (or, if this is a same-window edit, update in place) the
   * single open row for a scope. Matches `leave_policy_versions`'
   * `updateLeavePolicy()` supersession logic exactly (migration 0033),
   * generalized to any single-row-versioned table.
   */
  async applyVersionedRow<T = Row>(client: PoolClient, opts: ApplyVersionedRowOptions): Promise<ApplyVersionedRowResult<T>> {
    const effectiveFrom = opts.effectiveFrom ?? toIsoDate(new Date());
    const current = await this.getCurrentRow<Row>(client, { table: opts.table, scope: opts.scope });

    if (!current) {
      const row = await this.insertRow<T>(client, opts.table, {
        ...opts.scope,
        ...(opts.extraInsertColumns ?? {}),
        ...opts.data,
        effective_from: effectiveFrom,
        ...(opts.effectiveTo !== undefined ? { effective_to: opts.effectiveTo } : {}),
      });
      return { row, collapsed: false };
    }

    const collapsed = toIsoDate(current.effective_from) >= effectiveFrom;
    if (collapsed) {
      const row = await this.updateRowById<T>(client, opts.table, current.id as string, {
        ...opts.data,
        ...(opts.effectiveTo !== undefined ? { effective_to: opts.effectiveTo } : {}),
      });
      return { row, collapsed: true };
    }

    await client.query(
      `UPDATE ${quoteIdent(opts.table)} SET effective_to = ($2::date - INTERVAL '1 day')::date WHERE id = $1`,
      [current.id, effectiveFrom]
    );
    const row = await this.insertRow<T>(client, opts.table, {
      ...opts.scope,
      ...(opts.extraInsertColumns ?? {}),
      ...opts.data,
      effective_from: effectiveFrom,
      ...(opts.effectiveTo !== undefined ? { effective_to: opts.effectiveTo } : {}),
    });
    return { row, collapsed: false };
  }

  /**
   * Supersede (or, if this is a same-window edit, replace in place) the
   * whole SET of open rows for a scope, as one generation. Matches
   * `tax_slabs`' `setTaxSlabs()` supersession logic exactly (migration
   * 0033), generalized to any row-set-versioned table.
   */
  async applyVersionedSet<T = Row>(client: PoolClient, opts: ApplyVersionedSetOptions): Promise<ApplyVersionedSetResult<T>> {
    const effectiveFrom = opts.effectiveFrom ?? toIsoDate(new Date());
    const { clause, values } = buildWhere(opts.scope);
    const openRows = await this.getCurrentRows<Row>(client, { table: opts.table, scope: opts.scope });

    const collapsed = openRows.length > 0 && toIsoDate(openRows[0].effective_from) >= effectiveFrom;
    if (collapsed) {
      await client.query(`DELETE FROM ${quoteIdent(opts.table)} WHERE ${clause} AND effective_to IS NULL`, values);
    } else if (openRows.length > 0) {
      await client.query(
        `UPDATE ${quoteIdent(opts.table)} SET effective_to = ($${values.length + 1}::date - INTERVAL '1 day')::date WHERE ${clause} AND effective_to IS NULL`,
        [...values, effectiveFrom]
      );
    }

    const inserted: T[] = [];
    for (const rowData of opts.rows) {
      const row = await this.insertRow<T>(client, opts.table, {
        ...opts.scope,
        ...rowData,
        effective_from: effectiveFrom,
      });
      inserted.push(row);
    }
    return { rows: inserted, collapsed };
  }

  private async insertRow<T>(client: PoolClient, table: string, columns: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(columns);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const result = await client.query(
      `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      keys.map((k) => columns[k])
    );
    return result.rows[0] as T;
  }

  private async updateRowById<T>(client: PoolClient, table: string, id: string, data: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(data);
    const setClause = keys.map((k, i) => `${quoteIdent(k)} = $${i + 2}`).join(", ");
    const result = await client.query(
      `UPDATE ${quoteIdent(table)} SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => data[k])]
    );
    return result.rows[0] as T;
  }
}
