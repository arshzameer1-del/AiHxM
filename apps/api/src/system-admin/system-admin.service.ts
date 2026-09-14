import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { AssignableUserView, SystemAdminRoleAssignmentView, TenantRoleKey } from "@boostfactor/shared-types";

const ROLE_ASSIGNMENT_PERMISSION = "role_assignment.manage.all";
// Kept in sync with, but deliberately not imported from, employees.service.ts's
// TENANT_ROLE_KEYS and assign-system-admin-role.dto.ts's ASSIGNABLE_ROLE_KEYS —
// three independent lists that all happen to be "the four real tenant
// roles" today (same pattern as the DTO's own comment explains).
const ASSIGNABLE_ROLE_KEYS: TenantRoleKey[] = ["hr_admin", "line_manager", "employee_self_service", "system_admin"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignmentView(row: any): SystemAdminRoleAssignmentView {
  return {
    id: row.id,
    userAccountId: row.user_account_id,
    employeeId: row.employee_id ?? null,
    employeeName: row.first_name ? `${row.first_name} ${row.last_name}` : null,
    email: row.email ?? null,
    roleKey: row.role_key,
    roleName: row.role_name,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Decision #20 (Task #52) — the real-tenant, self-service counterpart to
 * Platform Admin's `/platform/role-assignments` (RoleAssignmentsController,
 * RoleAssignmentsService), scoped entirely to the caller's own company and
 * gated by `role_assignment.manage.all` instead of `PlatformAdminGuard`.
 *
 * RLS note, same discipline as `EmployeesService.createLogin()` (Decision
 * #12) and for the identical reason: `user_role_assignments_write`
 * (0004_rbac.sql) requires `is_platform_admin() OR is_service()` — a plain
 * tenant session can never write that table directly, by design (role
 * grants are meant to go through a trusted gate, not any authenticated
 * session). `assignRole()`/`revokeRole()` ARE that gate: they check the
 * REAL caller's `role_assignment.manage.all` permission first, then
 * elevate to an `is_service` claims object that keeps the caller's own
 * `company_id` — every query below still explicitly filters on
 * `company_id = claims.company_id` in code rather than leaning on RLS to
 * do it, exactly the discipline `is_service` code always needs once it
 * bypasses the normal tenant-scoping RLS branch.
 *
 * `listAssignableUsers()`/`listRoleAssignments()` are plain reads under the
 * caller's own (non-elevated) claims — `user_role_assignments_select` and
 * `employees`' own select policy both already allow a same-company match,
 * so no elevation is needed just to look.
 */
@Injectable()
export class SystemAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService
  ) {}

  private async requirePermission(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, ROLE_ASSIGNMENT_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage role assignments");
    }
  }

  /**
   * The "who can I grant a login or a role to" picker — every employee in
   * the caller's company, with whether they already have a login and which
   * roles it holds. Deliberately returns only what a System Admin needs
   * for this job (name/email/login status/roles), not the full
   * `EmployeeView` — a System Admin has no `employee.view.*` permission of
   * their own (0024_system_admin.sql) and this endpoint must not become a
   * back door around that.
   */
  async listAssignableUsers(claims: RequestClaims): Promise<AssignableUserView[]> {
    await this.requirePermission(claims);
    return this.db.withClaims(claims, async (client) => {
      const employeesResult = await client.query(
        `SELECT id, employee_number, first_name, last_name, email, user_account_id
         FROM employees WHERE company_id = $1 ORDER BY first_name ASC, last_name ASC`,
        [claims.company_id]
      );
      const assignmentsResult = await client.query<{ user_account_id: string; role_key: TenantRoleKey }>(
        `SELECT ura.user_account_id, r.key AS role_key
         FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id
         WHERE ura.company_id = $1`,
        [claims.company_id]
      );
      const rolesByAccount = new Map<string, TenantRoleKey[]>();
      for (const row of assignmentsResult.rows) {
        const list = rolesByAccount.get(row.user_account_id) ?? [];
        list.push(row.role_key);
        rolesByAccount.set(row.user_account_id, list);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return employeesResult.rows.map((e: any) => ({
        employeeId: e.id,
        employeeNumber: e.employee_number,
        fullName: `${e.first_name} ${e.last_name}`,
        email: e.email,
        userAccountId: e.user_account_id,
        hasLogin: Boolean(e.user_account_id),
        roleKeys: e.user_account_id ? (rolesByAccount.get(e.user_account_id) ?? []) : [],
      }));
    });
  }

  async listRoleAssignments(claims: RequestClaims): Promise<SystemAdminRoleAssignmentView[]> {
    await this.requirePermission(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT ura.id, ura.user_account_id, r.key AS role_key, r.name AS role_name, ura.created_at,
                e.id AS employee_id, e.first_name, e.last_name, e.email
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         LEFT JOIN employees e ON e.user_account_id = ura.user_account_id AND e.company_id = ura.company_id
         WHERE ura.company_id = $1
         ORDER BY ura.created_at ASC`,
        [claims.company_id]
      );
      return result.rows.map(rowToAssignmentView);
    });
  }

  async assignRole(
    claims: RequestClaims,
    input: { employeeId: string; roleKey: TenantRoleKey }
  ): Promise<SystemAdminRoleAssignmentView> {
    await this.requirePermission(claims);
    if (!ASSIGNABLE_ROLE_KEYS.includes(input.roleKey)) {
      throw new BadRequestException(`Cannot assign role "${input.roleKey}"`);
    }

    const elevatedClaims: RequestClaims = {
      is_platform_admin: false,
      is_service: true,
      company_id: claims.company_id,
      sub: "system-admin-service",
    };

    return this.db.withClaims(elevatedClaims, async (client) => {
      const employeeResult = await client.query(
        `SELECT id, first_name, last_name, email, user_account_id FROM employees WHERE id = $1 AND company_id = $2`,
        [input.employeeId, claims.company_id]
      );
      if (employeeResult.rowCount === 0) throw new NotFoundException("Employee not found");
      const employee = employeeResult.rows[0];
      if (!employee.user_account_id) {
        throw new BadRequestException("This employee has no login yet — create one first");
      }

      const role = await client.query("SELECT id, name FROM roles WHERE key = $1", [input.roleKey]);
      if (role.rowCount === 0) throw new NotFoundException(`No role with key "${input.roleKey}"`);

      const existing = await client.query(
        "SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3",
        [employee.user_account_id, claims.company_id, role.rows[0].id]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This user already holds this role");
      }

      const result = await client.query(
        `INSERT INTO user_role_assignments (user_account_id, company_id, role_id)
         VALUES ($1, $2, $3) RETURNING id, user_account_id, created_at`,
        [employee.user_account_id, claims.company_id, role.rows[0].id]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "system_admin.role_assigned",
        target: employee.user_account_id,
        metadata: { roleKey: input.roleKey, employeeId: input.employeeId },
      });

      return rowToAssignmentView({
        ...result.rows[0],
        role_key: input.roleKey,
        role_name: role.rows[0].name,
        employee_id: employee.id,
        first_name: employee.first_name,
        last_name: employee.last_name,
        email: employee.email,
      });
    });
  }

  /**
   * No "last System Admin" guard exists yet — a System Admin can revoke
   * their own (or the last remaining) `system_admin` assignment in their
   * company, which would leave nobody able to reach this module or
   * Workflow Templates again without Platform Admin staff help. Not built
   * here deliberately (plan doc Section 10's guardrail against
   * over-building ahead of a real incident) — flagged in KNOWN_ISSUES.md
   * instead.
   */
  async revokeRole(claims: RequestClaims, assignmentId: string): Promise<void> {
    await this.requirePermission(claims);

    const elevatedClaims: RequestClaims = {
      is_platform_admin: false,
      is_service: true,
      company_id: claims.company_id,
      sub: "system-admin-service",
    };

    await this.db.withClaims(elevatedClaims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM user_role_assignments WHERE id = $1 AND company_id = $2",
        [assignmentId, claims.company_id]
      );
      if (existing.rowCount === 0) throw new NotFoundException("Role assignment not found");

      await client.query("DELETE FROM user_role_assignments WHERE id = $1", [assignmentId]);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "system_admin.role_revoked",
        target: existing.rows[0].user_account_id,
        metadata: { roleId: existing.rows[0].role_id },
      });
    });
  }
}
