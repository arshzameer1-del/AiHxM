import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateEmployeeNumberPolicyDto {
  @IsOptional()
  @IsIn(["hire", "draft", "save", "approval"])
  generationTiming?: "hire" | "draft" | "save" | "approval";

  @IsOptional()
  @IsIn(["never", "yearly"])
  resetPolicy?: "never" | "yearly";

  @IsOptional()
  @IsBoolean()
  allowManual?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  manualPattern?: string;
}
