import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";
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

  // R3 - loss of pay from attendance (see migration 0181).
  @IsOptional()
  @IsIn(["off", "absent_days"])
  absenceDeductionMode?: "off" | "absent_days";

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(31)
  lateMarksPerAbsence?: number | null;
}
