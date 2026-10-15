import { ArrayMinSize, IsArray, IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class InboxDecisionDto {
  @IsIn(["approved", "rejected", "send_back", "request_info", "delegate"])
  decision!: "approved" | "rejected" | "send_back" | "request_info" | "delegate";

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @IsOptional()
  @IsUUID()
  delegateToUserAccountId?: string;
}

export class WorkflowCommentDto {
  @IsString()
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsIn(["participants", "approvers"])
  visibility?: "participants" | "approvers";
}

export class ResubmitDto {
  @IsOptional()
  @IsObject()
  record?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;
}

export class CancelWorkflowDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;
}

export class AttachmentVisibilityDto {
  @IsOptional()
  @IsIn(["participants", "approvers"])
  visibility?: "participants" | "approvers";
}

export class CreateDelegationDto {
  @IsUUID()
  delegateUserAccountId!: string;

  @IsOptional()
  @IsUUID()
  delegatorUserAccountId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  scopeObjectKeys?: string[];

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsDateString()
  validTo!: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class SetTemplateActiveDto {
  @IsIn([true, false])
  isActive!: boolean;
}
