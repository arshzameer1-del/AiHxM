import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import type { CreateDelegationRequest, DelegationView } from "@aihxm/shared-types";

const MANAGE_PERMISSION = "workflow_template.manage.all";
const isoDate = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v).slice(0, 10));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(r: any): DelegationView {
  return {
    id: r.id,
    delegatorUserAccountId: r.delegator_user_account_id,
    delegateUserAccountId: r.delegate_user_account_id,
    scopeObjectKeys: r.scope_object_keys,
    validFrom: isoDate(r.valid_from),
    validTo: isoDate(r.valid_to),
    reason: r.reason,
    status: r.status,
    createdByUserAccountId: r.created_by_user_account_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

/**
 * Gap Register ACC-06 -- standing delegation / substitution. While a delegation
 * is active the delegate may act on every approval the delegator could act on
 * (optionally limited to some object types); each decision records who it was
 * really made on behalf of (workflow_step_approvals.delegated_from_user_account_id).
 * A delegate never decides a request that is about themselves.
 */
@Injectable()
export class DelegationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateDelegationRequest): Promise<DelegationView> {
    if (!claims.company_id) throw new ForbiddenException();
    const delegator = input.delegatorUserAccountId ?? claims.sub;
    if (delegator !== claims.sub && !(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Only the delegator or a workflow administrator can create this delegation");
    }
    if (delegator === input.delegateUserAccountId) throw new BadRequestException("You cannot delegate to yourself");
    if (!input.reason?.trim()) throw new BadRequestException("A reason is required");
    if (input.scopeObjectKeys && input.scopeObjectKeys.length === 0) throw new BadRequestException("scopeObjectKeys cannot be empty; omit it to delegate everything");

    return this.db.withClaims(claims, async (client) => {
      for (const [who, id] of [["delegator", delegator], ["delegate", input.delegateUserAccountId]] as const) {
        const m = await client.query(
          `SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2
           UNION SELECT 1 FROM employees WHERE user_account_id = $1 AND company_id = $2 LIMIT 1`,
          [id, claims.company_id]
        );
        if (!m.rowCount) throw new BadRequestException(`The ${who} is not a user of this company`);
      }
      const today = await client.query<{ d: string }>("SELECT CURRENT_DATE::text AS d");
      const validFrom = input.validFrom ?? today.rows[0].d;
      if (input.validTo < validFrom) throw new BadRequestException("validTo cannot be before validFrom");
      if (input.validTo < today.rows[0].d) throw new BadRequestException("validTo is already in the past");

      const r = await client.query(
        `INSERT INTO delegations (company_id, delegator_user_account_id, delegate_user_account_id, scope_object_keys, valid_from, valid_to, reason, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, delegator, input.delegateUserAccountId, input.scopeObjectKeys ?? null, validFrom, input.validTo, input.reason.trim(), claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "delegation.create",
        target: r.rows[0].id,
        reason: input.reason.trim(),
        metadata: { delegator, delegate: input.delegateUserAccountId, validFrom, validTo: input.validTo, scope: input.scopeObjectKeys ?? "all" },
      });
      return toView(r.rows[0]);
    });
  }

  /** My delegations (given and received); workflow administrators can list the whole company. */
  async list(claims: RequestClaims, opts: { all?: boolean } = {}): Promise<DelegationView[]> {
    if (!claims.company_id) return [];
    const all = !!opts.all;
    if (all && !(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to list every delegation");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM delegations WHERE company_id = $1 AND ($2::boolean OR delegator_user_account_id = $3 OR delegate_user_account_id = $3)
          ORDER BY created_at DESC`,
        [claims.company_id, all, claims.sub]
      );
      return r.rows.map(toView);
    });
  }

  async revoke(claims: RequestClaims, id: string): Promise<DelegationView> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM delegations WHERE id = $1 AND company_id = $2 FOR UPDATE", [id, claims.company_id]);
      if (!cur.rowCount) throw new NotFoundException("Delegation not found");
      const d = cur.rows[0];
      if (d.status === "revoked") throw new ConflictException("This delegation is already revoked");
      if (![d.delegator_user_account_id, d.created_by_user_account_id].includes(claims.sub) && !(await this.rbac.can(claims, MANAGE_PERMISSION))) {
        throw new ForbiddenException("Only the delegator or a workflow administrator can revoke this delegation");
      }
      const r = await client.query("UPDATE delegations SET status = 'revoked', revoked_at = now(), revoked_by_user_account_id = $2 WHERE id = $1 RETURNING *", [id, claims.sub]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "delegation.revoke", target: id, metadata: {} });
      return toView(r.rows[0]);
    });
  }
}
