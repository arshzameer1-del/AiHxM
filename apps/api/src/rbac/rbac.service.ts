import { memoizeForRequest } from "../common/request-context";
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { DataScopeAssignmentScopeType, FieldAccess } from "@aihxm/shared-types";
import { maskValue } from "./field-masking";

type FieldCondition = { field: string; equals: unknown };

/** ACC-01: `masked` sits between hidden and view -- the caller gets the field, obscured. */
const ACCESS_RANK: Record<FieldAccess, number> = { hidden: 0, masked: 1, view: 2, edit: 3 };

/**
 * ACC-03: a role assignment counts only inside its effective window, so a
 * temporary or delegated grant stops working on its own. NULL bounds are open.
 */
const ASSIGNMENT_ACTIVE = `(ura.effective_from IS NULL OR ura.effective_from <= CURRENT_DATE)
           AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)`;
/** ACC-01: a field rule applies to this tenant (or all tenants) inside its window. */
const FIELD_RULE_ACTIVE = `(fpr.company_id IS NULL OR fpr.company_id = ura.company_id)
           AND (fpr.effective_from IS NULL OR fpr.effective_from <= CURRENT_DATE)
           AND (fpr.effective_to IS NULL OR fpr.effective_to >= CURRENT_DATE)`;

export type FieldRuleRow = {
  field_key: string;
  access: FieldAccess;
  condition: FieldCondition | null;
  mask_rule?: string | null;
  priority?: number;
  deny_overrides?: boolean;
};
export type FieldDecision = { access: FieldAccess; maskRule: string | null };

/**
 * Combine every applicable rule for ONE field into a decision.
 *   - grants are additive: the most permissive rule wins (hidden < masked < view < edit);
 *   - a `deny_overrides` rule is a ceiling: no other role's grant can lift the
 *     result above the lowest such ceiling;
 *   - among masked results the lowest `priority` number picks the mask rule.
 */
export function combineFieldRules(rules: ReadonlyArray<FieldRuleRow>): FieldDecision {
  let best: FieldAccess = "hidden";
  let ceiling: FieldAccess | null = null;
  let maskRule: string | null = null;
  let maskPriority = Number.POSITIVE_INFINITY;
  for (const r of rules) {
    if (ACCESS_RANK[r.access] > ACCESS_RANK[best]) best = r.access;
    if (r.deny_overrides && (ceiling === null || ACCESS_RANK[r.access] < ACCESS_RANK[ceiling])) ceiling = r.access;
    if (r.access === "masked" && (r.priority ?? 100) < maskPriority) {
      maskPriority = r.priority ?? 100;
      maskRule = r.mask_rule ?? null;
    }
  }
  if (ceiling !== null && ACCESS_RANK[ceiling] < ACCESS_RANK[best]) best = ceiling;
  return { access: best, maskRule: best === "masked" ? maskRule : null };
}

/**
 * Object/record-level and field-level permission engine (plan doc Section
 * 2's enforcement order, the two middle steps: "can the role touch this
 * object" and "which fields can they see"). Phase 5 adds the first step
 * (is the module even licensed) in front of this; nothing here assumes
 * that step exists yet.
 *
 * Deliberate design point, stated once here rather than at every call
 * site: there is NO Platform Admin bypass anywhere in this file. Section
 * 3 is explicit that a Platform Admin "never touches a tenant's HR data"
 * — access to a tenant object comes only from an actual role assignment
 * in that tenant. A Platform Admin session carries no `company_id` claim,
 * so `user_role_assignments.company_id = $2` can never match for one
 * (SQL's `= NULL` is never true) — the guardrail falls out of the claims
 * shape itself rather than needing an `if (claims.is_platform_admin)
 * return true` shortcut, which is exactly the shortcut a naive
 * implementation would reach for and get wrong.
 */
