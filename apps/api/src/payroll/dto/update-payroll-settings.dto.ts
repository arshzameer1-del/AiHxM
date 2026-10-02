import { IsIn, IsNumber, IsOptional, Max, Min } from "class-validator";
import type { SocialSecurityScheme } from "@aihxm/shared-types";

const SCHEMES: SocialSecurityScheme[] = ["none", "pessi", "sessi"];

export class UpdatePayrollSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  eobiEmployeeRatePercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  eobiEmployerRatePercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  eobiWageBase?: number;

  @IsOptional()
  @IsIn(SCHEMES)
  socialSecurityScheme?: SocialSecurityScheme;

  @IsOptional()
  @IsNumber()
  @Min(0)
  socialSecurityEmployerRatePercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  socialSecurityWageCeiling?: number | null;

  // Sanity guardrail, not a business rule — see
  // 0100_overtime_standard_monthly_hours.sql's header comment.
  @IsOptional()
  @IsNumber()
  @Min(100)
  @Max(300)
  standardMonthlyHours?: number;
}
