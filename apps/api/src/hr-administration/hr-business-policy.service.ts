import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { BUSINESS_POLICY_REGISTRY, getPolicyTypeDefinition, isRegisteredPolicyType } from "./business-policy-registry";
import { DEFAULT_BUSINESS_POLICY_SEED } from "./default-business-policy-seed";
import { ConfigurationRuleMappingService } from "./configuration-rule-mapping.service";
import type {
  CreateHrBusinessPolicyRequest,
  HrBusinessPolicyTypeSummary,
  HrBusinessPolicyView,
  UpdateHrBusinessPolicyRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "hr_business_policy.manage.all";
const VIEW_PERMISSION = "hr_business_policy.view.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): HrBusinessPolicyView {
  return {
    id: row.id,
    companyId: row.company_id,
    policyType: row.policy_type,
    code: row.code,
    name: row.name,
    description: row.description,
    rules: row.rules ?? {},
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * HR Administration business-policy engine (Core Employee Configuration/
 * HR-Admin v2 "then 2" Phase 2, 2026-10-02, gap-table item #8). One
 * generic service driving every registered `business-policy-registry.ts`
 * entry, the same "one engine, not N bespoke services" shape
 * `HrReferenceCatalogService` already proved out for Phase 1's 13
 * catalog types — see this module's migration (`0107_hr_business_policies.sql`)
 * for why a policy's shape (named, rules-carrying, exactly-one-default-
 * per-type) needs its own table rather than reusing `hr_reference_catalog_items`.
 *
 * `resolveDefaultPolicy()` is the enforcement/consumption primitive other
 * services call — deliberately returns the default policy's `rules`
 * object (or `null` if none), not a `BadRequestException`, because an
 * absent policy for a given type is a normal, valid state (the type is
 * registered but this tenant simply has no policy of it set as default
 * yet) rather than a caller error — unlike
 * `HrReferenceCatalogService.validateActiveCode()`, which DOES throw,
 * because there the catalog code came directly off a value a user typed
 * or picked, and an unknown one really is invalid input.
 */
@Injectable()
export class HrBusinessPolicyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    // "then 2" Phases 4+5 (2026-10-02) — the consolidated Configuration
    // Hierarchy & Resolution / Mapping engine (gap-table items #11+#12).
    // Default-instantiated and appended LAST, the same convention
    // `EmployeesService`'s own `occupancy`/`persons`/`importExport`
    // params already use: every existing spec file and call site that
    // hand-constructs `HrBusinessPolicyService` with exactly 4 positional
    // args (this file's own spec, `employees.service.spec.ts`) keeps
    // working completely unchanged, while `resolveEffectivePolicy()`
    // below always has a real `ConfigurationRuleMappingService` to call.
    private readonly configRuleMapping: ConfigurationRuleMappingService = new ConfigurationRuleMappingService(db, rbac, entitlements, audit)
  ) {}

  /** Same lazy-seed-on-first-read shape `HrReferenceCatalogService.ensureDefaultCatalogItems()`
   * already established, for the same reason: a company created AFTER
   * 0107 ran (a new signup, a Platform-Admin-created company) would
   * otherwise start with zero policies at all, meaning `resolveDefaultPolicy()`
   * would return null for every type and every would-be-wired consumer
   * silently no-ops instead of applying the product's own stated defaults. */
  private async ensureDefaultPolicies(client: PoolClient, companyId: string): Promise<void> {
    const existing = await client.query("SELECT 1 FROM hr_business_policies WHERE company_id = $1 LIMIT 1", [companyId]);
    if ((existing.rowCount ?? 0) > 0) return;
    for (const policy of DEFAULT_BUSINESS_POLICY_SEED) {
      await client.query(
        `INSERT INTO hr_business_policies (company_id, policy_type, code, name, description, rules, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, true, 0)
         ON CONFLICT (company_id, policy_type, code) DO NOTHING`,
        [companyId, policy.policyType, policy.code, policy.name, policy.description, JSON.stringify(policy.rules)]
      );
    }
  }

  /** The HR Administration "Business Policies" landing list — the full
   * registry plus each type's policy count and whether a default exists
   * for this company, mirroring `listCatalogTypes()`'s own shape. */
  async listPolicyTypes(claims: RequestClaims): Promise<HrBusinessPolicyTypeSummary[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultPolicies(client, claims.company_id!);
      // Explicit `company_id` filter on an indexed column, the same
      // RLS-planner-safety discipline Phase 1's own
      // `listCatalogTypes()`/`listItems()` fix applies — see that
      // method's doc comment for the full RLS/Postgres-planner
      // reasoning this mirrors.
      const counts = await client.query(
        `SELECT policy_type, count(*)::int AS policy_count, bool_or(is_default AND is_active) AS has_default
         FROM hr_business_policies WHERE company_id = $1 GROUP BY policy_type`,
        [claims.company_id]
      );
      const byType = new Map<string, { policyCount: number; hasDefault: boolean }>(
        counts.rows.map((r) => [r.policy_type, { policyCount: r.policy_count, hasDefault: r.has_default }])
      );
      return BUSINESS_POLICY_REGISTRY.map((entry) => ({
        policyType: entry.policyType,
        label: entry.label,
        description: entry.description,
        rulesShape: entry.rulesShape,
        wiredInto: entry.wiredInto,
        policyCount: byType.get(entry.policyType)?.policyCount ?? 0,
        hasDefault: byType.get(entry.policyType)?.hasDefault ?? false,
      }));
    });
  }

  async listPolicies(claims: RequestClaims, policyType: string, includeInactive = false): Promise<HrBusinessPolicyView[]> {
    this.assertRegistered(policyType);
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultPolicies(client, claims.company_id!);
      const result = await client.query(
        includeInactive
          ? "SELECT * FROM hr_business_policies WHERE policy_type = $1 AND company_id = $2 ORDER BY sort_order, name"
          : "SELECT * FROM hr_business_policies WHERE policy_type = $1 AND company_id = $2 AND is_active = true ORDER BY sort_order, name",
        [policyType, claims.company_id]
      );
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateHrBusinessPolicyRequest): Promise<HrBusinessPolicyView> {
    this.assertRegistered(input.policyType);
    if (!input.code?.trim()) throw new BadRequestException("code is required");
    if (!input.name?.trim()) throw new BadRequestException("name is required");
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultPolicies(client, claims.company_id!);
      const existing = await client.query(
        "SELECT 1 FROM hr_business_policies WHERE company_id = $1 AND policy_type = $2 AND code = $3",
        [claims.company_id, input.policyType, input.code.trim()]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException(`A "${input.policyType}" policy with code "${input.code}" already exists`);
      }
      if (input.isDefault) {
        await this.unsetExistingDefault(client, claims.company_id!, input.policyType);
      }
      const maxOrder = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM hr_business_policies WHERE company_id = $1 AND policy_type = $2",
        [claims.company_id, input.policyType]
      );
      const inserted = await client.query(
        `INSERT INTO hr_business_policies (company_id, policy_type, code, name, description, rules, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [
          claims.company_id,
          input.policyType,
          input.code.trim(),
          input.name.trim(),
          input.description ?? null,
          JSON.stringify(input.rules ?? {}),
          input.isDefault ?? false,
          maxOrder.rows[0].next,
        ]
      );
      const view = rowToView(inserted.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "hr_business_policy.create",
        target: view.id,
        metadata: { policyType: input.policyType, code: input.code },
      });
      return view;
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateHrBusinessPolicyRequest): Promise<HrBusinessPolicyView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (patch.isDefault === true) {
        await this.unsetExistingDefault(client, before.company_id, before.policy_type, id);
      }
      const result = await client.query(
        `UPDATE hr_business_policies SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           rules = COALESCE($4::jsonb, rules),
           is_default = COALESCE($5, is_default),
           is_active = COALESCE($6, is_active),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.name ?? null,
          patch.description ?? null,
          patch.rules !== undefined ? JSON.stringify(patch.rules) : null,
          patch.isDefault ?? null,
          patch.isActive ?? null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "hr_business_policy.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  async reorder(claims: RequestClaims, policyType: string, orderedIds: string[]): Promise<HrBusinessPolicyView[]> {
    this.assertRegistered(policyType);
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultPolicies(client, claims.company_id!);
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          "UPDATE hr_business_policies SET sort_order = $2, updated_at = now() WHERE id = $1 AND policy_type = $3 AND company_id = $4",
          [orderedIds[i], i, policyType, claims.company_id]
        );
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "hr_business_policy.reorder",
        target: policyType,
        metadata: { orderedIds },
      });
      const result = await client.query(
        "SELECT * FROM hr_business_policies WHERE id = ANY($1::uuid[]) AND policy_type = $2 AND company_id = $3 ORDER BY sort_order, name",
        [orderedIds, policyType, claims.company_id]
      );
      return result.rows.map(rowToView);
    });
  }

  /**
   * The enforcement/consumption half — called by EmployeesService for
   * `probation` (auto-computed probation_end) and `rehire` (cooldown
   * check), with every other registered type ready for a future
   * consumer the same way. Returns the default ACTIVE policy's `rules`
   * object for this company/type, or `null` if this tenant has none set
   * — a normal, valid state the caller is expected to handle (no-op),
   * not an error. Runs on the caller's own already-open transaction, the
   * same "never open a second connection" discipline
   * `HrReferenceCatalogService.validateActiveCode()` already follows.
   */
  async resolveDefaultPolicy(client: PoolClient, companyId: string, policyType: string): Promise<Record<string, unknown> | null> {
    await this.ensureDefaultPolicies(client, companyId);
    const result = await client.query(
      "SELECT rules FROM hr_business_policies WHERE company_id = $1 AND policy_type = $2 AND is_default = true AND is_active = true LIMIT 1",
      [companyId, policyType]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0].rules ?? {};
  }

  /**
   * "then 2" Phases 4+5 (2026-10-02) — the real consumer-facing primitive
   * `resolveDefaultPolicy()` was always meant to grow into once a scoped
   * override engine existed: starts from this company's plain
   * company-wide default `rules` (exactly `resolveDefaultPolicy()`'s own
   * result — still returned UNCHANGED, never thrown, when nothing is
   * registered as default for this type, the same "absent is normal"
   * contract), then layers the single most specific ACTIVE
   * `configuration_rule_mappings` override on top via
   * `ConfigurationRuleMappingService.resolveOverride()` (registered under
   * `configDomain: "hr_business_policy"`, `configKey: policyType`),
   * shallow-merging the override's own `ruleValue` keys over the
   * default's — so a tenant can, say, override just `cooldownDays` for
   * one location without needing to redefine every other key the
   * default-policy `rules` object carries. Returns `null` only when
   * BOTH the default and the override are absent, matching
   * `resolveDefaultPolicy()`'s own "no error, just nothing configured"
   * shape. Existing callers that still call `resolveDefaultPolicy()`
   * directly (none remain inside this codebase after this phase, but any
   * future one) are unaffected — this is a new method, not a
   * behavior change to the old one.
   */
  async resolveEffectivePolicy(
    client: PoolClient,
    companyId: string,
    policyType: string,
    context: { employeeId?: string | null; locationId?: string | null; orgUnitId?: string | null } = {}
  ): Promise<Record<string, unknown> | null> {
    const defaultRules = await this.resolveDefaultPolicy(client, companyId, policyType);
    const override = await this.configRuleMapping.resolveOverride(client, companyId, "hr_business_policy", policyType, context);
    if (!override) return defaultRules;
    return { ...(defaultRules ?? {}), ...override.ruleValue };
  }

  private async unsetExistingDefault(client: PoolClient, companyId: string, policyType: string, exceptId?: string): Promise<void> {
    await client.query(
      exceptId
        ? "UPDATE hr_business_policies SET is_default = false, updated_at = now() WHERE company_id = $1 AND policy_type = $2 AND is_default = true AND id <> $3"
        : "UPDATE hr_business_policies SET is_default = false, updated_at = now() WHERE company_id = $1 AND policy_type = $2 AND is_default = true",
      exceptId ? [companyId, policyType, exceptId] : [companyId, policyType]
    );
  }

  private assertRegistered(policyType: string): void {
    if (!isRegisteredPolicyType(policyType)) {
      throw new BadRequestException(`Unknown HR Administration policy type: ${policyType}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM hr_business_policies WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Business policy not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage HR Administration business policies");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view HR Administration business policies");
    }
  }
}

// Re-exported so EmployeesService and other future consumers can reach
// the registry's own definition helper without importing from two files.
export { getPolicyTypeDefinition };
