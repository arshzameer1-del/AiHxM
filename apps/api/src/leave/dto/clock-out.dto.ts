import { IsString, MinLength } from "class-validator";

export class ClockOutDto {
  @IsString()
  @MinLength(1)
  employeeNumber!: string;
}
