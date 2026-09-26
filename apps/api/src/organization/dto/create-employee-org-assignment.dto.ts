import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from "class-validator";
import type { AssignmentType } from "@aihxm/shared-types";

const ASSIGNMENT_TYPES: AssignmentType[] = ["primary", "secondary", "concurrent", "temporary", "acting", "secondment"];

export class CreateEmployeeOrgAssignmentDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(ASSIGNMENT_TYPES)
  assignmentType!: AssignmentType;

  @IsUUID()
  orgUnitId!: string;

  @IsOptional()
  @IsUUID()
  positionId?: string;

  /** Phase 5 (Location) placeholder — no canonical Location entity exists
   * yet, so this is an opaque, unvalidated string id for now. */
  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export { ASSIGNMENT_TYPES };
