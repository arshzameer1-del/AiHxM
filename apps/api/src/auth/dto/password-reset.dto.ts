import { IsEmail, IsString, MinLength } from "class-validator";

export class PasswordResetRequestDto {
  @IsEmail()
  email!: string;
}

export class PasswordResetConfirmDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(10, { message: "newPassword must be at least 10 characters" })
  newPassword!: string;
}
