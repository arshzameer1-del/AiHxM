import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from "class-validator";

const ITEM_ACTIONS = ["move", "rename", "retype", "archive", "activate"] as const;

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
  @IsUUID()
  orgUnitId!: string;

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
