import { IsDateString, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { OrgUnitType } from "@aihxm/shared-types";

const ORG_UNIT_TYPES: OrgUnitType[] = ["department", "division", "business_unit", "function"];

/** Renames/retypes/recodes only — reparenting is a distinct endpoint
 * (`MoveOrgUnitDto`) since it's the one edit that needs the cycle guard,
 * not a plain field patch. See OrgUnitsService.move()'s doc comment. */
export class UpdateOrgUnitDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(ORG_UNIT_TYPES)
  unitType?: OrgUnitType;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
