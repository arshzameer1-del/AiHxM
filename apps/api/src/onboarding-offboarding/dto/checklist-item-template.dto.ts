import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength, ValidateNested } from "class-validator";
import type { ChecklistCategory, ChecklistResponsibleRole, OnboardingAssigneeRule } from "@aihxm/shared-types";

const CATEGORIES: ChecklistCategory[] = ["it", "hr", "finance", "facilities", "general"];
const RESPONSIBLE_ROLES: ChecklistResponsibleRole[] = ["self", "team", "all"];
const ASSIGNEE_RULES: OnboardingAssigneeRule[] = ["none", "employee", "manager"];

export class OnboardingApplicabilityDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  employmentTypes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  orgUnitIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  locationIds?: string[];
}

export class CreateChecklistItemTemplateDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsIn(CATEGORIES)
  category!: ChecklistCategory;

  @IsIn(RESPONSIBLE_ROLES)
  responsibleRole!: ChecklistResponsibleRole;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardingApplicabilityDto)
  applicability?: OnboardingApplicabilityDto;

  @IsOptional()
  @IsIn(ASSIGNEE_RULES)
  assigneeRule?: OnboardingAssigneeRule;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  dueOffsetDays?: number | null;
}

export class UpdateChecklistItemTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsIn(CATEGORIES)
  category?: ChecklistCategory;

  @IsOptional()
  @IsIn(RESPONSIBLE_ROLES)
  responsibleRole?: ChecklistResponsibleRole;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardingApplicabilityDto)
  applicability?: OnboardingApplicabilityDto;

  @IsOptional()
  @IsIn(ASSIGNEE_RULES)
  assigneeRule?: OnboardingAssigneeRule;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  dueOffsetDays?: number | null;
}
