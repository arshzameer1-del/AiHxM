import { IsString, MaxLength, MinLength } from "class-validator";

export class RejectConfigurationChangeRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}
