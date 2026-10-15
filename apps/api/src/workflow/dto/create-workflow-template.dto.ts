import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import type { ApproverType, WorkflowApprovalMode, WorkflowFieldCondition } from "@aihxm/shared-types";

const APPROVER_TYPES: ApproverType[] = ["role", "specific_user", "manager_of_submitter", "org_unit_head", "dotted_line_manager", "position", "group"];

export class WorkflowApproverConfigDto {
  @IsIn(APPROVER_TYPES)
  approverType!: ApproverType;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsUUID()
  userAccountId?: string;

  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsOptional()
  @IsUUID()
  employeeGroupId?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  // An escalation target is always a fixed role or a specific person.
  @IsOptional()
  @IsIn(["role", "specific_user"])
  escalationApproverType?: "role" | "specific_user";

  @IsOptional()
  @IsUUID()
  escalationRoleId?: string;

  @IsOptional()
  @IsUUID()
  escalationUserAccountId?: string;
}

export class WorkflowStepConfigDto {
  @IsInt()
  @Min(1)
  stepOrder!: number;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsObject()
  condition?: WorkflowFieldCondition | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  slaHours?: number;

  @IsOptional()
  @IsIn(["all", "any", "quorum"])
  approvalMode?: WorkflowApprovalMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  quorumCount?: number;

  @IsOptional()
  @IsString()
  parallelGroup?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  reminderHours?: number;

  @IsOptional()
  @IsBoolean()
  requireCommentOnReject?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowApproverConfigDto)
  approvers!: WorkflowApproverConfigDto[];
}

export class CreateWorkflowTemplateDto {
  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  objectKey!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  triggerEvent?: string;

  @IsOptional()
  @IsObject()
  startCondition?: WorkflowFieldCondition | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepConfigDto)
  steps!: WorkflowStepConfigDto[];
}

export class UpdateWorkflowTemplateDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  triggerEvent?: string;

  @IsOptional()
  @IsObject()
  startCondition?: WorkflowFieldCondition | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepConfigDto)
  steps!: WorkflowStepConfigDto[];
}
