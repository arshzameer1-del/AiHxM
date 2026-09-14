import { ArrayMinSize, IsArray, IsIn, MinLength } from "class-validator";
import type { TenantRoleKey } from "@boostfactor/shared-types";

// Decision #20 — widened to include `system_admin`; see
// employees.service.ts's own TENANT_ROLE_KEYS comment.
const TENANT_ROLE_KEYS: TenantRoleKey[] = ["hr_admin", "line_manager", "employee_self_service", "system_admin"];

export class CreateEmployeeLoginDto {
  @MinLength(8)
  initialPassword!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(TENANT_ROLE_KEYS, { each: true })
  roleKeys!: TenantRoleKey[];
}
