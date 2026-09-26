import { IsDateString, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { JobFamily } from "@aihxm/shared-types";
import { JOB_FAMILIES } from "./create-job.dto";

export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

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
