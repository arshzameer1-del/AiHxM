import { localToday } from "../common/local-date";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { EmployeeNumberFormat } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { formatEmployeeNumber, parseEmployeeNumberSequence } from "./employee-number.util";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NumberGenerationTiming = "hire" | "draft" | "save" | "approval";
export type EmployeeNumberPolicyView = {
  companyId: string;
  generationTiming: NumberGenerationTiming;
  uniquenessScope: "company";
  resetPolicy: "never" | "yearly";
  allowManual: boolean;
  manualPattern: string;
  updatedAt: string | null;
};
export type EmployeeNumberLedgerView = {
  id: string;
  employeeNumber: string;
  state: "reserved" | "issued" | "void";
  seriesKey: string;
  sequenceNo: number | null;
  source: "generated" | "manual" | "imported" | "backfill";
  hireProcessId: string | null;
  employeeId: string | null;
  reservedAt: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
};
export type UpdateEmployeeNumberPolicyRequest = Partial<Pick<EmployeeNumberPolicyView, "generationTiming" | "resetPolicy" | "allowManual" | "manualPattern">>;

const DEFAULT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v ? (v.toISOString ? v.toISOString() : String(v)) : null);

/**
 * Gap Register CFG-13 — the one place employee numbers are produced.
 *
 * Generation is atomic: the series counter row is locked (`FOR UPDATE`) in the
 * caller's transaction, candidates that already exist in the ledger or on an
 * employee are skipped, and every generated number is written to the
 * `employee_numbers` ledger as `reserved` (the employees trigger flips it to
 * `issued` when the employee row is created; a cancelled/expired hire voids
 * it). A voided number is never reused (ledger UNIQUE + trigger guard).
 * Timing (draft / save / approval / hire), series reset and the manual-number
 * rules are per-company policy rows, defaulting to the previous behaviour.
 */
