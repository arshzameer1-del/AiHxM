import { IsIn, IsUUID } from "class-validator";
import type { TenantRoleKey } from "@aihxm/shared-types";

// The full four-role catalog (0011_employee_seed.sql + 0024_system_admin.sql)
// — a System Admin may grant/revoke ANY real tenant role, including
// `system_admin` itself (so one System Admin can promote or split the role
// to/from another employee), but never a Phase 4 `rbac_demo_*`
// proof-of-concept role. Mirrors `TENANT_ROLE_KEYS` in
// employees.service.ts's own createLogin() gate — see that file's comment
// on why the two lists are kept in sync but not literally shared code.
const ASSIGNABLE_ROLE_KEYS: TenantRoleKey[] = ["hr_admin", "line_manager", "employee_self_service", "system_admin"];

export class AssignSystemAdminRoleDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(ASSIGNABLE_ROLE_KEYS)
  roleKey!: TenantRoleKey;
}
