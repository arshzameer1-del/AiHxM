import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
import type { PersonNationalIdType } from "@aihxm/shared-types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NATIONAL_ID_TYPES = ["cnic", "nicop", "passport", "b_form", "other"] as const;

/** Every field is optional; `null` clears a nullable field. */
export class UpdatePersonDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) firstName?: string;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(100) middleName?: string | null;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) lastName?: string;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(100) preferredName?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(40) title?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(40) gender?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(80) nationality?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(80) secondNationality?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(80) language?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(40) maritalStatus?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @Matches(DAY) maritalStatusDate?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(120) placeOfBirth?: string | null;
  @IsOptional() @IsIn(NATIONAL_ID_TYPES) nationalIdType?: PersonNationalIdType;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(40) passportNumber?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @Matches(DAY) passportExpiry?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(40) ntn?: string | null;
  @IsOptional() @Matches(DAY) effectiveDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
