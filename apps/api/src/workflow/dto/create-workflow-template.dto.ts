import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
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

export class WorkflowApproverConfigDto {
  @IsIn(["role", "specific_user", "manager_of_submitter"])
  approverType!: "role" | "specific_user" | "manager_of_submitter";

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsUUID()
  userAccountId?: string;

  // Deliberately NOT "manager_of_submitter" — escalating to "the
  // manager's manager" is unbuilt scope (see KNOWN_ISSUES.md); an
  // escalation target is always a fixed role or a specific person.
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
  condition?: { field: string; equals: unknown } | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  slaHours?: number;

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

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepConfigDto)
  steps!: WorkflowStepConfigDto[];
}
