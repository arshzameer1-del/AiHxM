import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class DryRunPayrollInputDto {
  @IsIn(["payroll_components", "payroll_payments"]) importType!: "payroll_components" | "payroll_payments";
  @IsString() @MinLength(1) csv!: string;
  @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  @IsOptional() @IsBoolean() allowPartial?: boolean;
}
