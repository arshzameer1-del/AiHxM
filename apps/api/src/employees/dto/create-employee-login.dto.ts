import { ArrayMinSize, IsArray, IsIn, MinLength } from "class-validator";
import type { TenantRoleKey } from "@aihxm/shared-types";

// Decision #20 — widened to include `system_admin`; see
// employees.service.ts's own TENANT_ROLE_KEYS comment. Must list the same roles as that list (and the
// "Grant role(s)" form): `payroll_approver` was missing here, so ticking it gave "each value in roleKeys must be one of...".
export const CREATE_LOGIN_ROLE_KEYS: TenantRoleKey[] = ["hr_admin", "line_manager", "employee_self_service", "ess_portal", "system_admin", "payroll_approver"];

export class CreateEmployeeLoginDto {
  @MinLength(8)
  initialPassword!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(CREATE_LOGIN_ROLE_KEYS, { each: true })
  roleKeys!: TenantRoleKey[];
}
