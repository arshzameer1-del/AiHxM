import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

const SCHEMES = ["pessi", "sessi", "other"];

/** BACKLOG49. A field left out is unchanged; sending null clears it. */
export class UpsertEmployeeStatutoryIdsDto {
  @IsUUID()
  employeeId!: string;

  @IsOptional() @IsString() @MaxLength(40) eobiNumber?: string | null;
  @IsOptional() @IsDateString() eobiRegistrationDate?: string | null;
  @IsOptional() @IsIn(SCHEMES) socialSecurityScheme?: "pessi" | "sessi" | "other" | null;
  @IsOptional() @IsString() @MaxLength(40) socialSecurityNumber?: string | null;
  @IsOptional() @IsDateString() socialSecurityRegistrationDate?: string | null;
  @IsOptional() @IsString() @MaxLength(40) providentFundNumber?: string | null;
  @IsOptional() @IsDateString() providentFundMemberSince?: string | null;
  @IsOptional() @IsDateString() cnicIssueDate?: string | null;
  @IsOptional() @IsDateString() cnicExpiryDate?: string | null;
  @IsOptional() @IsBoolean() cnicLifetime?: boolean;
  @IsOptional() @IsString() @MaxLength(60) visaType?: string | null;
  @IsOptional() @IsDateString() visaExpiryDate?: string | null;
  @IsOptional() @IsString() @MaxLength(40) workPermitNumber?: string | null;
  @IsOptional() @IsDateString() workPermitExpiryDate?: string | null;
}
