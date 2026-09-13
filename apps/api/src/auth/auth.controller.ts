import { Body, Controller, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { MfaEnrollConfirmDto, MfaVerifyDto } from "./dto/mfa.dto";
import { PasswordResetConfirmDto, PasswordResetRequestDto } from "./dto/password-reset.dto";

/**
 * Public — no guard. Every endpoint here is either the pre-authentication
 * flow itself (login, MFA, password reset) or deliberately safe to expose
 * unauthenticated by design (see AuthService for why each one doesn't
 * leak account existence).
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post("mfa/enroll/confirm")
  confirmMfaEnrollment(@Body() dto: MfaEnrollConfirmDto) {
    return this.auth.confirmMfaEnrollment(dto.mfaTicket, dto.code);
  }

  @Post("mfa/verify")
  verifyMfa(@Body() dto: MfaVerifyDto) {
    return this.auth.verifyMfa(dto.mfaTicket, dto.code);
  }

  @Post("password-reset/request")
  requestPasswordReset(@Body() dto: PasswordResetRequestDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @Post("password-reset/confirm")
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto) {
    await this.auth.confirmPasswordReset(dto.token, dto.newPassword);
    return { message: "Password updated. Sign in with your new password." };
  }
}
