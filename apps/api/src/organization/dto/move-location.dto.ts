import { IsDateString, IsOptional, IsUUID, ValidateIf } from "class-validator";

/**
 * `parentId: null` is a real, required value here (move this location to
 * become a root) — distinct from omitting the field entirely. Exactly
 * `MoveOrgUnitDto`'s own shape.
 */
export class MoveLocationDto {
  @ValidateIf((o) => o.parentId !== null)
  @IsUUID()
  parentId!: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
