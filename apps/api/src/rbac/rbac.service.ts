import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { FieldAccess } from "@boostfactor/shared-types";

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
    target?: { ownerId?: string | null }
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

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!sensitiveFields.includes(key)) {
        result[key] = value;
        continue;
      }
      const access = await this.resolveFieldAccess(claims, objectKey, key, record);
      if (access !== "hidden") {
        result[key] = value;
      }
      // else: key intentionally left unset — see the doc comment above.
    }
    return result;
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
