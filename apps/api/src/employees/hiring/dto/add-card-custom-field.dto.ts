import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { CustomFieldType } from "@aihxm/shared-types";

/** Hiring Card Field Configuration (2026-09-27) — "add custom field" on ONE card. Same shape as `DefineCustomFieldDto` minus `objectKey` (the card supplies that — see `hiringCardObjectKey()`). */
export class AddCardCustomFieldDto {
  @IsString()
  @MinLength(1)
  fieldKey!: string;

  @IsString()
  @MinLength(1)
  label!: string;

  @IsIn(["text", "number", "boolean", "date", "select"])
  fieldType!: CustomFieldType;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  options?: string[];

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}
