import { ArrayNotEmpty, IsArray, IsUUID } from "class-validator";

export class ReorderHrReferenceCatalogItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID("4", { each: true })
  orderedIds!: string[];
}
