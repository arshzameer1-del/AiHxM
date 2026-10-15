import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import type { DataScopeAssignmentScopeType } from "@aihxm/shared-types";

const SCOPE_TYPES: DataScopeAssignmentScopeType[] = ["org_unit", "location", "cost_center", "payroll_area"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AssignDataScopeDto {
  @IsUUID()
  userAccountId!: string;

  @IsUUID()
  companyId!: string;

  @IsIn(SCOPE_TYPES)
  scopeType!: DataScopeAssignmentScopeType;

  @IsUUID()
  scopeEntityId!: string;

  /** ACC-04: default true (the entity and everything under it). */
  @IsOptional()
  @IsBoolean()
  includeDescendants?: boolean;

  @IsOptional()
  @Matches(DAY)
  effectiveFrom?: string;

  @IsOptional()
  @Matches(DAY)
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  objectKey?: string;
}
