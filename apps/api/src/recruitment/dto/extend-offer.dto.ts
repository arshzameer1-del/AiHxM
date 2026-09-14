import { IsDateString, IsNumber, IsUUID, Min } from "class-validator";

export class ExtendOfferDto {
  @IsUUID()
  applicationId!: string;

  @IsNumber()
  @Min(1)
  salary!: number;

  @IsDateString()
  startDate!: string;
}
