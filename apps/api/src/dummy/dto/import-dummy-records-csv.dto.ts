import { IsUUID, MinLength } from "class-validator";
import { IsString } from "class-validator";

export class ImportDummyRecordsCsvDto {
  @IsUUID()
  companyId!: string;

  @IsString()
  @MinLength(1)
  csv!: string;
}