@Injectable()
export class EmployeeNumberingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ---------------------------------------------------------------- policy
  async loadPolicy(client: PoolClient, companyId: string): Promise<EmployeeNumberPolicyView> {
    const r = await client.query("SELECT * FROM employee_number_policy WHERE company_id = $1", [companyId]);
    const row = r.rows[0];
    return {
      companyId,
      generationTiming: row?.generation_timing ?? "hire",
      uniquenessScope: "company",
      resetPolicy: row?.reset_policy ?? "never",
      allowManual: row?.allow_manual ?? true,
      manualPattern: row?.manual_pattern ?? DEFAULT_PATTERN,
      updatedAt: iso(row?.updated_at),
    };
  }

  async getPolicy(claims: RequestClaims): Promise<EmployeeNumberPolicyView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.loadPolicy(client, claims.company_id!));
  }

  async updatePolicy(claims: RequestClaims, patch: UpdateEmployeeNumberPolicyRequest): Promise<EmployeeNumberPolicyView> {
    await this.requireManage(claims);
    if (patch.manualPattern !== undefined) {
      try {
        new RegExp(patch.manualPattern);
      } catch {
        throw new BadRequestException("manualPattern is not a valid regular expression");
      }
      // A repeat inside a repeat, like (a+)+ , can make the server spin for minutes on a short input. Refuse that shape.
      if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(patch.manualPattern)) {
        throw new BadRequestException("manualPattern repeats a repeated group, which can hang the server. Use a simpler pattern like ^EMP-\\d{4}$.");
      }
    }
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id!;
      const before = await this.loadPolicy(client, companyId);
      const actor = UUID_RE.test(claims.sub ?? "") ? claims.sub : null;
      await client.query(
        `INSERT INTO employee_number_policy (company_id, generation_timing, reset_policy, allow_manual, manual_pattern, updated_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id) DO UPDATE SET generation_timing = $2, reset_policy = $3, allow_manual = $4, manual_pattern = $5,
                updated_by_user_account_id = $6, updated_at = now()`,
        [
          companyId,
          patch.generationTiming ?? before.generationTiming,
          patch.resetPolicy ?? before.resetPolicy,
          patch.allowManual ?? before.allowManual,
          patch.manualPattern ?? before.manualPattern,
          actor,
        ]
      );
      const after = await this.loadPolicy(client, companyId);
      await this.audit.record(client, claims, {
        companyId,
        action: "employee_number_policy.update",
        target: companyId,
        metadata: { before, after },
      });
      return after;
    });
  }

  /** How many employee numbers have been issued (the Configuration Center card's count). Same access rule as the rest. */
  async countIssued(claims: RequestClaims): Promise<number> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM employee_numbers WHERE company_id = $1 AND state = 'issued'", [claims.company_id]);
      return r.rows[0].n as number;
    });
  }

  async list(claims: RequestClaims, filters: { state?: string; limit?: number } = {}): Promise<EmployeeNumberLedgerView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM employee_numbers WHERE company_id = $1 AND ($2::text IS NULL OR state = $2) ORDER BY created_at DESC, employee_number LIMIT $3`,
        [claims.company_id, filters.state ?? null, Math.min(filters.limit ?? 200, 1000)]
      );
      return r.rows.map((row) => ({
        id: row.id,
        employeeNumber: row.employee_number,
        state: row.state,
        seriesKey: row.series_key,
        sequenceNo: row.sequence_no,
        source: row.source,
        hireProcessId: row.hire_process_id,
        employeeId: row.employee_id,
        reservedAt: iso(row.reserved_at),
        issuedAt: iso(row.issued_at),
        voidedAt: iso(row.voided_at),
        voidReason: row.void_reason,
        createdAt: iso(row.created_at) as string,
      }));
    });
  }

  // ------------------------------------------------------------ allocation
  /**
   * Returns the number to put on a new employee row. With `explicitNumber`
   * (imported / manual / a reservation made earlier by the same hire process)
   * it validates instead of generating.
   */
  async allocate(
    client: PoolClient,
    claims: RequestClaims,
    companyId: string,
    opts: { explicitNumber?: string; hireProcessId?: string; source?: "generated" | "manual" | "imported" } = {}
  ): Promise<string> {
    const cfg = await client.query<{ employee_number_format: EmployeeNumberFormat }>(
      "SELECT employee_number_format FROM company_config WHERE company_id = $1",
      [companyId]
    );
    if (cfg.rowCount === 0) throw new NotFoundException("Company config not found");
    const format = cfg.rows[0].employee_number_format;
    const policy = await this.loadPolicy(client, companyId);
    const seriesKey = policy.resetPolicy === "yearly" ? localToday().slice(0, 4) : "";

    // lock the series counter (legacy counter seeds the '' series)
    if (seriesKey === "") {
      await client.query(
        "INSERT INTO employee_number_sequences (company_id, next_sequence) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING",
        [companyId, Math.max(1, format.startingSequence ?? 1)]
      );
    }
    await client.query(
      `INSERT INTO employee_number_series (company_id, series_key, next_sequence)
       VALUES ($1, $2, COALESCE((SELECT next_sequence FROM employee_number_sequences WHERE company_id = $1 AND $2 = ''), $3))
       ON CONFLICT (company_id, series_key) DO NOTHING`,
      [companyId, seriesKey, seriesKey === "" ? Math.max(1, format.startingSequence ?? 1) : 1]
    );
    const locked = await client.query<{ next_sequence: number }>(
      "SELECT next_sequence FROM employee_number_series WHERE company_id = $1 AND series_key = $2 FOR UPDATE",
      [companyId, seriesKey]
    );
    let current = locked.rows[0].next_sequence;
    // the legacy counter may be ahead if an older build advanced it
    if (seriesKey === "") {
      const legacy = await client.query<{ next_sequence: number }>("SELECT next_sequence FROM employee_number_sequences WHERE company_id = $1", [companyId]);
      if (legacy.rows[0] && legacy.rows[0].next_sequence > current) current = legacy.rows[0].next_sequence;
    }

    const setCounter = async (next: number) => {
      await client.query("UPDATE employee_number_series SET next_sequence = $3 WHERE company_id = $1 AND series_key = $2", [companyId, seriesKey, next]);
      if (seriesKey === "") await client.query("UPDATE employee_number_sequences SET next_sequence = $2 WHERE company_id = $1", [companyId, next]);
    };

    if (opts.explicitNumber) {
      const number = opts.explicitNumber.trim();
      const processGuc = await client.query<{ v: string | null }>("SELECT NULLIF(current_setting('app.hire_process_id', true), '') AS v");
      const processId = opts.hireProcessId ?? processGuc.rows[0].v;
      const ledger = await client.query("SELECT state, hire_process_id FROM employee_numbers WHERE company_id = $1 AND employee_number = $2", [companyId, number]);
      const row = ledger.rows[0];
      if (row) {
        if (row.state === "reserved" && processId && row.hire_process_id === processId) return number; // our own reservation
        throw new ConflictException(
          row.state === "void" ? `Employee number ${number} was voided and is never reused` : `Employee number ${number} is already ${row.state === "reserved" ? "reserved" : "in use"}`
        );
      }
      const exists = await client.query("SELECT 1 FROM employees WHERE company_id = $1 AND employee_number = $2", [companyId, number]);
      if ((exists.rowCount ?? 0) > 0) throw new ConflictException(`Employee number ${number} is already in use`);
      if (!policy.allowManual) throw new BadRequestException("This company does not accept manually supplied employee numbers");
      if (number.length > 40) throw new BadRequestException("Employee number can be at most 40 characters");
      if (!new RegExp(policy.manualPattern).test(number)) throw new BadRequestException(`Employee number "${number}" does not match the allowed pattern`);
      const parsed = parseEmployeeNumberSequence(number, format);
      if (parsed !== null && seriesKey === "" && parsed >= current) await setCounter(parsed + 1);
      return number;
    }

    // generate: skip anything already known to the ledger or the employees table
    let seq = current;
    let candidate = formatEmployeeNumber(format, seq, seriesKey || undefined);
    for (let i = 0; i < 5000; i++) {
      const taken = await client.query(
        `SELECT 1 FROM employee_numbers WHERE company_id = $1 AND employee_number = $2
         UNION ALL SELECT 1 FROM employees WHERE company_id = $1 AND employee_number = $2 LIMIT 1`,
        [companyId, candidate]
      );
      if ((taken.rowCount ?? 0) === 0) break;
      seq += 1;
      candidate = formatEmployeeNumber(format, seq, seriesKey || undefined);
    }
    await setCounter(seq + 1);
    const actor = UUID_RE.test(claims.sub ?? "") ? claims.sub : null;
    await client.query(
      `INSERT INTO employee_numbers (company_id, employee_number, state, series_key, sequence_no, source, hire_process_id, reserved_at, created_by_user_account_id)
       VALUES ($1, $2, 'reserved', $3, $4, $5, $6, now(), $7)`,
      [companyId, candidate, seriesKey, seq, opts.source ?? "generated", opts.hireProcessId ?? null, actor]
    );
    await this.audit.record(client, claims, {
      companyId,
      action: "employee_number.reserved",
      target: candidate,
      metadata: { hireProcessId: opts.hireProcessId ?? null, series: seriesKey || null },
    });
    return candidate;
  }

  /** Reserve a number for a hire process now (draft / save / approval timing). Idempotent per process. */
  async reserveForHireProcess(client: PoolClient, claims: RequestClaims, processRow: { id: string; company_id: string; reserved_employee_number?: string | null }): Promise<string> {
    if (processRow.reserved_employee_number) return processRow.reserved_employee_number;
    const number = await this.allocate(client, claims, processRow.company_id, { hireProcessId: processRow.id });
    await client.query("UPDATE hire_processes SET reserved_employee_number = $2 WHERE id = $1", [processRow.id, number]);
    return number;
  }

  /** A cancelled / expired hire gives its reservation back - as void, never for reuse. */
  async voidForHireProcess(client: PoolClient, claims: RequestClaims, hireProcessId: string, reason: string): Promise<number> {
    const r = await client.query(
      `UPDATE employee_numbers SET state = 'void', voided_at = now(), void_reason = $2
        WHERE hire_process_id = $1 AND state = 'reserved' RETURNING company_id, employee_number`,
      [hireProcessId, reason]
    );
    for (const row of r.rows) {
      await this.audit.record(client, claims, { companyId: row.company_id, action: "employee_number.voided", target: row.employee_number, reason, metadata: { hireProcessId } });
    }
    return r.rowCount ?? 0;
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage employee numbering");
  }
}
