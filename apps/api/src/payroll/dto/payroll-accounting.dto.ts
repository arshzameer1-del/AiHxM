import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class UpsertGlMappingDto {
  @IsIn(["component_key", "category", "special"]) matchType!: "component_key" | "category" | "special";
  @IsString() @MinLength(1) @MaxLength(120) matchValue!: string;
  @IsOptional() @IsString() @MaxLength(60) debitAccountCode?: string | null;
  @IsOptional() @IsString() @MaxLength(60) creditAccountCode?: string | null;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateJournalTypeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(12) numberPrefix?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GenerateJournalDto {
  @IsOptional() @IsDateString() postingDate?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class PostJournalDto {
  @IsOptional() @IsString() @MaxLength(120) postingReference?: string;
}

export class ReverseJournalDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
