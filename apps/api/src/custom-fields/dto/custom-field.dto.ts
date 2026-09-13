import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { CustomFieldType } from "@boostfactor/shared-types";

export class DefineCustomFieldDto {
  @IsString()
  @MinLength(1)
  objectKey!: string;

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

export class SetCustomFieldValueDto {
  @IsString()
  @MinLength(1)
  objectKey!: string;

  @IsString()
  @MinLength(1)
  recordId!: string;

  @IsString()
  @MinLength(1)
  fieldKey!: string;

  // No stronger type constraint than "decorated at all" (needed so the
  // global ValidationPipe's `whitelist: true` doesn't strip it) — the
  // legal shape of `value` depends entirely on the field's own
  // fieldType, which CustomFieldsService checks at write time, not here.
  @IsOptional()
  value?: unknown;
}
