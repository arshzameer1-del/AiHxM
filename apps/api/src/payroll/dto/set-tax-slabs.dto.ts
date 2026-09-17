import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, ValidateNested } from "class-validator";
import { TaxSlabDto } from "./tax-slab.dto";

export class SetTaxSlabsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxSlabDto)
  slabs!: TaxSlabDto[];
}
