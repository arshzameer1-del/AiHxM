import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";

export class CreateCompensationComponentDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  // Payroll Enterprise Gap Analysis Phase P3 — defaults to "earning" in
  // the service when omitted.
  @IsOptional()
  @IsIn(["earning", "deduction"])
  componentType?: "earning" | "deduction";
}
