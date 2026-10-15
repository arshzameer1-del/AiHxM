import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";
import type { RoleAssignmentSource } from "@aihxm/shared-types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AssignRoleDto {
  @IsUUID()
  userAccountId!: string;

  @IsUUID()
  companyId!: string;

  @IsString()
  @MinLength(1)
  roleKey!: string;

  /** ACC-03: omit both for a permanent grant. */
  @IsOptional()
  @Matches(DAY)
  effectiveFrom?: string;

  @IsOptional()
  @Matches(DAY)
  effectiveTo?: string;

  @IsOptional()
  @IsIn(["manual", "scim", "sso", "workflow", "delegation", "system"])
  source?: RoleAssignmentSource;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
