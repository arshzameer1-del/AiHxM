import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { DataScopeType, FieldAccess } from "@aihxm/shared-types";

type FieldCondition = { field: string; equals: unknown };

const ACCESS_RANK: Record<FieldAccess, number> = { hidden: 0, view: 1, edit: 2 };

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
      const result = await client.query<{ access: FieldAccess; condition: FieldCondition | null }>(
        `SELECT fpr.access, fpr.condition
         FROM user_role_assignments ura
         JOIN field_permission_rules fpr ON fpr.role_id = ura.role_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND fpr.object_key = $3
           AND fpr.field_key = $4`,
        [claims.sub, claims.company_id, objectKey, fieldKey]
      );
      return result.rows;
    });

    let best: FieldAccess = "hidden";
    for (const row of rows) {
      if (row.condition && !conditionMatches(row.condition, record)) continue;
      if (ACCESS_RANK[row.access] > ACCESS_RANK[best]) best = row.access;
    }
    return best;
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
    const accessByField = await this.resolveFieldAccessBatch(claims, objectKey, applicableFields, record);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!sensitiveFields.includes(key)) {
        result[key] = value;
        continue;
      }
      if (accessByField.get(key) !== "hidden") {
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
  ): Promise<Map<string, FieldAccess>> {
    const access = new Map<string, FieldAccess>(fieldKeys.map((key) => [key, "hidden" as FieldAccess]));
    if (!claims.company_id || fieldKeys.length === 0) return access;

    const rows = await this.db.withClaims(claims, async (client) => {
      const result = await client.query<{
        field_key: string;
        access: FieldAccess;
        condition: FieldCondition | null;
      }>(
        `SELECT fpr.field_key, fpr.access, fpr.condition
         FROM user_role_assignments ura
         JOIN field_permission_rules fpr ON fpr.role_id = ura.role_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND fpr.object_key = $3
           AND fpr.field_key = ANY($4::text[])`,
        [claims.sub, claims.company_id, objectKey, fieldKeys]
      );
      return result.rows;
    });

    for (const row of rows) {
      if (row.condition && !conditionMatches(row.condition, record)) continue;
      const current = access.get(row.field_key) ?? "hidden";
      if (ACCESS_RANK[row.access] > ACCESS_RANK[current]) {
        access.set(row.field_key, row.access);
      }
    }
    return access;
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
  ): Promise<Array<{ field_key: string; access: FieldAccess; condition: FieldCondition | null }>> {
    if (!claims.company_id || fieldKeys.length === 0) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ field_key: string; access: FieldAccess; condition: FieldCondition | null }>(
        `SELECT fpr.field_key, fpr.access, fpr.condition
         FROM user_role_assignments ura
         JOIN field_permission_rules fpr ON fpr.role_id = ura.role_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
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
   */
  evaluateFieldAccess(
    rules: Array<{ field_key: string; access: FieldAccess; condition: FieldCondition | null }>,
    fieldKeys: readonly string[],
    record: Record<string, unknown>
  ): Map<string, FieldAccess> {
    const access = new Map<string, FieldAccess>(fieldKeys.map((key) => [key, "hidden" as FieldAccess]));
    for (const row of rules) {
      if (!fieldKeys.includes(row.field_key)) continue;
      if (row.condition && !conditionMatches(row.condition, record)) continue;
      const current = access.get(row.field_key) ?? "hidden";
      if (ACCESS_RANK[row.access] > ACCESS_RANK[current]) {
        access.set(row.field_key, row.access);
      }
    }
    return access;
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
    fieldRules: Array<{ field_key: string; access: FieldAccess; condition: FieldCondition | null }>,
    record: T,
    sensitiveFields: readonly string[],
    ownerId: string | null,
    teamOwnerId: string | null,
    callerSub: string
  ): Record<string, unknown> | null {
    const visible =
      scope.hasAll ||
      (scope.hasSelf && Boolean(ownerId) && ownerId === callerSub) ||
      (scope.hasTeam && Boolean(teamOwnerId) && teamOwnerId === callerSub);
    if (!visible) return null;

    const applicableFields = sensitiveFields.filter((key) => key in record);
    const accessByField = this.evaluateFieldAccess(fieldRules, applicableFields, record);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!sensitiveFields.includes(key)) {
        result[key] = value;
        continue;
      }
      if (accessByField.get(key) !== "hidden") {
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
  async resolveDataScopeEntityIds(claims: RequestClaims, scopeType: DataScopeType): Promise<string[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ scope_entity_id: string }>(
        `SELECT scope_entity_id FROM data_scope_assignments
         WHERE user_account_id = $1 AND company_id = $2 AND scope_type = $3`,
        [claims.sub, claims.company_id, scopeType]
      );
      return result.rows.map((row) => row.scope_entity_id);
    });
  }

  private async hasPermission(claims: RequestClaims, permissionKey: string): Promise<boolean> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT 1
         FROM user_role_assignments ura
         JOIN role_permissions rp ON rp.role_id = ura.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_account_id = $1
           AND ura.company_id = $2
           AND p.key = $3
         LIMIT 1`,
        [claims.sub, claims.company_id, permissionKey]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

function conditionMatches(condition: FieldCondition, record: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== "object" || !("field" in condition)) return false;
  return record[condition.field] === condition.equals;
}
