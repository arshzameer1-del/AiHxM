import { IsDateString, IsIn, IsOptional, IsUUID } from "class-validator";
import type { OrgRelationshipType } from "@aihxm/shared-types";

const RELATIONSHIP_TYPES: OrgRelationshipType[] = ["direct", "dotted_line", "matrix", "temporary", "acting"];

export class CreateOrgRelationshipDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  managerEmployeeId!: string;

  @IsIn(RELATIONSHIP_TYPES)
  relationshipType!: OrgRelationshipType;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export { RELATIONSHIP_TYPES };
