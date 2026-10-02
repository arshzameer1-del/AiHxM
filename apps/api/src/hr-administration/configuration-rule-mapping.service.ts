import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient, QueryResult } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  ConfigurationRuleMappingView,
  CreateConfigurationRuleMappingRequest,
  ResolvedConfigurationOverride,
  UpdateConfigurationRuleMappingRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "configuration_rule_mapping.manage.all";
const VIEW_PERMISSION = "configuration_rule_mapping.view.all";

const SCOPE_TYPES = ["org_unit", "location", "employee"] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];

// Fixed specificity order — lower index wins. "org_unit" itself resolves
// its OWN nearest-ancestor-first order inside resolveOverride() below;
// this outer order is what decides employee > location > org_unit when
// more than one scope type has a matching row at once.
const SCOPE_PRIORITY: Record<ScopeType, number> = { employee: 0, location: 1, org_unit: 2 };

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
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      if (input.scopeType === "org_unit") await this.mustExistOrgUnit(client, claims.company_id!, input.scopeValue);
      const existing = await client.query(
        "SELECT 1 FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND scope_type = $4 AND scope_value = $5",
        [claims.company_id, input.configDomain, input.configKey, input.scopeType, input.scopeValue]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException(`An override already exists for this ${input.scopeType} on "${input.configKey}"`);
      }
      const inserted = await client.query(
        `INSERT INTO configuration_rule_mappings (company_id, config_domain, config_key, scope_type, scope_value, rule_value, priority)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [
          claims.company_id,
          input.configDomain,
          input.configKey,
          input.scopeType,
          input.scopeValue,
          JSON.stringify(input.ruleValue ?? {}),
          input.priority ?? null,
        ]
      );
      const view = rowToView(inserted.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_rule_mapping.create",
        target: view.id,
        metadata: { configDomain: input.configDomain, configKey: input.configKey, scopeType: input.scopeType, scopeValue: input.scopeValue },
      });
      return view;
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateConfigurationRuleMappingRequest): Promise<ConfigurationRuleMappingView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE configuration_rule_mappings SET
           rule_value = COALESCE($2::jsonb, rule_value),
           priority = CASE WHEN $3 THEN $4 ELSE priority END,
           is_active = COALESCE($5, is_active),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.ruleValue !== undefined ? JSON.stringify(patch.ruleValue) : null,
          Object.prototype.hasOwnProperty.call(patch, "priority"),
          patch.priority ?? null,
          patch.isActive ?? null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_rule_mapping.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  /**
   * The resolution half other services call: given this company and a
   * {configDomain, configKey}, and the calling employee's own org unit/
   * location, finds the single most specific ACTIVE override —
   * `employee` (exact id match) beats `location` beats `org_unit`
   * (nearest ancestor first, walking `org_units.parent_id` from the
   * employee's own unit upward) — or `null` if none applies, which the
   * caller treats as "fall back to the plain company-wide default,"
   * never as an error (an absent override is the normal case).
   *
   * An explicit `priority` on a row (lower number wins) overrides this
   * method's own default scope-type ranking ONLY among rows that would
   * otherwise tie (two different `org_unit` ancestors never tie — the
   * walk stops at the first match — so `priority` only ever matters if
   * a future scope type is added that can coexist at the same
   * specificity; kept now so existing rows never need a migration once
   * one is).
   */
  async resolveOverride(
    client: PoolClient,
    companyId: string,
    configDomain: string,
    configKey: string,
    context: { employeeId?: string | null; locationId?: string | null; orgUnitId?: string | null }
  ): Promise<ResolvedConfigurationOverride | null> {
    if (context.employeeId) {
      const row = await this.findOne(client, companyId, configDomain, configKey, "employee", context.employeeId);
      if (row) return row;
    }
    if (context.locationId) {
      const row = await this.findOne(client, companyId, configDomain, configKey, "location", context.locationId);
      if (row) return row;
    }
    if (context.orgUnitId) {
      let unitId: string | null = context.orgUnitId;
      // Walk up at most 20 levels — generous for any real org chart, and
      // a hard stop against an (otherwise prevented, see org_units'
      // own CHECK/application-layer guards) cyclic parent chain.
      for (let hop = 0; hop < 20 && unitId; hop++) {
        const row = await this.findOne(client, companyId, configDomain, configKey, "org_unit", unitId);
        if (row) return row;
        const parentId: string | null = unitId;
        const parentRow: QueryResult<{ parent_id: string | null }> = await client.query<{ parent_id: string | null }>(
          "SELECT parent_id FROM org_units WHERE id = $1 AND company_id = $2",
          [parentId, companyId]
        );
        unitId = parentRow.rowCount ? parentRow.rows[0].parent_id : null;
      }
    }
    return null;
  }

  private async findOne(
    client: PoolClient,
    companyId: string,
    configDomain: string,
    configKey: string,
    scopeType: ScopeType,
    scopeValue: string
  ): Promise<ResolvedConfigurationOverride | null> {
    const result = await client.query(
      `SELECT scope_type, scope_value, rule_value FROM configuration_rule_mappings
       WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND scope_type = $4 AND scope_value = $5 AND is_active = true`,
      [companyId, configDomain, configKey, scopeType, scopeValue]
    );
    if (result.rowCount === 0) return null;
    return { scopeType: result.rows[0].scope_type, scopeValue: result.rows[0].scope_value, ruleValue: result.rows[0].rule_value ?? {} };
  }

  private assertScopeType(scopeType: string): void {
    if (!SCOPE_TYPES.includes(scopeType as ScopeType)) {
      throw new BadRequestException(`scopeType must be one of: ${SCOPE_TYPES.join(", ")}`);
    }
  }

  private async mustExistOrgUnit(client: PoolClient, companyId: string, orgUnitId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [orgUnitId, companyId]);
    if (result.rowCount === 0) throw new BadRequestException("That org unit doesn't exist for this company");
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
