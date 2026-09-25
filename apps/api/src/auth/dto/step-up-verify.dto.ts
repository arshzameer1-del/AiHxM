import { IsOptional, IsString, Length } from "class-validator";

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. Both fields are
 * optional at the DTO level (class-validator has no clean built-in
 * "exactly one of" rule); StepUpService itself throws BadRequestException
 * when neither is present, the same "validated in the service, not the
 * DTO" shape this codebase already uses wherever a request needs an
 * either/or field.
 */
export class StepUpVerifyDto {
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totpCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  recoveryCode?: string;
}
