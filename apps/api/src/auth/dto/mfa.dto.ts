import { IsString, Length } from "class-validator";

export class MfaEnrollConfirmDto {
  @IsString()
  mfaTicket!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class MfaVerifyDto {
  @IsString()
  mfaTicket!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
