import { IsObject, IsString, MinLength } from "class-validator";

export class CreateDocumentTemplateDto {
  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  objectKey!: string;

  @IsString()
  @MinLength(1)
  templateBody!: string;
}

export class RenderDocumentDto {
  @IsString()
  @MinLength(1)
  templateKey!: string;

  @IsObject()
  record!: Record<string, unknown>;
}
