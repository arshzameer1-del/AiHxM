import { IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

export class ChangePasswordDto {
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MinLength(10, { message: "newPassword must be at least 10 characters" })
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
