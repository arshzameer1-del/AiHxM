import { IsOptional, IsString, ValidateIf } from "class-validator";

export class SetStatutoryJurisdictionDto {
  @ValidateIf((o) => o.statutoryJurisdiction !== null)
  @IsOptional()
  @IsString()
  statutoryJurisdiction?: string | null;
}
