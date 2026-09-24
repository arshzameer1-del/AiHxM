import { IsDateString, IsIn, IsOptional, IsString } from "class-validator";
import type { JobHistoryEventType } from "@aihxm/shared-types";

export class RecordJobHistoryDto {
  @IsIn(["hire", "promotion", "transfer", "salary_change", "termination", "rehire", "other"])
  eventType!: JobHistoryEventType;

  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  designation?: string;

  @IsOptional()
  @IsString()
  salaryBand?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UploadEmployeeDocumentDto {
  @IsString()
  documentType!: string;
}
