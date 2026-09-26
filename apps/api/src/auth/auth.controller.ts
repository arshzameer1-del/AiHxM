import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import type { SessionRequestContext } from "./auth.service";
import { StepUpService } from "./step-up.service";
import { CurrentClaims } from "./current-claims.decorator";
import { LoginDto } from "./dto/login.dto";
import { LoginWithEmployeeNumberDto } from "./dto/login-with-employee-number.dto";
import { MfaEnrollConfirmDto, MfaRecoveryCodeVerifyDto, MfaVerifyDto } from "./dto/mfa.dto";
import { StepUpVerifyDto } from "./dto/step-up-verify.dto";
import { PasswordResetConfirmDto, PasswordResetRequestDto } from "./dto/password-reset.dto";
import { SessionGuard } from "./session.guard";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Phase 3 item #8 — the one place a request's real IP/User-Agent are read
 * for the three routes that actually issue a session
 * (mfa/enroll/confirm, mfa/verify, mfa/recovery-code/verify). `req.ip` is
 * already trusted elsewhere in this exact same posture (SessionGuard, IP
 * allow/denylist enforcement) thanks to main.ts's `trust proxy: 1` — this
 * app sits behind exactly one reverse-proxy hop (Render/Netlify), so
 * Express's own X-Forwarded-For handling is what's relied on here rather
 * than reading the header directly, for the identical reason SessionGuard
 * doesn't either. `login`/`login/employee` deliberately do NOT need this:
 * MFA is mandatory, so neither ever issues a session itself — see
 * AuthService.login's own doc comment.
 */
function sessionRequestContext(req: Request): SessionRequestContext {
  return {
    ipAddress: req.ip || null,
    userAgent: req.headers["user-agent"] || null,
  };
}

/**
 * Public — no guard. Every endpoint here is either the pre-authentication
 * flow itself (login, MFA, password reset) or deliberately safe to expose
 * unauthenticated by design (see AuthService for why each one doesn't
 * leak account existence).
 *
 * Every route below overrides the global "default" throttler (100 req/min,
 * app.module.ts) with a much stricter per-route limit. This is a real gap,
 * not defensive boilerplate: AuthService's account lockout only protects a
 * KNOWN account's password (5 failed attempts / 15-min cooldown), so with
 * no per-route limit an attacker could still (a) sweep login attempts
 * across many harvested emails at the global rate, or — the sharper issue —
 * (b) brute-force a 6-digit TOTP code. An mfa_ticket is issued after a
 * correct password and is valid 5 minutes; the code space is only
 * 1,000,000 combinations, and verifyMfa/confirmMfaEnrollment had zero
 * attempt-limiting of their own. 10/min per IP caps an attacker at ~50
 * guesses inside that 5-minute window — infeasible — while staying well
 * above what a real user fat-fingering a code would ever hit. See
 * KNOWN_ISSUES.md for the full writeup.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly stepUp: StepUpService
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  // A tenant's own login page (leadhcm.aihxm.com/login) — see
  // AuthService.loginWithEmployeeNumber's doc comment.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login/employee")
  loginWithEmployeeNumber(@Body() dto: LoginWithEmployeeNumberDto) {
    return this.auth.loginWithEmployeeNumber(dto.companySlug, dto.employeeNumber, dto.password);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("mfa/enroll/confirm")
  confirmMfaEnrollment(@Body() dto: MfaEnrollConfirmDto, @Req() req: Request) {
    return this.auth.confirmMfaEnrollment(dto.mfaTicket, dto.code, sessionRequestContext(req));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("mfa/verify")
  verifyMfa(@Body() dto: MfaVerifyDto, @Req() req: Request) {
    return this.auth.verifyMfa(dto.mfaTicket, dto.code, sessionRequestContext(req));
  }

  // Same throttle as mfa/verify — a recovery code is just an alternate
  // credential for the identical login step (see AuthService's doc comment),
  // and each code is single-use regardless, so there's no extra guessing
  // surface this needs a tighter limit for.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("mfa/recovery-code/verify")
  verifyMfaRecoveryCode(@Body() dto: MfaRecoveryCodeVerifyDto, @Req() req: Request) {
    return this.auth.verifyMfaRecoveryCode(dto.mfaTicket, dto.code, sessionRequestContext(req));
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("password-reset/request")
  requestPasswordReset(@Body() dto: PasswordResetRequestDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("password-reset/confirm")
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto) {
    await this.auth.confirmPasswordReset(dto.token, dto.newPassword);
    return { message: "Password updated. Sign in with your new password." };
  }

  /**
   * Decision #13 — the one guarded (not public) route in this controller.
   * Any real session (SessionGuard, not PlatformAdminGuard) can call this;
   * it never grants anything, only describes the caller's own session for
   * the frontend's role-aware portal shell.
   */
  @UseGuards(SessionGuard)
  @Get("me")
  me(@CurrentClaims() claims: RequestClaims) {
    return this.auth.me(claims);
  }

  // Phase 2 gap-fill item #2 — step-up re-authentication. Any real
  // session (SessionGuard, not just Platform Admin — the mechanism is
  // generic even though today's @RequireStepUp() routes are all
  // Platform-Admin-only) can call this to (re-)verify its own second
  // factor; StepUpGuard is what actually gates a sensitive route on
  // having done so recently. Same throttle as the other MFA-code routes,
  // for the same reason (a 6-digit TOTP code is a small guessing space).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(SessionGuard)
  @Post("step-up")
  verifyStepUp(@CurrentClaims() claims: RequestClaims, @Body() dto: StepUpVerifyDto) {
    return this.stepUp.verify(claims, dto);
  }
}
