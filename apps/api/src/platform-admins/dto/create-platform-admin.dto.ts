import { IsEmail, IsString, MinLength } from "class-validator";

export class CreatePlatformAdminDto {
  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10, { message: "initialPassword must be at least 10 characters" })
  initialPassword!: string;
}
