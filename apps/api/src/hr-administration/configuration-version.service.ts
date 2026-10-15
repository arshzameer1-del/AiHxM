import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { ConfigurationVersionView, CreateConfigurationVersionRequest } from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "configuration_version.manage.all";
const VIEW_PERMISSION = "configuration_version.view.all";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): ConfigurationVersionView {
  const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  return {
    id: row.id,
    companyId: row.company_id,
    domain: row.domain,
    versionNo: row.version_no,
    status: row.status,
    snapshot: row.snapshot,
    effectiveFrom: day(row.effective_from),
    effectiveTo: day(row.effective_to),
    changeReason: row.change_reason ?? null,
    changeRequestId: row.change_request_id ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    publishedAt: row.published_at ? (row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at)) : null,
  };
}

/**
 * Gap Register CFG-02 -- immutable, numbered configuration versions.
 *
 * A version is a full snapshot of one configuration domain for one company.
 * Lifecycle: draft -> validated -> published -> retired (enforced again by the
 * database guard trigger, which also makes a published snapshot immutable).
 * Exactly one published version covers any given day (EXCLUDE constraint), so
 * `getEffective(domain, date)` answers "what was in force on that date".
 *
 * Publishing supersedes the previous published version: when the new version
 * starts after the old one began, the old one's window is closed the day
 * before; when it starts on or before it, the old one is retired.
 */
