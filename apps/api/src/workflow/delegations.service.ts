import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import type { CreateDelegationRequest, DelegateCandidateView, DelegationView } from "@aihxm/shared-types";

const MANAGE_PERMISSION = "workflow_template.manage.all";
const isoDate = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v).slice(0, 10));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(r: any, names: Map<string, string> = new Map()): DelegationView {
  return {
    delegatorName: names.get(r.delegator_user_account_id) ?? null,
    delegateName: names.get(r.delegate_user_account_id) ?? null,
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

/** First and last name of each login that has an employee record, otherwise its email. */
async function namesOf(client: PoolClient, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const r = await client.query(
    `SELECT user_account_id AS id, btrim(first_name || ' ' || last_name) AS name FROM employees WHERE user_account_id = ANY($1::uuid[])`,
    [unique]
  );
  for (const x of r.rows) if (x.name && !out.has(x.id)) out.set(x.id, x.name);
  const rest = unique.filter((id) => !out.has(id));
  if (rest.length > 0) {
    // a login without an employee record (a system administrator): the email, where it can be read
    const u = await client.query("SELECT id, email FROM user_accounts WHERE id = ANY($1::uuid[])", [rest]);
    for (const x of u.rows) out.set(x.id, x.email);
  }
  return out;
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
      return toView(r.rows[0], await namesOf(client, [delegator, input.delegateUserAccountId]));
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
      const names = await namesOf(client, r.rows.flatMap((x) => [x.delegator_user_account_id, x.delegate_user_account_id]));
      return r.rows.map((x) => ({
        ...toView(x, names),
        direction: x.delegator_user_account_id === claims.sub ? ("given" as const) : x.delegate_user_account_id === claims.sub ? ("received" as const) : ("other" as const),
      }));
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
      return toView(r.rows[0], await namesOf(client, [d.delegator_user_account_id, d.delegate_user_account_id]));
    });
  }

  /**
   * People you can hand your approvals to: colleagues of the same company who have a login and an employee record. Needs at
   * least two letters, so the list cannot be used to browse the whole company; shows name, number and job title only.
   */
  async candidates(claims: RequestClaims, q: string): Promise<DelegateCandidateView[]> {
    if (!claims.company_id) return [];
    const term = (q ?? "").replace(/[%_]/g, "").trim();
    if (term.length < 2) return [];
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT user_account_id, employee_number, first_name, last_name, designation
           FROM employees
          WHERE company_id = $1 AND user_account_id IS NOT NULL AND user_account_id <> $2 AND employment_status = 'active'
            AND (first_name || ' ' || last_name ILIKE $3 OR employee_number ILIKE $3)
          ORDER BY first_name, last_name LIMIT 15`,
        [claims.company_id, claims.sub, `%${term}%`]
      );
      return r.rows.map((x) => ({
        userAccountId: x.user_account_id,
        name: `${x.first_name} ${x.last_name}`.trim(),
        employeeNumber: x.employee_number,
        designation: x.designation ?? null,
      }));
    });
  }
}
