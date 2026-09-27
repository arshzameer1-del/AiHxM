import { IsInt, IsObject, IsOptional, Min } from "class-validator";

export class SaveHireProcessCardDto {
  @IsObject()
  data!: Record<string, unknown>;

  /** Omit only on a card's very first save — see HiringProcessService.saveCard()'s own doc comment. */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
