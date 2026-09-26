import { IsDateString, IsOptional, IsUUID, ValidateIf } from "class-validator";

/**
 * `positionId: null` is a real, required value here (clear this unit's
 * head) — distinct from omitting the field entirely, which is a
 * validation error, the same "null is a value, omission is not" posture
 * `MoveOrgUnitDto.parentId` already takes for the identical reason (this
 * is a dedicated single-purpose action, not a partial patch). `@ValidateIf`
 * runs `@IsUUID()` for anything other than a literal `null`, so `undefined`
 * (field omitted) still fails validation the same way a malformed string
 * would.
 */
export class SetOrgUnitHeadPositionDto {
  @ValidateIf((o) => o.positionId !== null)
  @IsUUID()
  positionId!: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
