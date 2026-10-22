import { IsString, IsUUID, Matches } from "class-validator";
import type { TenantRoleKey } from "@aihxm/shared-types";

// The full real-role catalog (0011_employee_seed.sql + 0024_system_admin.sql
// + 0093_payroll_approval_workflow.sql) — a System Admin may grant/revoke
// ANY real tenant role, including `system_admin` itself (so one System
// Admin can promote or split the role to/from another employee), but never
// a Phase 4 `rbac_demo_*` proof-of-concept role. Mirrors `TENANT_ROLE_KEYS`
// in employees.service.ts's own createLogin() gate — see that file's
// comment on why the two lists are kept in sync but not literally shared
// code.
export class AssignSystemAdminRoleDto {
  @IsUUID()
  employeeId!: string;

  // A built-in tenant role (the service checks the list) or one of this company's own custom roles.
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,80}$/)
  roleKey!: TenantRoleKey | string;
}