@Injectable()
export class RbacService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Object/record-level check. `permissionKey` encodes its own scope by
   * convention (`<object>.<action>.self` or `<object>.<action>.all`) —
   * `.self` additionally requires `target.ownerId` to match the caller's
   * own `sub`. A permission with neither suffix (none exist yet, but
   * nothing here assumes there won't be one) is treated as scope-less:
   * holding it is sufficient on its own.
   */
  async can(
    claims: RequestClaims,
    permissionKey: string,
    target?: { ownerId?: string | null; teamOwnerId?: string | null }
  ): Promise<boolean> {
    if (!claims.company_id) {
      // No tenant context at all (e.g. a Platform Admin session) — there
      // is nothing this engine could ever grant. See the class doc above.
      return false;
    }

    const granted = await this.hasPermission(claims, permissionKey);
    if (!granted) return false;

    if (permissionKey.endsWith(".self")) {
      return Boolean(target?.ownerId) && target?.ownerId === claims.sub;
    }
    if (permissionKey.endsWith(".team")) {
      // Phase 7 addition (Decision #7): "a Manager sees their team's
      // salary only if the tenant specifically grants salary.view.team"
      // (plan doc Section 2's own example). `teamOwnerId` is the record's
      // direct manager's OWN user_account_id, resolved by the caller
      // (EmployeesService) via a join — this method stays exactly as
      // generic as the `.self` branch above, with no knowledge of
      // employees/managers baked in. Direct reports only; a recursive
      // "your whole reporting chain" scope is a documented future
      // refinement, not built now.
      return Boolean(target?.teamOwnerId) && target?.teamOwnerId === claims.sub;
    }
    return true;
  }

  /**
   * Field-level check for a caller who has already cleared `can()` for
   * the record as a whole. Evaluates every field_permission_rules row
   * granted by any of the caller's roles for this object+field; a rule
   * with a `condition` only applies when it matches `record`. Default is
   * always `hidden` — a field nobody has an applicable rule for is never
   * silently visible.
   *
   * Multiple applicable roles/rules combine by taking the MOST permissive
   * result (hidden < view < edit) — permission grants are additive, never
   * subtractive, so holding a second role only ever broadens access.
   * "Most-specific-match-wins" (plan doc Section 2's phrase) is about
   * resolving two *conditional* rules on the *same* role that both match
   * the same record — not a case any of Phase 4's seeded demo roles
   * produce, so it's flagged here as a documented gap for whenever a real
   * module first needs it (Phase 6+ WRICEF Enhancements territory), not
   * silently assumed away.
   */
  async resolveFieldAccess(
    claims: RequestClaims,
    objectKey: string,
    fieldKey: string,
    record: Record<string, unknown>
  ): Promise<FieldAccess> {
    if (!claims.company_id) return "hidden";

    const rows = await this.db.withClaims(claims, async (client) => {
      const result = await client.query<Omit<FieldRuleRow, "field_key">>(
        `SELECT fpr.access, fpr.condition, fpr.mask_rule, fpr.priority, fpr.deny_overrides
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id AND r.is_active
         JOIN field_permission_rules fpr ON fpr.role_id = ura.role_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND ${ASSIGNMENT_ACTIVE}
           AND ${FIELD_RULE_ACTIVE}
           AND fpr.object_key = $3
           AND fpr.field_key = $4`,
        [claims.sub, claims.company_id, objectKey, fieldKey]
      );
      return result.rows;
    });

    return combineFieldRules(
      rows.filter((row) => !row.condition || conditionMatches(row.condition, record)).map((row) => ({ ...row, field_key: fieldKey }))
    ).access;
  }

  /**
   * The actual enforcement point a controller/service calls: given a raw
   * DB row, returns either the record with every `sensitiveFields` key
   * that resolves to `hidden` OMITTED ENTIRELY (never set to null — a
   * client inspecting the raw JSON sees no such key at all, which is what
   * this phase's exit criterion specifically asks for), or `null` if the
   * caller cannot see the record at all (neither `.self` nor `.all`
   * object-level access applies).
   *
   * `viewPermissionKey` is the object-level permission's base
   * (`"dummy_record.view"`) — both `.self` and `.all` variants are tried,
   * since a caller might hold either.
   */
  async filterRecordFields<T extends Record<string, unknown>>(
    claims: RequestClaims,
    objectKey: string,
    viewPermissionKey: string,
    record: T,
    sensitiveFields: readonly string[],
    ownerId: string | null
  ): Promise<Record<string, unknown> | null> {
    const [canSelf, canAll] = await Promise.all([
      this.can(claims, `${viewPermissionKey}.self`, { ownerId }),
      this.can(claims, `${viewPermissionKey}.all`),
    ]);
    if (!canSelf && !canAll) return null;

    const applicableFields = sensitiveFields.filter((key) => key in record);
    const decisions = await this.resolveFieldAccessBatch(claims, objectKey, applicableFields, record);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!sensitiveFields.includes(key)) {
        result[key] = value;
        continue;
      }
      const decision = decisions.get(key);
      if (decision?.access === "masked") {
        result[key] = maskValue(value, decision.maskRule);
      } else if (decision && decision.access !== "hidden") {
        result[key] = value;
      }
      // else: key intentionally left unset — see the doc comment above.
    }
    return result;
  }

  /**
   * Batched sibling of resolveFieldAccess(), used only by
   * filterRecordFields(): ONE query for every field_permission_rules row
   * that could apply to any of `fieldKeys` on this object, instead of one
   * round trip per field. This is the fix for the N+1 flagged in the
   * Phase 5 security/quality audit — DummyService.list() was issuing up
   * to `N records x M sensitive fields` separate queries, harmless at
   * Phase 5's tiny dummy_records volumes but a real scaling concern once
   * Phase 7 (Employee Core) introduces real row counts. resolveFieldAccess
   * itself is intentionally left untouched (still the public single-field
   * API, still tested standalone in rbac.service.spec.ts) — this is an
   * additive, low-risk change, not a rewrite of it.
   *
   * Note this still leaves one N+1 shape in place: DummyService.list()
   * calls filterRecordFields() once per row, so `can()`'s two permission
   * checks still run once per record even though the caller's granted
   * scope (self/all) doesn't actually vary per record. Collapsing that
   * would mean hoisting the can() checks out of the per-record loop and
   * changing filterRecordFields()'s signature/call sites — a larger,
   * riskier change than this audit's scope. Tracked in KNOWN_ISSUES.md as
   * a documented, deferred concern to revisit alongside Phase 7.
   */
  private async resolveFieldAccessBatch(
    claims: RequestClaims,
    objectKey: string,
    fieldKeys: readonly string[],
    record: Record<string, unknown>
  ): Promise<Map<string, FieldDecision>> {
    if (!claims.company_id || fieldKeys.length === 0) {
      return new Map(fieldKeys.map((key) => [key, { access: "hidden" as FieldAccess, maskRule: null }]));
    }
    const rows = await this.loadFieldPermissionRules(claims, objectKey, fieldKeys);
    return this.evaluateFieldDecisions(rows, fieldKeys, record);
  }

  /**
   * Resolves which object-level scopes a caller holds for a given
   * view-permission base, ONCE per request — the fix for the N+1 the
   * Phase 5 audit flagged and explicitly deferred to "whenever Phase 7
   * (Employee Core) is built" (KNOWN_ISSUES.md's "Record-level N+1 still
   * exists" entry). `filterRecordFields()` above re-checks `.self`/`.all`
   * via `can()` for every single row even though whether the caller HOLDS
   * a scope at all never varies per record — only the ownership match
   * does. Call this once per request, then pass its result into
   * `filterRecordFieldsWithScope()` below for every row: the per-row cost
   * drops to in-memory comparisons plus one batched field-rule fetch,
   * with zero further permission-holding queries.
   */
  async resolveViewScope(
    claims: RequestClaims,
    viewPermissionKey: string
  ): Promise<{ hasAll: boolean; hasSelf: boolean; hasTeam: boolean }> {
    if (!claims.company_id) return { hasAll: false, hasSelf: false, hasTeam: false };
    const [hasAll, hasSelf, hasTeam] = await Promise.all([
      this.hasPermission(claims, `${viewPermissionKey}.all`),
      this.hasPermission(claims, `${viewPermissionKey}.self`),
      this.hasPermission(claims, `${viewPermissionKey}.team`),
    ]);
    return { hasAll, hasSelf, hasTeam };
  }

  /**
   * Loads every field_permission_rules row that could apply to ANY of
   * `fieldKeys` for the caller's roles, ONCE per request — same idea as
   * `resolveViewScope()`, but for field-level rules instead of object-
   * level scope. The rows themselves don't depend on any one record (only
   * evaluating a row's `condition` does), so fetching them once and
   * evaluating conditions in memory per row (via `evaluateFieldAccess()`)
   * turns what would be N queries (one per visible row) into exactly one,
   * regardless of how many rows a list endpoint returns.
   */
  async loadFieldPermissionRules(
    claims: RequestClaims,
    objectKey: string,
    fieldKeys: readonly string[]
  ): Promise<FieldRuleRow[]> {
    if (!claims.company_id || fieldKeys.length === 0) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<FieldRuleRow>(
        `SELECT fpr.field_key, fpr.access, fpr.condition, fpr.mask_rule, fpr.priority, fpr.deny_overrides
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id AND r.is_active
         JOIN field_permission_rules fpr ON fpr.role_id = ura.role_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND ${ASSIGNMENT_ACTIVE}
           AND ${FIELD_RULE_ACTIVE}
           AND fpr.object_key = $3
           AND fpr.field_key = ANY($4::text[])`,
        [claims.sub, claims.company_id, objectKey, fieldKeys]
      );
      return result.rows;
    });
  }

  /**
   * Pure, in-memory evaluation of a set of rules (from
   * `loadFieldPermissionRules()`) against one record — no DB access, so
   * it's cheap to call once per row in a list endpoint's loop.
   *
   * `unruledDefaults` (cross-module integration audit Item 8, 2026-10-01):
   * the access a field gets when the caller's roles have NO rule row for
   * it at all — previously always `hidden`, and still `hidden` for any
   * field not in this map. A field counts as "ruled" as soon as ANY rule
   * row exists for it, even one whose `condition` doesn't match this
   * record: a conditional rule is an explicit configuration decision ("only
   * when terminated"), so a non-match resolves to `hidden`, never falls
   * through to the default. That is what makes an explicit configuration
   * always win over the default, in both directions (a rule can widen a
   * field the default would hide, or `hidden` can narrow one the default
   * would show). Callers own what the defaults are — this engine stays
   * generic (EmployeesService derives them from field sensitivity tiers).
   */
  evaluateFieldAccess(
    rules: FieldRuleRow[],
    fieldKeys: readonly string[],
    record: Record<string, unknown>,
    unruledDefaults?: ReadonlyMap<string, FieldAccess>
  ): Map<string, FieldAccess> {
    const decisions = this.evaluateFieldDecisions(rules, fieldKeys, record, unruledDefaults);
    return new Map([...decisions].map(([key, d]) => [key, d.access]));
  }

  /** As evaluateFieldAccess(), but also returns the mask rule for `masked` fields (ACC-01). */
  evaluateFieldDecisions(
    rules: FieldRuleRow[],
    fieldKeys: readonly string[],
    record: Record<string, unknown>,
    unruledDefaults?: ReadonlyMap<string, FieldAccess>
  ): Map<string, FieldDecision> {
    const decisions = new Map<string, FieldDecision>();
    const ruled = new Set<string>();
    const applicable = new Map<string, FieldRuleRow[]>();
    for (const row of rules) {
      if (!fieldKeys.includes(row.field_key)) continue;
      ruled.add(row.field_key);
      if (row.condition && !conditionMatches(row.condition, record)) continue;
      const list = applicable.get(row.field_key) ?? [];
      list.push(row);
      applicable.set(row.field_key, list);
    }
    for (const key of fieldKeys) {
      if (unruledDefaults && !ruled.has(key)) {
        decisions.set(key, { access: unruledDefaults.get(key) ?? "hidden", maskRule: null });
      } else {
        decisions.set(key, combineFieldRules(applicable.get(key) ?? []));
      }
    }
    return decisions;
  }

  /**
   * The per-row counterpart to `resolveViewScope()`/`loadFieldPermissionRules()`
   * — takes their already-fetched results instead of querying anything
   * itself. `ownerId` is the record's own owning user_account_id (the
   * `.self` match, same as `filterRecordFields()`); `teamOwnerId` is the
   * record's direct manager's user_account_id (the `.team` match, Phase 7
   * addition). Returns the same shape `filterRecordFields()` does: the
   * filtered record, or `null` if the caller can't see this row at all.
   */
  filterRecordFieldsWithScope<T extends Record<string, unknown>>(
    scope: { hasAll: boolean; hasSelf: boolean; hasTeam: boolean },
    fieldRules: FieldRuleRow[],
    record: T,
    sensitiveFields: readonly string[],
    ownerId: string | null,
    teamOwnerId: string | null,
    callerSub: string,
    // Item 8 — see evaluateFieldAccess()'s own doc comment.
    unruledDefaults?: ReadonlyMap<string, FieldAccess>
  ): Record<string, unknown> | null {
    const visible =
      scope.hasAll ||
      (scope.hasSelf && Boolean(ownerId) && ownerId === callerSub) ||
      (scope.hasTeam && Boolean(teamOwnerId) && teamOwnerId === callerSub);
    if (!visible) return null;

    const applicableFields = sensitiveFields.filter((key) => key in record);
    const decisions = this.evaluateFieldDecisions(fieldRules, applicableFields, record, unruledDefaults);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!sensitiveFields.includes(key)) {
        result[key] = value;
        continue;
      }
      const decision = decisions.get(key);
      if (decision?.access === "masked") {
        result[key] = maskValue(value, decision.maskRule);
      } else if (decision && decision.access !== "hidden") {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Organization Management Phase 11 (Unified Integration & Synchronization
   * Requirements, Section 19) — whether the caller holds the `.scoped`
   * variant of a view permission (e.g. `position.view.scoped`), the
   * alternative to `.all` this phase introduces for Organization
   * Management's list/view endpoints. Deliberately a separate check
   * rather than a third suffix branch inside `can()` itself: `.self`/
   * `.team` there check "does this one record's owner match the caller",
   * a per-record comparison `can()` can make on its own. `.scoped`'s
   * question — "is this record within one of the caller's assigned org
   * units/locations/cost centers" — needs a whole id set resolved and,
   * for hierarchical objects, a subtree expanded, which is each object's
   * own domain knowledge (OrgUnitsService/LocationsService's own
   * `expandToSubtreeIds()`), not something this generic engine should
   * duplicate. Callers check this once per request (like
   * `resolveViewScope()` above), not per record.
   */
  async hasScopedPermission(claims: RequestClaims, viewPermissionKeyBase: string): Promise<boolean> {
    if (!claims.company_id) return false;
    return this.hasPermission(claims, `${viewPermissionKeyBase}.scoped`);
  }

  /**
   * Every `data_scope_assignments` row's raw `scope_entity_id` the caller
   * holds for one scope type, UNEXPANDED. An `org_unit`/`location`
   * assignment means "this entity and everything under it", but walking
   * that hierarchy is each hierarchy's own recursive-CTE knowledge (see
   * `OrgUnitsService.expandToSubtreeIds()`/
   * `LocationsService.expandToSubtreeIds()`), which this generic RBAC
   * engine deliberately does not duplicate or depend on. `cost_center`
   * assignments are used exactly as returned — Cost Center is a flat
   * catalog (Phase 4), nothing to expand.
   *
   * An empty array — not "no restriction" — is the correct return for a
   * caller who holds a `.scoped` permission but has zero assignments:
   * Data Scope fails closed. Whether "no restriction" applies at all is
   * the separate `.all` check the calling service already makes before
   * ever reaching this method.
   */
  async resolveDataScopeEntityIds(claims: RequestClaims, scopeType: DataScopeAssignmentScopeType, objectKey?: string): Promise<string[]> {
    return this.queryDataScope(claims, scopeType, true, objectKey);
  }

  /**
   * ACC-04: assignments with `include_descendants = false` -- exactly these
   * entities, no subtree. Kept apart from resolveDataScopeEntityIds() because
   * every existing caller expands that result to a subtree; mixing them would
   * silently widen access. A caller that supports exact scopes unions this set
   * with its expanded set (OrgUnitsService and LocationsService do).
   */
  async resolveDataScopeExactIds(claims: RequestClaims, scopeType: DataScopeAssignmentScopeType, objectKey?: string): Promise<string[]> {
    return this.queryDataScope(claims, scopeType, false, objectKey);
  }

  private async queryDataScope(
    claims: RequestClaims,
    scopeType: DataScopeAssignmentScopeType,
    includeDescendants: boolean,
    objectKey?: string
  ): Promise<string[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      // Only assignments inside their window count; a role-linked assignment
      // needs that role to be currently held and active; an object-linked
      // assignment applies only when the caller asks for that object.
      const result = await client.query<{ scope_entity_id: string }>(
        `SELECT dsa.scope_entity_id FROM data_scope_assignments dsa
         WHERE dsa.user_account_id = $1 AND dsa.company_id = $2 AND dsa.scope_type = $3
           AND dsa.include_descendants = $4
           AND (dsa.effective_from IS NULL OR dsa.effective_from <= CURRENT_DATE)
           AND (dsa.effective_to IS NULL OR dsa.effective_to >= CURRENT_DATE)
           AND (dsa.object_key IS NULL OR dsa.object_key = $5)
           AND (dsa.role_id IS NULL OR EXISTS (
                 SELECT 1 FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id AND r.is_active
                  WHERE ura.user_account_id = dsa.user_account_id AND ura.company_id = dsa.company_id AND ura.role_id = dsa.role_id
                    AND ${ASSIGNMENT_ACTIVE}))`,
        [claims.sub, claims.company_id, scopeType, includeDescendants, objectKey ?? null]
      );
      return result.rows.map((row) => row.scope_entity_id);
    });
  }

  /**
   * Whether the caller currently holds `permissionKey` exactly as written
   * (no .self/.team target semantics). Used to stop a role editor granting
   * a permission the editor does not hold themselves (ACC-02).
   */
  async holdsPermission(claims: RequestClaims, permissionKey: string): Promise<boolean> {
    if (!claims.company_id) return false;
    return this.hasPermission(claims, permissionKey);
  }

  /** Every permission key the caller holds through their active roles (what they may put into a custom role). */
  async listHeldPermissionKeys(claims: RequestClaims): Promise<string[]> {
    if (!claims.company_id) return [];
    const result = await this.db.queryWithClaims(
      claims,
      `SELECT DISTINCT p.key
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id AND r.is_active
         JOIN role_permissions rp ON rp.role_id = ura.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND ${ASSIGNMENT_ACTIVE}
         ORDER BY p.key`,
      [claims.sub, claims.company_id]
    );
    return result.rows.map((row) => String(row.key));
  }

  private hasPermission(claims: RequestClaims, permissionKey: string): Promise<boolean> {
    // Asked once per http request for the same user and permission (see memoizeForRequest); the next request asks again.
    return memoizeForRequest(`p|${claims.sub}|${claims.company_id ?? ""}|${permissionKey}`, () => this.lookupPermission(claims, permissionKey));
  }

  private async lookupPermission(claims: RequestClaims, permissionKey: string): Promise<boolean> {
    // One round trip (see DatabaseService.queryWithClaims); never cached, so a role change applies on the next request.
    const result = await this.db.queryWithClaims(
      claims,
      `SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id AND r.is_active
         JOIN role_permissions rp ON rp.role_id = ura.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND ${ASSIGNMENT_ACTIVE}
           AND p.key = $3
         LIMIT 1`,
      [claims.sub, claims.company_id ?? null, permissionKey]
    );
    return result.rowCount > 0;
  }
}

function conditionMatches(condition: FieldCondition, record: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== "object" || !("field" in condition)) return false;
  return record[condition.field] === condition.equals;
}
