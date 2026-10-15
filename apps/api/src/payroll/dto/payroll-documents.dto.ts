import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

const TYPES = ["payslip", "tax_certificate", "salary_certificate"] as const;

export class TemplateChoiceDto {
  @IsIn(TYPES) documentType!: (typeof TYPES)[number];
  @IsOptional() @IsString() @MaxLength(120) templateKey!: string | null;
}

export class UpdateDocumentSettingsDto {
  @IsOptional() @IsBoolean() requirePublication?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateChoiceDto) templateChoices?: TemplateChoiceDto[];
}

export class GenerateRunPayslipsDto {
  @IsOptional() @IsBoolean() replace?: boolean;
  @IsOptional() @IsBoolean() publish?: boolean;
}

export class RunPublicationDto {
  @IsBoolean() published!: boolean;
}

export class GenerateTaxCertificateDto {
  @IsUUID() employeeId!: string;
  @IsInt() @Min(2000) @Max(2200) taxYear!: number;
}

export class GenerateSalaryCertificateDto {
  @IsUUID() employeeId!: string;
  @IsOptional() @IsString() @MaxLength(200) addressedTo?: string;
  @IsOptional() @IsString() @MaxLength(300) purpose?: string;
}

export class RevokeDocumentDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
