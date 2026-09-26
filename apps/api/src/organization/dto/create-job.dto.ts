import { IsDateString, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { JobFamily } from "@aihxm/shared-types";

const JOB_FAMILIES: JobFamily[] = [
  "engineering",
  "sales",
  "marketing",
  "finance",
  "hr",
  "operations",
  "legal",
  "customer_support",
  "product",
  "administration",
  "executive",
  "other",
];

export class CreateJobDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  jobCode?: string;

  @IsOptional()
  @IsIn(JOB_FAMILIES)
  jobFamily?: JobFamily;

  @IsOptional()
  @IsString()
  jobLevel?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export { JOB_FAMILIES };
