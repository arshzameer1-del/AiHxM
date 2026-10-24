import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccountSecurityService } from "./account-security.service";
import { CurrentClaims } from "./current-claims.decorator";
import { ChangePasswordDto, MfaConfirmDto, MfaFactorDto } from "./dto/account-security.dto";
import { SessionGuard } from "./session.guard";
import type { RequestClaims } from "../database/tenant-context";

/** BACKLOG51 - the signed-in person's own login: password, authenticator, recovery codes, where they are signed in. */
@Controller("auth/account")
@UseGuards(SessionGuard)
export class AccountSecurityController {
  constructor(private readonly security: AccountSecurityService) {}

  @Get("security")
  status(@CurrentClaims() claims: RequestClaims) {
    return this.security.status(claims);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("password")
  changePassword(@CurrentClaims() claims: RequestClaims, @Body() dto: ChangePasswordDto) {
    return this.security.changePassword(claims, dto.currentPassword, dto.newPassword);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("mfa/start")
  startReenroll(@CurrentClaims() claims: RequestClaims, @Body() dto: MfaFactorDto) {
    return this.security.startReenroll(claims, dto.password, dto.code);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("mfa/confirm")
  confirmReenroll(@CurrentClaims() claims: RequestClaims, @Body() dto: MfaConfirmDto) {
    return this.security.confirmReenroll(claims, dto.code);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("mfa/recovery-codes")
  regenerateRecoveryCodes(@CurrentClaims() claims: RequestClaims, @Body() dto: MfaFactorDto) {
    return this.security.regenerateRecoveryCodes(claims, dto.password, dto.code);
  }

  @Get("sessions")
  sessions(@CurrentClaims() claims: RequestClaims) {
    return this.security.sessions(claims);
  }

  @Post("sessions/sign-out-others")
  signOutOthers(@CurrentClaims() claims: RequestClaims) {
    return this.security.signOutOtherSessions(claims);
  }

  @Delete("sessions/:id")
  async signOutOne(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.security.signOutSession(claims, id);
    return { message: "Signed out." };
  }
}
