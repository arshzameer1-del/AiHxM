import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

const CODE = /^[a-z][a-z0-9_]{1,39}$/;

export class CreateTaxYearDto {
  @IsString() @MinLength(1) @MaxLength(30) label!: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) jurisdiction?: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateTaxYearDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) label?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}

export class PublishTaxRecordDto {
  @IsString() @MinLength(5) @MaxLength(1000) sourceReference!: string;
}

export class CreateTaxProfileDto {
  @IsUUID() taxYearId!: string;
  @Matches(CODE) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsIn(["none", "nearest", "up", "down"]) roundingMode?: "none" | "nearest" | "up" | "down";
  @IsOptional() @IsNumber() @Min(0.01) roundingIncrement?: number;
  @IsOptional() @IsNumber() @Min(0) surchargeThreshold?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) surchargeRatePercent?: number | null;
}

export class UpdateTaxProfileDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsIn(["none", "nearest", "up", "down"]) roundingMode?: "none" | "nearest" | "up" | "down";
  @IsOptional() @IsNumber() @Min(0.01) roundingIncrement?: number;
  @IsOptional() @IsNumber() @Min(0) surchargeThreshold?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) surchargeRatePercent?: number | null;
}

export class CloneTaxProfileDto {
  @Matches(CODE) code!: string;
  @IsOptional() @IsUUID() taxYearId?: string;
}

export class TaxProfileSlabDto {
  @IsNumber() @Min(0) minAnnualIncome!: number;
  @IsOptional() @IsNumber() @Min(0) maxAnnualIncome!: number | null;
  @IsNumber() @Min(0) baseTax!: number;
  @IsNumber() @Min(0) @Max(100) ratePercent!: number;
}

export class SetTaxProfileSlabsDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TaxProfileSlabDto) slabs!: TaxProfileSlabDto[];
}

export class TaxExemptionDto {
  @Matches(CODE) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsIn(["fixed_amount", "percentage_of_income"]) exemptionType!: "fixed_amount" | "percentage_of_income";
  @IsOptional() @IsNumber() @Min(0) annualCap?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) ratePercent?: number | null;
  @IsOptional() @IsBoolean() requiresEvidence?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) sourceReference?: string | null;
}

export class TaxCreditDto {
  @Matches(CODE) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsIn(["fixed_amount", "percentage_of_amount"]) creditType!: "fixed_amount" | "percentage_of_amount";
  @IsOptional() @IsNumber() @Min(0) annualCap?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) ratePercent?: number | null;
  @IsOptional() @IsBoolean() requiresEvidence?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) sourceReference?: string | null;
}

class ExemptionClaimDto {
  @IsUUID() exemptionId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsString() @MaxLength(200) evidenceRef?: string | null;
}

class CreditClaimDto {
  @IsUUID() creditId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsString() @MaxLength(200) evidenceRef?: string | null;
}

export class SetEmployeeTaxProfileDto {
  @IsDateString() effectiveFrom!: string;
  @IsOptional() @IsUUID() taxProfileId?: string | null;
  @IsOptional() @IsIn(["filer", "non_filer", "late_filer", "not_applicable"]) filerStatus?: "filer" | "non_filer" | "late_filer" | "not_applicable";
  @IsOptional() @IsIn(["resident", "non_resident"]) taxResidency?: "resident" | "non_resident";
  @IsOptional() @IsIn(["none", "pessi", "sessi", "bessi", "other"]) provincialScheme?: "none" | "pessi" | "sessi" | "bessi" | "other" | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ExemptionClaimDto) claimedExemptions?: ExemptionClaimDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CreditClaimDto) claimedCredits?: CreditClaimDto[];
  @IsOptional() @IsNumber() @Min(0) previousEmployerIncome?: number;
  @IsOptional() @IsNumber() @Min(0) previousEmployerTax?: number;
  @IsOptional() @IsInt() @Min(2000) @Max(2200) previousEmployerTaxYear?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) changeReasonNote?: string | null;
}
