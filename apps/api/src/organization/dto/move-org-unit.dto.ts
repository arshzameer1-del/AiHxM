import { IsDateString, IsOptional, IsUUID, ValidateIf } from "class-validator";

/**
 * `parentId: null` is a real, required value here (move this unit to
 * become a root) — distinct from omitting the field entirely, which is a
 * validation error, not "leave the parent unchanged" (this is a dedicated
 * move action, not a partial patch). `@ValidateIf` runs `@IsUUID()` for
 * anything other than a literal `null`, so `undefined` (field omitted)
 * still fails validation the same way a malformed string would.
 */
export class MoveOrgUnitDto {
  @ValidateIf((o) => o.parentId !== null)
  @IsUUID()
  parentId!: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
