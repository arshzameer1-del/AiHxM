import { IsString, MinLength } from "class-validator";

export class FulfillDataSubjectRequestDto {
  @IsString()
  @MinLength(1)
  fulfillmentNote!: string;
}