@Injectable()
export class ConfigurationVersionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------ snapshots

  /** The current state of a domain, as the plain JSON a version stores. Domains
   *  with no built-in capture must be given their snapshot by the caller. */
  async captureDomain(client: PoolClient, companyId: string, domain: string): Promise<Record<string, unknown> | null> {
    if (domain === "hr_reference_catalog_item") {
      const r = await client.query(
        `SELECT id, catalog_type, code, label, description, is_active, sort_order
           FROM hr_reference_catalog_items WHERE company_id = $1 ORDER BY catalog_type, sort_order, code`,
        [companyId]
      );
      return { items: r.rows };
    }
    if (domain === "hr_business_policy") {
      const r = await client.query(
        `SELECT id, policy_type, code, name, description, rules, is_default, is_active
           FROM hr_business_policies WHERE company_id = $1 ORDER BY policy_type, code`,
        [companyId]
      );
      return { policies: r.rows };
    }
    if (domain === "configuration_rule_mapping") {
      const r = await client.query(
        `SELECT id, config_domain, config_key, scope_type, scope_value, rule_value, priority, is_active, effective_from, effective_to
           FROM configuration_rule_mappings WHERE company_id = $1 ORDER BY config_domain, config_key, scope_type, scope_value`,
        [companyId]
      );
      return { mappings: r.rows };
    }
    return null;
  }

  private async assertRegistered(client: PoolClient, domain: string): Promise<void> {
    const r = await client.query("SELECT 1 FROM configuration_registry WHERE domain_key = $1", [domain]);
    if (r.rowCount === 0) throw new BadRequestException(`Unknown configuration domain "${domain}"`);
  }

  // ------------------------------------------------------------ recording

  /**
   * Called inside the publishing transaction of a change request: captures the
   * domain as it now stands and stores it as the next published version.
   */
  async recordPublished(
    client: PoolClient,
    companyId: string,
    domain: string,
    opts: { changeRequestId?: string | null; userId?: string | null; reason?: string | null; effectiveFrom?: string | null; snapshot?: Record<string, unknown> }
  ): Promise<ConfigurationVersionView> {
    await this.assertRegistered(client, domain);
    const snapshot = opts.snapshot ?? (await this.captureDomain(client, companyId, domain));
    if (!snapshot) throw new BadRequestException(`Domain "${domain}" has no built-in snapshot; supply one`);
    const version = await this.insertVersion(client, companyId, domain, snapshot, "published", opts);
    return version;
  }

  private async nextVersionNo(client: PoolClient, companyId: string, domain: string): Promise<number> {
    // Serialise per (company, domain) so concurrent publishes never collide on version_no.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`configuration_versions:${companyId}:${domain}`]);
    const r = await client.query<{ n: number }>(
      "SELECT COALESCE(max(version_no), 0) + 1 AS n FROM configuration_versions WHERE company_id = $1 AND domain = $2",
      [companyId, domain]
    );
    return Number(r.rows[0].n);
  }

  private async insertVersion(
    client: PoolClient,
    companyId: string,
    domain: string,
    snapshot: Record<string, unknown>,
    status: "draft" | "published",
    opts: { changeRequestId?: string | null; userId?: string | null; reason?: string | null; effectiveFrom?: string | null }
  ): Promise<ConfigurationVersionView> {
    const versionNo = await this.nextVersionNo(client, companyId, domain);
    const userId = opts.userId && UUID_RE.test(opts.userId) ? opts.userId : null;
    if (status === "published") {
      const from = opts.effectiveFrom ?? (await this.today(client));
      await this.supersede(client, companyId, domain, from);
      const r = await client.query(
        `INSERT INTO configuration_versions
           (company_id, domain, version_no, status, snapshot, effective_from, change_reason, change_request_id, created_by, published_by, published_at)
         VALUES ($1, $2, $3, 'published', $4::jsonb, $5::date, $6, $7, $8, $8, now()) RETURNING *`,
        [companyId, domain, versionNo, JSON.stringify(snapshot), from, opts.reason ?? null, opts.changeRequestId ?? null, userId]
      );
      return rowToView(r.rows[0]);
    }
    const r = await client.query(
      `INSERT INTO configuration_versions (company_id, domain, version_no, status, snapshot, change_reason, change_request_id, created_by)
       VALUES ($1, $2, $3, 'draft', $4::jsonb, $5, $6, $7) RETURNING *`,
      [companyId, domain, versionNo, JSON.stringify(snapshot), opts.reason ?? null, opts.changeRequestId ?? null, userId]
    );
    return rowToView(r.rows[0]);
  }

  private async today(client: PoolClient): Promise<string> {
    const r = await client.query<{ d: string }>("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d");
    return r.rows[0].d;
  }

  /** Close or retire published versions that the version starting at `from` replaces. */
  private async supersede(client: PoolClient, companyId: string, domain: string, from: string): Promise<void> {
    await client.query(
      `UPDATE configuration_versions SET status = 'retired'
        WHERE company_id = $1 AND domain = $2 AND status = 'published' AND effective_from >= $3::date`,
      [companyId, domain, from]
    );
    await client.query(
      `UPDATE configuration_versions SET effective_to = ($3::date - 1)
        WHERE company_id = $1 AND domain = $2 AND status = 'published'
          AND effective_from < $3::date AND (effective_to IS NULL OR effective_to >= $3::date)`,
      [companyId, domain, from]
    );
  }

  // ------------------------------------------------------------ manual lifecycle

  async createDraft(claims: RequestClaims, input: CreateConfigurationVersionRequest): Promise<ConfigurationVersionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.assertRegistered(client, input.domain);
      const snapshot = input.snapshot ?? (await this.captureDomain(client, claims.company_id!, input.domain));
      if (!snapshot) throw new BadRequestException(`Domain "${input.domain}" has no built-in snapshot; supply one`);
      const view = await this.insertVersion(client, claims.company_id!, input.domain, snapshot, "draft", {
        reason: input.changeReason ?? null,
        userId: String(claims.sub),
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_version.create",
        target: view.id,
        metadata: { domain: view.domain, versionNo: view.versionNo },
        reason: input.changeReason,
      });
      return view;
    });
  }

  async validate(claims: RequestClaims, id: string): Promise<ConfigurationVersionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "draft") throw new BadRequestException(`Only a draft version can be validated (this one is "${row.status}")`);
      if (!row.snapshot || typeof row.snapshot !== "object" || Array.isArray(row.snapshot) || Object.keys(row.snapshot).length === 0) {
        throw new BadRequestException("A version needs a non-empty snapshot object");
      }
      const r = await client.query("UPDATE configuration_versions SET status = 'validated' WHERE id = $1 RETURNING *", [id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_version.validate",
        target: id,
        metadata: { domain: row.domain, versionNo: row.version_no },
      });
      return rowToView(r.rows[0]);
    });
  }

  async publish(claims: RequestClaims, id: string, effectiveFrom?: string): Promise<ConfigurationVersionView> {
    if (effectiveFrom !== undefined && !DAY.test(effectiveFrom)) throw new BadRequestException("effectiveFrom must be YYYY-MM-DD");
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "validated") throw new BadRequestException(`Only a validated version can be published (this one is "${row.status}")`);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`configuration_versions:${row.company_id}:${row.domain}`]);
      const from = effectiveFrom ?? (await this.today(client));
      await this.supersede(client, row.company_id, row.domain, from);
      const userId = UUID_RE.test(String(claims.sub)) ? String(claims.sub) : null;
      const r = await client.query(
        `UPDATE configuration_versions SET status = 'published', effective_from = $2::date, effective_to = NULL, published_by = $3, published_at = now()
          WHERE id = $1 RETURNING *`,
        [id, from, userId]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_version.publish",
        target: id,
        metadata: { domain: row.domain, versionNo: row.version_no, effectiveFrom: from },
      });
      return rowToView(r.rows[0]);
    });
  }

  async retire(claims: RequestClaims, id: string, reason?: string): Promise<ConfigurationVersionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "published") throw new BadRequestException(`Only a published version can be retired (this one is "${row.status}")`);
      const r = await client.query("UPDATE configuration_versions SET status = 'retired' WHERE id = $1 RETURNING *", [id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_version.retire",
        target: id,
        metadata: { domain: row.domain, versionNo: row.version_no },
        reason,
      });
      return rowToView(r.rows[0]);
    });
  }

  // ------------------------------------------------------------ reads

  async list(claims: RequestClaims, domain?: string, status?: string): Promise<ConfigurationVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const conds = ["company_id = $1"];
      const params: unknown[] = [claims.company_id];
      if (domain) {
        params.push(domain);
        conds.push(`domain = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conds.push(`status = $${params.length}`);
      }
      const r = await client.query(
        `SELECT * FROM configuration_versions WHERE ${conds.join(" AND ")} ORDER BY domain, version_no DESC`,
        params
      );
      return r.rows.map(rowToView);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<ConfigurationVersionView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToView(await this.mustExist(client, id)));
  }

  /** The published version in force for `domain` on `asOf` (default: today), or null. */
  async getEffective(claims: RequestClaims, domain: string, asOf?: string): Promise<ConfigurationVersionView | null> {
    if (asOf !== undefined && !DAY.test(asOf)) throw new BadRequestException("asOf must be YYYY-MM-DD");
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM configuration_versions
          WHERE company_id = $1 AND domain = $2 AND status = 'published'
            AND effective_from <= COALESCE($3::date, CURRENT_DATE)
            AND (effective_to IS NULL OR effective_to >= COALESCE($3::date, CURRENT_DATE))
          ORDER BY version_no DESC LIMIT 1`,
        [claims.company_id, domain, asOf ?? null]
      );
      return r.rows[0] ? rowToView(r.rows[0]) : null;
    });
  }

  private async mustExist(client: PoolClient, id: string) {
    if (!UUID_RE.test(id)) throw new NotFoundException("Configuration version not found");
    const r = await client.query("SELECT * FROM configuration_versions WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Configuration version not found");
    return r.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage configuration versions");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [v, m] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!v && !m) throw new ForbiddenException("Not permitted to view configuration versions");
  }
}
