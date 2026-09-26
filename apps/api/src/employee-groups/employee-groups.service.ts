import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import type { RuleExpression } from "../rules-engine/rules-engine.engine";
import { EMPLOYEE_CONDITION_FIELD_TO_COLUMN as CONDITION_FIELD_TO_COLUMN } from "../employees/employee-condition-fields.util";
import type {
  AssignGroupPolicyRequest,
  CreateEmployeeGroupRequest,
  CreateLeavePolicyRequest,
  EmployeeGroupCondition,
  EmployeeGroupPolicyAssignmentView,
  EmployeeGroupView,
  LeavePolicyVersionView,
  LeavePolicyView,
  PolicyType,
  ResolvedPolicyView,
  UpdateEmployeeGroupRequest,
  UpdateLeavePolicyRequest,
} from "@aihxm/shared-types";

const GROUP_MODULE_KEY = "employee" as const;
const LEAVE_MODULE_KEY = "leave" as const;
const GROUP_MANAGE_PERMISSION = "employee_group.manage";
const LEAVE_POLICY_MANAGE_PERMISSION = "leave_policy.manage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToGroup(
  row: any,
  conditions: EmployeeGroupCondition[],
  policyAssignments: EmployeeGroupPolicyAssignmentView[] = []
): EmployeeGroupView {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    description: row.description,
    conditions,
    policyAssignments,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// `row` is the leave_policies identity row; `version` is its CURRENT
// (effective_to IS NULL) leave_policy_versions row — joined by the
// caller, never queried separately per policy (same "one query, not
// N+1" discipline listGroups already follows for conditions/assignments).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLeavePolicy(row: any, version: any): LeavePolicyView {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    annualLeaveDays: version.annual_leave_days,
    casualLeaveDays: version.casual_leave_days,
    sickLeaveDays: version.sick_leave_days,
    isDefault: row.is_default,
    effectiveFrom: toIso(version.effective_from).slice(0, 10),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLeavePolicyVersion(row: any): LeavePolicyVersionView {
  return {
    id: row.id,
    policyId: row.policy_id,
    annualLeaveDays: row.annual_leave_days,
    casualLeaveDays: row.casual_leave_days,
    sickLeaveDays: row.sick_leave_days,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignment(row: any): EmployeeGroupPolicyAssignmentView {
  return {
    id: row.id,
    groupId: row.group_id,
    policyType: row.policy_type,
    policyId: row.policy_id,
    createdAt: toIso(row.created_at),
  };
}

/**
 * Organization Management Phase 1 (0065_organization_units.sql): a
 * `department` condition should keep matching the legacy free-text value
 * (unchanged behavior for every group configured before this phase — and
 * for any employee not yet linked to a canonical org unit, since
 * `employees.department` is still kept in sync from the linked unit's
 * name when one exists — see EmployeesService.resolveDepartment()), but
 * now ALSO matches when `equals` is the employee's `orgUnitId` directly —
 * the more robust way to author a NEW condition, since it survives the
 * unit being renamed later (a text match wouldn't). This is the smallest
 * correct change to the resolver: every other field's condition still
 * becomes a single `equals` leaf exactly as `allEqual()` (rules-engine.
 * engine.ts) already built it; only `department` becomes an `any` (OR) of
 * the two possible representations. Specificity (`entry.conditions.length`
 * in both call sites below) is computed over the ORIGINAL condition list,
 * so most-specific-match-wins is completely unaffected — this only changes
 * what a match means, not how many conditions a group has.
 *
 * Organization Management Phase 4 (0073_locations_and_financial_centers.sql)
 * replicates the exact same treatment for `location`/`locationId`, since
 * `employees.location` is now the same kind of "legacy free text, kept in
 * sync from a canonical link when one exists" column `department` already
 * was — see EmployeesService.resolveLocation().
 */
function buildMatchExpression(conditions: ReadonlyArray<{ field: string; equals: unknown }>): RuleExpression {
  return {
    all: conditions.map((c): RuleExpression => {
      if (c.field === "department") {
        return {
          any: [
            { field: "department", operator: "equals", value: c.equals },
            { field: "orgUnitId", operator: "equals", value: c.equals },
          ],
        };
      }
      if (c.field === "location") {
        return {
          any: [
            { field: "location", operator: "equals", value: c.equals },
            { field: "locationId", operator: "equals", value: c.equals },
          ],
        };
      }
      return { field: c.field, operator: "equals", value: c.equals };
    }),
  };
}

function assertConditionsValid(conditions: EmployeeGroupCondition[]): void {
  if (conditions.length === 0) {
    throw new BadRequestException("An employee group requires at least one condition");
  }
  const fields = conditions.map((c) => c.field);
  if (new Set(fields).size !== fields.length) {
    throw new BadRequestException("An employee group cannot have two conditions on the same field");
  }
}

/**
 * Phase 8 (plan doc Section 12): a generic per-group policy resolution
 * mechanism, built by REUSING Phase 4's own resolver pattern rather than
 * inventing a second one — see 0012_employee_groups_leave_policy.sql's
 * header comment for the full design writeup (most-specific-match-wins,
 * additive combination across policy_type, safe-deny default) and
 * Decision #8 in DECISIONS.md.
 *
 * Two module gates, deliberately different: employee-group definitions
 * live under the `employee` module (a segmentation mechanism useful to
 * any future module, not leave-specific), while leave policies and the
 * act of assigning one to a group live under `leave` — the first, and
 * currently only, concrete consumer of that mechanism.
 */
@Injectable()
export class EmployeeGroupsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly effectiveDating: EffectiveDatingEngine,
    private readonly rulesEngine: RulesEngine
  ) {}

  // --- Employee Groups --------------------------------------------------

  async createGroup(claims: RequestClaims, input: CreateEmployeeGroupRequest): Promise<EmployeeGroupView> {
    await this.requireGroupManage(claims);
    assertConditionsValid(input.conditions);

    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM employee_groups WHERE company_id = $1 AND name = $2", [
        claims.company_id,
        input.name,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`An employee group named "${input.name}" already exists`);
      }

      const result = await client.query(
        "INSERT INTO employee_groups (company_id, name, description) VALUES ($1, $2, $3) RETURNING *",
        [claims.company_id, input.name, input.description ?? null]
      );
      const group = result.rows[0];
      for (const condition of input.conditions) {
        await client.query(
          "INSERT INTO employee_group_conditions (group_id, company_id, field, equals) VALUES ($1, $2, $3, $4)",
          [group.id, claims.company_id, condition.field, condition.equals]
        );
      }
      return rowToGroup(group, input.conditions);
    });
  }

  async listGroups(claims: RequestClaims): Promise<EmployeeGroupView[]> {
    await this.requireGroupManage(claims);
    return this.db.withClaims(claims, async (client) => {
      // One query for every group, one for every condition, one for every
      // policy assignment — not N+1 per group, the same "resolve once per
      // request" discipline Phase 7's resolveViewScope/loadFieldPermissionRules
      // established. Sequential awaits on this one shared client, not
      // Promise.all — see Decision #13's own note on `pg`'s "client already
      // executing a query" deprecation warning for the identical shape;
      // this was the pre-existing instance that decision flagged but left
      // alone, fixed now while this function is already being touched.
      const groups = await client.query("SELECT * FROM employee_groups ORDER BY created_at ASC");
      const conditions = await client.query("SELECT * FROM employee_group_conditions ORDER BY field ASC");
      const assignments = await client.query(
        "SELECT * FROM employee_group_policy_assignments ORDER BY created_at ASC"
      );
      const conditionsByGroup = new Map<string, EmployeeGroupCondition[]>();
      for (const row of conditions.rows) {
        const list = conditionsByGroup.get(row.group_id) ?? [];
        list.push({ field: row.field, equals: row.equals });
        conditionsByGroup.set(row.group_id, list);
      }
      const assignmentsByGroup = new Map<string, EmployeeGroupPolicyAssignmentView[]>();
      for (const row of assignments.rows) {
        const list = assignmentsByGroup.get(row.group_id) ?? [];
        list.push(rowToAssignment(row));
        assignmentsByGroup.set(row.group_id, list);
      }
      return groups.rows.map((row) =>
        rowToGroup(row, conditionsByGroup.get(row.id) ?? [], assignmentsByGroup.get(row.id) ?? [])
      );
    });
  }

  async getGroup(claims: RequestClaims, id: string): Promise<EmployeeGroupView> {
    await this.requireGroupManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const group = await client.query("SELECT * FROM employee_groups WHERE id = $1", [id]);
      if (group.rowCount === 0) throw new NotFoundException("Employee group not found");
      const conditions = await client.query(
        "SELECT field, equals FROM employee_group_conditions WHERE group_id = $1 ORDER BY field",
        [id]
      );
      const assignments = await client.query(
        "SELECT * FROM employee_group_policy_assignments WHERE group_id = $1 ORDER BY created_at ASC",
        [id]
      );
      return rowToGroup(
        group.rows[0],
        conditions.rows.map((r) => ({ field: r.field, equals: r.equals })),
        assignments.rows.map(rowToAssignment)
      );
    });
  }

  async updateGroup(claims: RequestClaims, id: string, patch: UpdateEmployeeGroupRequest): Promise<EmployeeGroupView> {
    await this.requireGroupManage(claims);
    if (patch.conditions) assertConditionsValid(patch.conditions);

    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM employee_groups WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Employee group not found");
      const before = current.rows[0];

      const result = await client.query(
        "UPDATE employee_groups SET name = $2, description = $3, updated_at = now() WHERE id = $1 RETURNING *",
        [id, patch.name ?? before.name, patch.description ?? before.description]
      );
      const after = result.rows[0];

      let conditions: EmployeeGroupCondition[];
      if (patch.conditions) {
        // Replace-all, same as WorkflowService's approval-step definitions
        // — simpler and safer than diffing an add/remove set for what is
        // an infrequent admin-configuration action, not a hot path.
        await client.query("DELETE FROM employee_group_conditions WHERE group_id = $1", [id]);
        for (const condition of patch.conditions) {
          await client.query(
            "INSERT INTO employee_group_conditions (group_id, company_id, field, equals) VALUES ($1, $2, $3, $4)",
            [id, claims.company_id, condition.field, condition.equals]
          );
        }
        conditions = patch.conditions;
      } else {
        const existing = await client.query(
          "SELECT field, equals FROM employee_group_conditions WHERE group_id = $1",
          [id]
        );
        conditions = existing.rows.map((r) => ({ field: r.field, equals: r.equals }));
      }
      const assignments = await client.query(
        "SELECT * FROM employee_group_policy_assignments WHERE group_id = $1 ORDER BY created_at ASC",
        [id]
      );
      return rowToGroup(after, conditions, assignments.rows.map(rowToAssignment));
    });
  }

  async deleteGroup(claims: RequestClaims, id: string): Promise<void> {
    await this.requireGroupManage(claims);
    await this.db.withClaims(claims, async (client) => {
      // Conditions and policy assignments cascade via the FK — see
      // 0012_employee_groups_leave_policy.sql.
      const result = await client.query("DELETE FROM employee_groups WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Employee group not found");
    });
  }

  // --- Leave Policies ----------------------------------------------------

  async createLeavePolicy(claims: RequestClaims, input: CreateLeavePolicyRequest): Promise<LeavePolicyView> {
    await this.requireLeavePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM leave_policies WHERE company_id = $1 AND name = $2", [
        claims.company_id,
        input.name,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`A leave policy named "${input.name}" already exists`);
      }
      if (input.isDefault) {
        // Setting a new default explicitly un-defaults the previous one —
        // "at most one default" is a real invariant (enforced again at
        // the database level by a partial unique index), not just a UI
        // nicety, so this takes over rather than erroring.
        await client.query("UPDATE leave_policies SET is_default = false WHERE company_id = $1", [claims.company_id]);
      }
      const policyResult = await client.query(
        `INSERT INTO leave_policies (company_id, name, is_default) VALUES ($1, $2, $3) RETURNING *`,
        [claims.company_id, input.name, input.isDefault ?? false]
      );
      const policy = policyResult.rows[0];
      // v1 — 0033_effective_dating_leave_tax.sql's own migration strategy,
      // applied identically at creation time: effective from today. Now
      // routed through the shared EffectiveDatingEngine rather than its
      // own hand-written INSERT — see effective-dating.engine.ts's doc
      // comment for why.
      const { row: version } = await this.effectiveDating.applyVersionedRow(client, {
        table: "leave_policy_versions",
        scope: { policy_id: policy.id },
        extraInsertColumns: { company_id: claims.company_id },
        data: {
          annual_leave_days: input.annualLeaveDays ?? 0,
          casual_leave_days: input.casualLeaveDays ?? 0,
          sick_leave_days: input.sickLeaveDays ?? 0,
        },
      });
      return rowToLeavePolicy(policy, version);
    });
  }

  async listLeavePolicies(claims: RequestClaims): Promise<LeavePolicyView[]> {
    await this.requireLeavePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => {
      // One query for policies, one for their current versions — not N+1
      // per policy, same discipline listGroups() already established.
      const policies = await client.query("SELECT * FROM leave_policies ORDER BY created_at ASC");
      const versionRows = await this.effectiveDating.getCurrentRows(client, {
        table: "leave_policy_versions",
        scope: { company_id: claims.company_id! },
      });
      const versionByPolicy = new Map(versionRows.map((v) => [v.policy_id, v]));
      return policies.rows.map((row) => rowToLeavePolicy(row, versionByPolicy.get(row.id)));
    });
  }

  /**
   * Splits the patch into identity fields (name, isDefault — updated in
   * place on `leave_policies`, same as before this migration) and
   * entitlement fields (annual/casual/sick — versioned). A same-day
   * collapse guard keeps this simple: if the current open version was
   * already created TODAY, this edit updates it in place rather than
   * opening a second version for the same day, which would otherwise
   * require a version whose own effective_from postdates its
   * effective_to (invalid) if edited twice in one day. Effective-dating
   * here is day-granularity by design, not intra-day.
   */
  async updateLeavePolicy(claims: RequestClaims, id: string, patch: UpdateLeavePolicyRequest): Promise<LeavePolicyView> {
    await this.requireLeavePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM leave_policies WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Leave policy not found");
      const before = current.rows[0];

      if (patch.isDefault === true) {
        await client.query("UPDATE leave_policies SET is_default = false WHERE company_id = $1 AND id != $2", [
          claims.company_id,
          id,
        ]);
      }

      const policyResult = await client.query(
        `UPDATE leave_policies SET name = $2, is_default = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, patch.name ?? before.name, patch.isDefault ?? before.is_default]
      );
      const policy = policyResult.rows[0];

      const openVersion = await this.effectiveDating.getCurrentRow(client, {
        table: "leave_policy_versions",
        scope: { policy_id: id },
      });
      const entitlementChanged =
        patch.annualLeaveDays !== undefined || patch.casualLeaveDays !== undefined || patch.sickLeaveDays !== undefined;

      let version = openVersion!;
      if (entitlementChanged) {
        const nextAnnual = patch.annualLeaveDays ?? openVersion!.annual_leave_days;
        const nextCasual = patch.casualLeaveDays ?? openVersion!.casual_leave_days;
        const nextSick = patch.sickLeaveDays ?? openVersion!.sick_leave_days;

        // Supersession (including the same-day collapse guard — see this
        // method's own doc comment) now lives once, in
        // EffectiveDatingEngine, rather than hand-written here.
        const { row } = await this.effectiveDating.applyVersionedRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: id },
          extraInsertColumns: { company_id: claims.company_id! },
          data: { annual_leave_days: nextAnnual, casual_leave_days: nextCasual, sick_leave_days: nextSick },
        });
        version = row;
      }

      return rowToLeavePolicy(policy, version);
    });
  }

  /** `GET /leave-policies/:id/history` — every version this policy has ever
   * had, oldest first, the actual "reconstruct what was in effect on date
   * X" deliverable 0033_effective_dating_leave_tax.sql exists for. */
  async getLeavePolicyHistory(claims: RequestClaims, id: string): Promise<LeavePolicyVersionView[]> {
    await this.requireLeavePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const policy = await client.query("SELECT 1 FROM leave_policies WHERE id = $1", [id]);
      if (policy.rowCount === 0) throw new NotFoundException("Leave policy not found");
      const rows = await this.effectiveDating.getHistory(client, {
        table: "leave_policy_versions",
        scope: { policy_id: id },
      });
      return rows.map(rowToLeavePolicyVersion);
    });
  }

  async deleteLeavePolicy(claims: RequestClaims, id: string): Promise<void> {
    await this.requireLeavePolicyManage(claims);
    await this.db.withClaims(claims, async (client) => {
      // policy_id on employee_group_policy_assignments is deliberately not
      // a real FK (see the migration's header comment), so referential
      // integrity here is an explicit app-level check rather than letting
      // the database refuse the delete on its own.
      const inUse = await client.query(
        "SELECT 1 FROM employee_group_policy_assignments WHERE policy_type = 'leave' AND policy_id = $1 LIMIT 1",
        [id]
      );
      if ((inUse.rowCount ?? 0) > 0) {
        throw new ConflictException("Cannot delete a leave policy that is still assigned to an employee group");
      }
      const result = await client.query("DELETE FROM leave_policies WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Leave policy not found");
    });
  }

  // --- Assignment & resolution --------------------------------------------

  async assignPolicy(
    claims: RequestClaims,
    groupId: string,
    input: AssignGroupPolicyRequest
  ): Promise<EmployeeGroupPolicyAssignmentView> {
    // Assigning a policy to a group is leave_policy.manage-gated for now —
    // the only policy_type that exists is 'leave'. Revisit this specific
    // permission choice once a second policy_type ships and assigning it
    // shouldn't require holding leave_policy.manage.
    await this.requireLeavePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const group = await client.query("SELECT id FROM employee_groups WHERE id = $1", [groupId]);
      if (group.rowCount === 0) throw new NotFoundException("Employee group not found");

      if (input.policyType === "leave") {
        const policy = await client.query("SELECT id FROM leave_policies WHERE id = $1", [input.policyId]);
        if (policy.rowCount === 0) throw new BadRequestException("Leave policy not found");
      }

      const result = await client.query(
        `INSERT INTO employee_group_policy_assignments (company_id, group_id, policy_type, policy_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_id, policy_type) DO UPDATE SET policy_id = EXCLUDED.policy_id
         RETURNING *`,
        [claims.company_id, groupId, input.policyType, input.policyId]
      );
      return rowToAssignment(result.rows[0]);
    });
  }

  async unassignPolicy(claims: RequestClaims, groupId: string, policyType: PolicyType): Promise<void> {
    await this.requireLeavePolicyManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "DELETE FROM employee_group_policy_assignments WHERE group_id = $1 AND policy_type = $2",
        [groupId, policyType]
      );
      if (result.rowCount === 0) throw new NotFoundException("No such policy assignment");
    });
  }

  /**
   * The HR-facing resolver — admin-gated (leave_policy.manage), used by
   * `GET /employees/:employeeId/resolved-policy`. Phase 9 (Leave &
   * Attendance) is the first real caller that needs resolution from a
   * NON-admin context (an ordinary employee submitting their own leave
   * request), so it calls `resolvePolicyInternal` below instead of
   * widening this method's own gate — see that method's doc comment for
   * why the split, rather than this comment's Phase-8-era prediction of
   * "just widen the gate," is the actual right shape. This method is now
   * a thin, admin-only wrapper around the shared algorithm.
   */
  async resolvePolicy(claims: RequestClaims, employeeId: string, policyType: PolicyType): Promise<ResolvedPolicyView> {
    await this.requireLeavePolicyManage(claims);
    return this.resolvePolicyInternal(claims, employeeId, policyType);
  }

  /**
   * The resolver's actual algorithm — Phase 8's whole reason to exist,
   * see 0012_employee_groups_leave_policy.sql's header comment for the
   * full writeup. In one line: every employee_group whose conditions ALL
   * match the employee is a candidate; among candidates that also carry
   * an assignment for `policyType`, the one with the MOST conditions
   * (most specific) wins; if none match (or none of the matches carry an
   * assignment), fall back to the tenant's explicitly designated default
   * policy for that type; if there isn't one either, return `policyId:
   * null` rather than guessing.
   *
   * Deliberately UNGATED by `leave_policy.manage` — this is the internal,
   * cross-module entry point `LeaveRequestsService` (Phase 9) calls after
   * it has already authorized the caller against ITS OWN permissions
   * (`leave_request.create.self`/`leave_request.manage.all`). This is the
   * same division of labor `WorkflowService` already established for
   * object-level authorization ("whether the caller may submit or view a
   * given record at all is explicitly NOT this service's job" — see its
   * own class doc comment): the calling module decides who may ask for a
   * resolution, this method just resolves it, checking only that the
   * `leave` module itself is licensed. Not exported through any
   * controller directly — `resolvePolicy` above is the only HTTP-reachable
   * path, and it still requires `leave_policy.manage`.
   */
  async resolvePolicyInternal(claims: RequestClaims, employeeId: string, policyType: PolicyType): Promise<ResolvedPolicyView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employeeResult = await client.query(
        "SELECT department, org_unit_id, location, location_id, designation, employment_type, employment_status FROM employees WHERE id = $1",
        [employeeId]
      );
      if (employeeResult.rowCount === 0) throw new NotFoundException("Employee not found");
      const employee = employeeResult.rows[0];

      // ORDER BY g.created_at matters, not just style: it's what makes the
      // same-specificity tie-break below deterministic (earliest-created
      // matching group wins a tie) instead of depending on whatever
      // incidental order Postgres happens to return joined rows in.
      const rows = await client.query<{ group_id: string; field: string; equals: string; policy_id: string | null }>(
        `SELECT g.id AS group_id, c.field, c.equals, a.policy_id
         FROM employee_groups g
         JOIN employee_group_conditions c ON c.group_id = g.id
         LEFT JOIN employee_group_policy_assignments a ON a.group_id = g.id AND a.policy_type = $1
         ORDER BY g.created_at ASC`,
        [policyType]
      );

      const byGroup = new Map<string, { conditions: Array<{ field: string; equals: string }>; policyId: string | null }>();
      for (const row of rows.rows) {
        const entry = byGroup.get(row.group_id) ?? { conditions: [], policyId: row.policy_id };
        entry.conditions.push({ field: row.field, equals: row.equals });
        entry.policyId = row.policy_id;
        byGroup.set(row.group_id, entry);
      }

      // Resolved once per employee, keyed by the API-facing field name (not
      // the raw column) so it can be handed straight to the shared
      // RulesEngine, which knows nothing about `employees` or SQL columns —
      // same "engine stays generic, caller resolves its own facts" boundary
      // the engine's own doc comment establishes.
      const employeeContext: Record<string, unknown> = {
        orgUnitId: employee.org_unit_id,
        // Organization Management Phase 4 — the same "resolved once,
        // handed to the generic engine under its API-facing name" treatment
        // `orgUnitId` above already gets, so `buildMatchExpression()` can OR
        // a `location` condition against it the same way it already ORs
        // `department` against `orgUnitId`.
        locationId: employee.location_id,
      };
      for (const [apiField, column] of Object.entries(CONDITION_FIELD_TO_COLUMN)) {
        employeeContext[apiField] = employee[column];
      }

      let winner: { groupId: string; policyId: string; specificity: number } | null = null;
      for (const [groupId, entry] of byGroup) {
        if (!entry.policyId) continue; // matches structurally, but no assignment for this policyType
        const allMatch = this.rulesEngine.evaluate(buildMatchExpression(entry.conditions), employeeContext);
        if (!allMatch) continue;
        if (!winner || entry.conditions.length > winner.specificity) {
          winner = { groupId, policyId: entry.policyId, specificity: entry.conditions.length };
        }
      }

      if (winner) {
        return { policyType, policyId: winner.policyId, groupId: winner.groupId, isDefault: false };
      }

      if (policyType === "leave") {
        const defaultPolicy = await client.query(
          "SELECT id FROM leave_policies WHERE company_id = $1 AND is_default = true",
          [claims.company_id]
        );
        if ((defaultPolicy.rowCount ?? 0) > 0) {
          return { policyType, policyId: defaultPolicy.rows[0].id, groupId: null, isDefault: true };
        }
      }
      return { policyType, policyId: null, groupId: null, isDefault: false };
    });
  }

  /**
   * The REVERSE of `resolvePolicy`/`resolvePolicyInternal` — those answer
   * "which policy applies to THIS employee"; this answers "which
   * employees currently belong to THIS group," the population a review
   * cycle (Phase 11) launches against. `groupId: null` resolves to every
   * active employee in the tenant, matching Phase 11's own "no configured
   * participant group means everyone" rule.
   *
   * Deliberately ungated, the same "authorization is the calling
   * module's job" boundary `resolvePolicyInternal` already established —
   * `PerformanceService` has already authorized its own caller against
   * `performance.manage.all` before ever asking for this, so re-applying
   * `employee_group.manage` on top would serve no purpose here.
   */
  async resolveGroupMembers(claims: RequestClaims, groupId: string | null): Promise<string[]> {
    return this.db.withClaims(claims, async (client) => {
      if (!groupId) {
        const result = await client.query<{ id: string }>(
          "SELECT id FROM employees WHERE employment_status = 'active'"
        );
        return result.rows.map((r) => r.id);
      }
      const conditions = await client.query<{ field: string; equals: string }>(
        "SELECT field, equals FROM employee_group_conditions WHERE group_id = $1",
        [groupId]
      );
      if (conditions.rowCount === 0) return [];
      const employees = await client.query(
        "SELECT id, department, org_unit_id, location, location_id, designation, employment_type, employment_status FROM employees WHERE employment_status = 'active'"
      );
      const expression = buildMatchExpression(conditions.rows);
      return employees.rows
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((e: any) => {
          const context: Record<string, unknown> = { orgUnitId: e.org_unit_id, locationId: e.location_id };
          for (const [apiField, column] of Object.entries(CONDITION_FIELD_TO_COLUMN)) {
            context[apiField] = e[column];
          }
          return this.rulesEngine.evaluate(expression, context);
        })
        .map((e) => e.id as string);
    });
  }

  private async requireGroupManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, GROUP_MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, GROUP_MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee groups");
    }
  }

  private async requireLeavePolicyManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, LEAVE_POLICY_MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage leave policies");
    }
  }
}
