import { IsStrongPassword } from "../password-policy";
import { IsEmail, IsString, MinLength } from "class-validator";

export class PasswordResetRequestDto {
  @IsEmail()
  email!: string;
}

export class PasswordResetConfirmDto {
  @IsString()
  token!: string;

  @IsString()
  @IsStrongPassword()
  newPassword!: string;
}
