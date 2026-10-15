import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient, QueryResult } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  ConfigurationProvenanceEntry,
  ConfigurationResolutionContext,
  ConfigurationRuleMappingScopeType,
  ConfigurationRuleMappingView,
  CreateConfigurationRuleMappingRequest,
  ResolvedConfiguration,
  ResolvedConfigurationOverride,
  UpdateConfigurationRuleMappingRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "configuration_rule_mapping.manage.all";
const VIEW_PERMISSION = "configuration_rule_mapping.view.all";

const SCOPE_TYPES = ["org_unit", "location", "employee", "tenant", "employee_group", "position", "job"] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Resolution order (CFG-04/05), most specific first. When several overrides
 * match a subject the one with the lowest rank wins; among overrides of the
 * SAME rank the lower `priority` number wins, then the older row. An
 * org_unit override on the subject's own unit beats one on a parent unit
 * (nearest ancestor first). Legal entity stays DEFERRED (ORG-15).
 *
 *   employee > position > job > employee_group > location > org_unit > tenant
 *
 * (Platform/country-pack defaults sit below `tenant` and are supplied by the
 * caller as `baseValue`; they are not rows in this table.)
 */
const SCOPE_PRIORITY: Record<ScopeType, number> = {
  employee: 0,
  position: 1,
  job: 2,
  employee_group: 3,
  location: 4,
  org_unit: 5,
  tenant: 6,
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDay(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString ? value.toISOString().slice(0, 10) : null;
}

function assertWindow(from?: string | null, to?: string | null): void {
  if ((from && !ISO_DAY.test(from)) || (to && !ISO_DAY.test(to))) throw new BadRequestException("Dates must be YYYY-MM-DD");
  if (from && to && to < from) throw new BadRequestException("effectiveTo cannot be before effectiveFrom");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): ConfigurationRuleMappingView {
  return {
    id: row.id,
    companyId: row.company_id,
    configDomain: row.config_domain,
    configKey: row.config_key,
    scopeType: row.scope_type,
    scopeValue: row.scope_value,
    ruleValue: row.rule_value ?? {},
    priority: row.priority,
    isActive: row.is_active,
    scopeId: row.scope_id ?? null,
    objectType: row.object_type ?? null,
    objectId: row.object_id ?? null,
    fieldKey: row.field_key ?? null,
    ruleType: row.rule_type ?? null,
    ruleReference: row.rule_reference ?? null,
    effectiveFrom: toDay(row.effective_from),
    effectiveTo: toDay(row.effective_to),
    configurationVersion: row.configuration_version ?? null,
    status: row.status,
    changeReason: row.change_reason ?? null,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * The Configuration Hierarchy & Resolution / Mapping Engine (Core
 * Employee Configuration/HR-Admin v2 "then 2" Phases 4+5, 2026-10-02,
 * gap-table items #11+#12 — built as one engine; see
 * `0109_configuration_rule_mappings.sql`'s own header comment for the
 * full rationale and the deliberate scope-level bounding). Generic
 * across any `configDomain`/`configKey` pair — `HrBusinessPolicyService`
 * is this phase's only real consumer (`resolveEffectivePolicy()`,
 * layering an org-unit/location/employee override on top of its own
 * plain company-wide default), the same "one engine, registered per
 * consuming domain in application code" shape every other HR
 * Administration engine in this file already uses.
 *
 * `resolveOverride()` is the enforcement/consumption primitive. It reads
 * `org_units` directly for ancestor walking — a narrow, documented
 * exception to "never touch another domain's own table directly" the
 * same way `EmployeeLifecycleService`'s `manager_of_submitter` approver
 * type already queries `employees` directly; Organization Management
 * owns that table, this is a read-only SELECT, nothing here writes to it.
 */
@Injectable()
export class ConfigurationRuleMappingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, configDomain: string, configKey: string, includeInactive = false): Promise<ConfigurationRuleMappingView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        includeInactive
          ? "SELECT * FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 ORDER BY scope_type, scope_value"
          : "SELECT * FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND is_active = true ORDER BY scope_type, scope_value",
        [claims.company_id, configDomain, configKey]
      );
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateConfigurationRuleMappingRequest): Promise<ConfigurationRuleMappingView> {
    this.assertScopeType(input.scopeType);
    if (!input.configDomain?.trim() || !input.configKey?.trim() || !input.scopeValue?.trim()) {
      throw new BadRequestException("configDomain, configKey, and scopeValue are all required");
    }
    assertWindow(input.effectiveFrom, input.effectiveTo);
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistScope(client, claims.company_id!, input.scopeType, input.scopeValue);
      const existing = await client.query(
        "SELECT 1 FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND scope_type = $4 AND scope_value = $5",
        [claims.company_id, input.configDomain, input.configKey, input.scopeType, input.scopeValue]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException(`An override already exists for this ${input.scopeType} on "${input.configKey}"`);
      }
      const inserted = await client.query(
        `INSERT INTO configuration_rule_mappings
           (company_id, config_domain, config_key, scope_type, scope_value, rule_value, priority,
            object_type, object_id, field_key, rule_type, rule_reference, effective_from, effective_to, change_reason, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7, 100), $8, $9, $10, $11, $12, $13, $14, $15, $16, $16) RETURNING *`,
        [
          claims.company_id,
          input.configDomain,
          input.configKey,
          input.scopeType,
          input.scopeValue,
          JSON.stringify(input.ruleValue ?? {}),
          input.priority ?? null,
          input.objectType ?? null,
          input.objectId ?? null,
          input.fieldKey ?? null,
          input.ruleType ?? null,
          input.ruleReference ?? null,
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          input.changeReason ?? null,
          UUID_RE.test(String(claims.sub)) ? claims.sub : null,
        ]
      );
      const view = rowToView(inserted.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_rule_mapping.create",
        target: view.id,
        reason: input.changeReason,
        metadata: { configDomain: input.configDomain, configKey: input.configKey, scopeType: input.scopeType, scopeValue: input.scopeValue },
      });
      return view;
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateConfigurationRuleMappingRequest): Promise<ConfigurationRuleMappingView> {
    assertWindow(patch.effectiveFrom, patch.effectiveTo);
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const fromGiven = patch.effectiveFrom !== undefined;
      const toGiven = patch.effectiveTo !== undefined;
      assertWindow(fromGiven ? patch.effectiveFrom : toDay(before.effective_from), toGiven ? patch.effectiveTo : toDay(before.effective_to));
      const result = await client.query(
        `UPDATE configuration_rule_mappings SET
           rule_value = COALESCE($2::jsonb, rule_value),
           priority = COALESCE($3, priority),
           is_active = COALESCE($4, is_active),
           effective_from = CASE WHEN $5::boolean THEN $6::date ELSE effective_from END,
           effective_to = CASE WHEN $7::boolean THEN $8::date ELSE effective_to END,
           change_reason = COALESCE($9, change_reason),
           updated_by = COALESCE($10::uuid, updated_by),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.ruleValue !== undefined ? JSON.stringify(patch.ruleValue) : null,
          patch.priority ?? null,
          patch.isActive ?? null,
          fromGiven,
          patch.effectiveFrom ?? null,
          toGiven,
          patch.effectiveTo ?? null,
          patch.changeReason ?? null,
          UUID_RE.test(String(claims.sub)) ? claims.sub : null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_rule_mapping.update",
        target: id,
        reason: patch.changeReason,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  /**
   * The resolution half other services call (unchanged contract): the single
   * most specific ACTIVE override in force today for this subject, or `null`
   * ("fall back to the plain company-wide default" -- never an error).
   * Implemented on top of `resolveWithProvenance()`.
   */
  async resolveOverride(
    client: PoolClient,
    companyId: string,
    configDomain: string,
    configKey: string,
    context: ConfigurationResolutionContext
  ): Promise<ResolvedConfigurationOverride | null> {
    const resolved = await this.resolveWithProvenance(client, companyId, configDomain, configKey, context);
    if (!resolved.winner) return null;
    return {
      scopeType: resolved.winner.layer as ConfigurationRuleMappingScopeType,
      scopeValue: resolved.winner.scopeValue ?? "",
      ruleValue: resolved.winner.ruleValue,
    };
  }

  /**
   * CFG-05: one resolver that returns the value AND where it came from.
   * `chain` lists every layer that matched, most specific first, marking all
   * but the winner `shadowed`, and ends with the `default` layer (the
   * caller's `baseValue`). Only rows that are active, inside their effective
   * window on `asOf`, are considered. Facts omitted from `context` are
   * derived from `employeeId` (position, job, group memberships).
   *
   * Not cached: a resolution is a handful of indexed reads. If profiling
   * ever says otherwise, key a cache on (company, domain, key, subject, asOf)
   * and invalidate on this table's `updated_at` -- see the Step 3 report.
   */
  async resolveWithProvenance(
    client: PoolClient,
    companyId: string,
    configDomain: string,
    configKey: string,
    context: ConfigurationResolutionContext,
    baseValue: Record<string, unknown> = {}
  ): Promise<ResolvedConfiguration> {
    const asOf = context.asOf ?? new Date().toISOString().slice(0, 10);
    if (!ISO_DAY.test(asOf)) throw new BadRequestException("asOf must be YYYY-MM-DD");
    const ctx = await this.completeContext(client, companyId, context, asOf);

    const rows = await client.query(
      `SELECT id, scope_type, scope_value, scope_id, rule_value, priority, effective_from, effective_to, created_at
         FROM configuration_rule_mappings
        WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND is_active = true AND status = 'active'
          AND (effective_from IS NULL OR effective_from <= $4::date)
          AND (effective_to IS NULL OR effective_to >= $4::date)`,
      [companyId, configDomain, configKey, asOf]
    );

    // org_unit ancestors, nearest first (hop 0 = the subject's own unit)
    const unitHop = new Map<string, number>();
    if (ctx.orgUnitId) {
      const chain = await client.query<{ id: string; depth: number }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id, 0 AS depth FROM org_units WHERE id = $1 AND company_id = $2
           UNION ALL
           SELECT o.id, o.parent_id, up.depth + 1 FROM org_units o JOIN up ON o.id = up.parent_id
            WHERE o.company_id = $2 AND up.depth < 20
         ) SELECT id, depth FROM up`,
        [ctx.orgUnitId, companyId]
      );
      for (const r of chain.rows) unitHop.set(r.id, r.depth);
    }
    const groupIds = new Set(ctx.employeeGroupIds ?? []);

    type Candidate = { entry: ConfigurationProvenanceEntry; rank: number; hop: number; createdAt: number; id: string };
    const candidates: Candidate[] = [];
    for (const row of rows.rows) {
      const type = row.scope_type as ScopeType;
      const value = String(row.scope_id ?? row.scope_value);
      let hop = 0;
      let match = false;
      switch (type) {
        case "tenant":
          match = value === companyId;
          break;
        case "employee":
          match = !!ctx.employeeId && value === ctx.employeeId;
          break;
        case "position":
          match = !!ctx.positionId && value === ctx.positionId;
          break;
        case "job":
          match = !!ctx.jobId && value === ctx.jobId;
          break;
        case "employee_group":
          match = groupIds.has(value);
          break;
        case "location":
          match = !!ctx.locationId && value === ctx.locationId;
          break;
        case "org_unit":
          match = unitHop.has(value);
          hop = unitHop.get(value) ?? 0;
          break;
      }
      if (!match) continue;
      candidates.push({
        rank: SCOPE_PRIORITY[type],
        hop,
        createdAt: row.created_at instanceof Date ? row.created_at.getTime() : 0,
        id: row.id,
        entry: {
          layer: type,
          scopeValue: row.scope_value,
          ruleId: row.id,
          ruleValue: row.rule_value ?? {},
          priority: row.priority,
          effectiveFrom: toDay(row.effective_from),
          effectiveTo: toDay(row.effective_to),
          shadowed: true,
        },
      });
    }
    candidates.sort((a, b) => a.rank - b.rank || a.hop - b.hop || (a.entry.priority ?? 100) - (b.entry.priority ?? 100) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    const chain = candidates.map((c) => c.entry);
    if (chain.length > 0) chain[0].shadowed = false;
    chain.push({ layer: "default", scopeValue: null, ruleId: null, ruleValue: baseValue, priority: null, effectiveFrom: null, effectiveTo: null, shadowed: chain.length > 0 });
    const winner = candidates.length > 0 ? chain[0] : null;
    return { value: winner ? { ...baseValue, ...winner.ruleValue } : { ...baseValue }, winner, chain, asOf };
  }

  /** Fills position / job / group memberships from the employee when the caller did not supply them. */
  private async completeContext(
    client: PoolClient,
    companyId: string,
    context: ConfigurationResolutionContext,
    asOf: string
  ): Promise<ConfigurationResolutionContext> {
    const out = { ...context };
    if (!out.employeeId || !UUID_RE.test(out.employeeId)) return out; // nothing to derive from a non-id
    if (out.positionId === undefined || out.jobId === undefined || out.orgUnitId === undefined || out.locationId === undefined) {
      const e = await client.query(
        `SELECT e.org_unit_id, e.location_id, e.position_id, (SELECT p.job_id FROM positions p WHERE p.id = e.position_id) AS job_id
           FROM employees e WHERE e.id = $1 AND e.company_id = $2`,
        [out.employeeId, companyId]
      );
      if (e.rowCount) {
        const r = e.rows[0];
        if (out.positionId === undefined) out.positionId = r.position_id;
        if (out.jobId === undefined) out.jobId = r.job_id;
        if (out.orgUnitId === undefined) out.orgUnitId = r.org_unit_id;
        if (out.locationId === undefined) out.locationId = r.location_id;
      }
    }
    if (out.employeeGroupIds === undefined) {
      const g = await client.query(
        `SELECT group_id FROM employee_group_memberships
          WHERE employee_id = $1 AND company_id = $2 AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)`,
        [out.employeeId, companyId, asOf]
      );
      out.employeeGroupIds = g.rows.map((r) => r.group_id as string);
    }
    return out;
  }

  private assertScopeType(scopeType: string): void {
    if (!SCOPE_TYPES.includes(scopeType as ScopeType)) {
      throw new BadRequestException(`scopeType must be one of: ${SCOPE_TYPES.join(", ")}`);
    }
  }

  private async mustExistScope(client: PoolClient, companyId: string, scopeType: ScopeType, scopeValue: string): Promise<void> {
    if (scopeType === "tenant") {
      if (scopeValue !== companyId) throw new BadRequestException("A tenant-wide override must use your own company id as its scope value");
      return;
    }
    const table: Record<string, string> = {
      org_unit: "org_units",
      location: "locations",
      employee: "employees",
      position: "positions",
      job: "jobs",
      employee_group: "employee_groups",
    };
    if (!UUID_RE.test(scopeValue)) throw new BadRequestException(`scopeValue must be the id of a ${scopeType}`);
    const result = await client.query(`SELECT 1 FROM ${table[scopeType]} WHERE id = $1 AND company_id = $2`, [scopeValue, companyId]);
    if (result.rowCount === 0) throw new BadRequestException(`That ${scopeType.replace("_", " ")} doesn't exist for this company`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM configuration_rule_mappings WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Configuration override not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage configuration overrides");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view configuration overrides");
    }
  }
}

export { SCOPE_PRIORITY };
