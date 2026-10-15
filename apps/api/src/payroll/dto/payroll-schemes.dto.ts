import { IsBoolean, IsDateString, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class UpsertPayrollSchemeDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) code!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(["provident_fund", "gratuity", "other"]) schemeType?: "provident_fund" | "gratuity" | "other";
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @IsDateString() effectiveFrom!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  // the service validates each parameter and rejects unknown ones
  @IsOptional() @IsObject() parameters?: Record<string, unknown>;
}

export class UpdateSettlementSettingsDto {
  @IsOptional() @IsNumber() dailyRateDivisor?: number | null;
  @IsOptional() @IsIn(["basic_salary", "gross_earnings"]) dailyRateBase?: "basic_salary" | "gross_earnings" | null;
  @IsOptional() @IsBoolean() leaveEncashmentEnabled?: boolean;
  @IsOptional() @IsBoolean() leaveEncashmentTaxable?: boolean;
  @IsOptional() @IsBoolean() noticeRecoveryEnabled?: boolean;
}

export class OpenSchemeAccountDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) schemeCode!: string;
}

export class PostSchemeLedgerEntryDto {
  @IsIn(["opening_balance", "withdrawal", "adjustment"]) entryType!: "opening_balance" | "withdrawal" | "adjustment";
  @IsNumber() amount!: number;
  @IsOptional() @IsDateString() entryDate?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SchemeReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

