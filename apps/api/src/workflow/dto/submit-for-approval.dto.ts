import { IsIn, IsObject, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

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
}

export class ApprovalDecisionDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @IsOptional()
  @IsString()
  comment?: string;
}
