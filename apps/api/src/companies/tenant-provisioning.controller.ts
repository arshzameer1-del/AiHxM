import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { TestInvitationResult } from "@aihxm/shared-types";
import { CompaniesService } from "./companies.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";

class CheckAvailabilityDto {
  @IsString()
  @MaxLength(80)
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customDomain?: string;
}

class TestInvitationDto {
  @IsString()
  @MaxLength(200)
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;
}

/**
 * The Create Tenant wizard's support endpoints (TM-008/009/010) — none
 * of these are scoped to an existing company (there is no draft-tenant
 * concept in this codebase; see CompaniesService.checkAvailability's own
 * doc comment), so they live outside `/platform/companies/:id/...`
 * rather than being bolted onto CompaniesController.
 */
@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class TenantProvisioningController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly entitlements: EntitlementsService,
    private readonly mailer: MailerService
  ) {}

  @Get("package-tiers")
  listPackageTiers(@CurrentClaims() claims: RequestClaims) {
    return this.entitlements.listPackageTiers(claims);
  }

  @Get("module-catalog")
  listModuleCatalog(@CurrentClaims() claims: RequestClaims) {
    return this.entitlements.listCatalog(claims);
  }

  @Post("tenant-availability")
  checkAvailability(@CurrentClaims() claims: RequestClaims, @Body() dto: CheckAvailabilityDto) {
    return this.companies.checkAvailability(claims, dto);
  }

  /**
   * TM-009 — "Send Test Invitation." Real delivery through the same
   * MailerService AuthService's password-reset flow uses, honest about
   * whether SMTP is even configured rather than pretending success (see
   * NotificationsService's own "logged, not delivered" precedent) —
   * there's no tenant/admin row to persist yet at this point in the
   * wizard, so nothing is written to `notification_log` here.
   */
  @Post("test-invitations")
  async sendTestInvitation(@Body() dto: TestInvitationDto): Promise<TestInvitationResult> {
    if (!this.mailer.isConfigured()) {
      return { sent: false, reason: "Email delivery is not configured in this environment (no SMTP_HOST set)." };
    }
    try {
      await this.mailer.sendMail({
        to: dto.email,
        subject: `You're invited to ${dto.companyName ?? "your new AIHXM workspace"}`,
        text: [
          `Hi ${dto.fullName},`,
          "",
          `This is a preview of the invitation email an administrator will receive once ${
            dto.companyName ?? "this tenant"
          } is created.`,
        ].join("\n"),
      });
      return { sent: true };
    } catch (err) {
      return { sent: false, reason: (err as Error).message };
    }
  }
}
