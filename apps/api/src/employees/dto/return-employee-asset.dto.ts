import { IsDateString, IsOptional } from "class-validator";

export class ReturnEmployeeAssetDto {
  @IsOptional()
  @IsDateString()
  returnedDate?: string;
}
