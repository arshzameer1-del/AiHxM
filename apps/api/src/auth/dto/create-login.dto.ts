import { IsString, MinLength } from "class-validator";

export class CreateLoginDto {
  @IsString()
  @MinLength(10, { message: "initialPassword must be at least 10 characters" })
  initialPassword!: string;
}
