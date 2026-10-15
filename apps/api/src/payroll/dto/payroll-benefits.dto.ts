import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from "class-validator";

const TYPES = ["health_insurance", "life_insurance", "pension", "allowance", "loan_scheme", "other"] as const;
const MODES = ["fixed", "percentage"] as const;

export class UpsertBenefitPlanDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,40}$/) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsIn(TYPES) benefitType?: (typeof TYPES)[number];
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsUUID() employeeComponentId?: string | null;
  @IsOptional() @IsString() @MaxLength(80) employerComponentKey?: string | null;
  @IsOptional() @IsIn(MODES) employeeContributionMode?: (typeof MODES)[number];
  @IsOptional() @IsNumber() @Min(0) employeeContributionValue?: number | null;
  @IsOptional() @IsIn(MODES) employerContributionMode?: (typeof MODES)[number];
  @IsOptional() @IsNumber() @Min(0) employerContributionValue?: number | null;
  @IsOptional() @IsInt() @Min(0) minServiceMonths?: number | null;
  @IsOptional() @IsArray() @IsString({ each: true }) employmentTypes?: string[] | null;
  @IsOptional() @IsUUID() payrollAreaId?: string | null;
  @IsDateString() effectiveFrom!: string;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @IsOptional() @IsIn(["active", "inactive"]) status?: "active" | "inactive";
}

export class EnrolBenefitDto {
  @IsUUID() planId!: string;
  @IsUUID() employeeId!: string;
  @IsDateString() effectiveFrom!: string;
  @IsOptional() @IsString() @MaxLength(80) coverageLevel?: string | null;
  @IsOptional() @IsNumber() @Min(0) employeeContributionOverride?: number | null;
  @IsOptional() @IsBoolean() waive?: boolean;
}

export class EndBenefitEnrolmentDto {
  @IsDateString() effectiveTo!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
