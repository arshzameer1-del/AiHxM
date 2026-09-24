import { IsIn, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";
import type { ChecklistCategory, ChecklistResponsibleRole } from "@aihxm/shared-types";

const CATEGORIES: ChecklistCategory[] = ["it", "hr", "finance", "facilities", "general"];
const RESPONSIBLE_ROLES: ChecklistResponsibleRole[] = ["self", "team", "all"];

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
}
