import { IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { WorkflowPriority } from "@aihxm/shared-types";

export class SubmitForApprovalDto {
  @IsString()
  @MinLength(1)
  templateKey!: string;

  @IsString()
  @MinLength(1)
  objectKey!: string;

  @IsUUID()
  recordId!: string;

  @IsObject()
  record!: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  subjectUserAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsIn(["low", "normal", "high", "urgent"])
  priority?: WorkflowPriority;

  @IsOptional()
  @IsDateString()
  dueAt?: string;
}

export class ApprovalDecisionDto {
  @IsIn(["approved", "rejected", "send_back"])
  decision!: "approved" | "rejected" | "send_back";

  @IsOptional()
  @IsString()
  comment?: string;
}
