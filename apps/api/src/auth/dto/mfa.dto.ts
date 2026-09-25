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

// Recovery codes render as "ABCDE-FGHJK" (mfa-recovery-codes.util.ts) — 11
// characters including the dash. Length isn't pinned tighter than that
// because normalizeRecoveryCode() also accepts stray leading/trailing
// whitespace from a hand-typed/pasted code, trimmed before the length would
// matter for a real code; anything else just fails the hash comparison.
export class MfaRecoveryCodeVerifyDto {
  @IsString()
  mfaTicket!: string;

  @IsString()
  @Length(1, 32)
  code!: string;
}
