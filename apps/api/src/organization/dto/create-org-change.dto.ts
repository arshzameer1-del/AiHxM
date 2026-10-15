import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from "class-validator";

const ITEM_ACTIONS = [
  "move",
  "rename",
  "retype",
  "archive",
  "activate",
  "position_freeze",
  "position_unfreeze",
  "position_abolish",
  "position_reactivate",
  "position_rename",
  "position_move",
  "location_rename",
  "location_archive",
  "location_activate",
  "cost_center_rename",
  "cost_center_archive",
  "cost_center_activate",
  "profit_center_rename",
  "profit_center_archive",
  "profit_center_activate",
  "assignment_transfer",
] as const;
const ENTITY_TYPES = ["org_unit", "position", "location", "cost_center", "profit_center", "assignment"] as const;
const CASCADE_ACTIONS = ["require_vacant", "auto_unassign"] as const;

/**
 * One proposed mutation within a reorg batch — see
 * 0076_reorganization_changes.sql's header comment for why `sequence` is
 * assigned by array position (this DTO) rather than caller-supplied, and
 * why there is no update-items endpoint (a wrong draft is discarded and
 * recreated). `newParentId`/`newName`/`newUnitType` are all optional here
 * — OrgChangesService.validate() is what actually enforces "a `move` item
 * needs `newParentId`," not this DTO — the same "shape-only here,
 * business rules in the service" split `UpdatePositionDto`'s own
 * three-way set/clear/leave-alone fields already established.
 */
export class OrgChangeItemDto {
  /** Required for org-unit items; the service enforces which of orgUnitId / entityId an item needs. */
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsIn(ENTITY_TYPES)
  entityType?: (typeof ENTITY_TYPES)[number];

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsIn(ITEM_ACTIONS)
  action!: (typeof ITEM_ACTIONS)[number];

  @IsOptional()
  @IsUUID()
  newParentId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  newName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  newUnitType?: string;

  // Cross-module integration audit Item 7 (2026-10-01) — see
  // OrgChangeCascadeAction in shared-types. Optional; omitted means the
  // safe, blocking `require_vacant`.
  @IsOptional()
  @IsIn(CASCADE_ACTIONS)
  cascadeAction?: (typeof CASCADE_ACTIONS)[number];
}

export class CreateOrgChangeDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  effectiveDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrgChangeItemDto)
  items!: OrgChangeItemDto[];
}
