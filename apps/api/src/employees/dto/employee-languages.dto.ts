import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { LanguageLevel } from "@aihxm/shared-types";

const LEVELS: LanguageLevel[] = ["basic", "conversational", "fluent", "native"];

export class CreateEmployeeLanguageDto {
  @IsUUID() employeeId!: string;
  @IsString() @MaxLength(60) language!: string;
  @IsOptional() @IsIn(LEVELS) spokenLevel?: LanguageLevel;
  @IsOptional() @IsIn(LEVELS) writtenLevel?: LanguageLevel;
}

export class UpdateEmployeeLanguageDto {
  @IsOptional() @IsString() @MaxLength(60) language?: string;
  @IsOptional() @IsIn(LEVELS) spokenLevel?: LanguageLevel;
  @IsOptional() @IsIn(LEVELS) writtenLevel?: LanguageLevel;
}
