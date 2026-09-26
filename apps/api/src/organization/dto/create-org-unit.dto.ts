import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import type { OrgUnitType } from "@aihxm/shared-types";

const ORG_UNIT_TYPES: OrgUnitType[] = ["department", "division", "business_unit", "function"];

export class CreateOrgUnitDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(ORG_UNIT_TYPES)
  unitType!: OrgUnitType;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
