import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";

// Phase 3 item #4 — Webhooks & Eventing. Admin-facing delivery log,
// manual replay, and a "send test event" convenience — the delivery
// engine itself (enqueue/sweep/backoff) lives in WebhookDispatchService,
// imported here via WebhooksModule the same way IntegrationsController
// sits alongside (but doesn't own) the `webhook` provider row's own
// config it targets.
@Controller("platform/companies/:companyId/webhook-events")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class WebhooksAdminController {
  constructor(private readonly webhooks: WebhookDispatchService) {}

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Query("limit") limit?: string
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.webhooks.list(claims, companyId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  // Replaying a delivery only re-sends data the tenant's own endpoint
  // already expects — no secret is issued or exposed, so this
  // deliberately does NOT require step-up, unlike IntegrationsController's
  // rotateSecret.
  @Post(":eventId/replay")
  replay(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("eventId") eventId: string
  ) {
    return this.webhooks.replay(claims, companyId, eventId);
  }

  @Post("test")
  sendTestEvent(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.webhooks.sendTestEvent(claims, companyId);
  }
}
