import { IsStrongPassword } from "../password-policy";
import { IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

export class ChangePasswordDto {
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @IsStrongPassword()
  @MaxLength(200)
  newPassword!: string;
}

/** The current password, plus the code from the current authenticator when one is set up. */
export class MfaFactorDto {
  @IsString()
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  code?: string;
}

export class MfaConfirmDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
