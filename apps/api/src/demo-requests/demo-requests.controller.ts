import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { DemoRequestStatus } from "@aihxm/shared-types";
import { DemoRequestsService } from "./demo-requests.service";
import { CreateDemoRequestDto, DEMO_STATUSES, UpdateDemoRequestDto } from "./dto/demo-request.dto";

/** Public: the marketing site's "Book a demo" form posts here. Unauthenticated by design, so it is rate-limited and has a honeypot. */
@Controller("public/demo-requests")
export class PublicDemoRequestsController {
  constructor(private readonly demos: DemoRequestsService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  submit(@Body() dto: CreateDemoRequestDto, @Req() req: Request) {
    return this.demos.submit(dto, req.ip);
  }
}

/** Platform Admin only: see and work through the requests the website collected. */
@Controller("platform/demo-requests")
@UseGuards(PlatformAdminGuard)
export class PlatformDemoRequestsController {
  constructor(private readonly demos: DemoRequestsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string, @Query("limit") limit?: string) {
    const s = DEMO_STATUSES.includes(status as DemoRequestStatus) ? (status as DemoRequestStatus) : undefined;
    return this.demos.list(claims, { status: s, limit: limit ? Number(limit) || undefined : undefined });
  }

  @Patch(":id")
  update(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDemoRequestDto
  ) {
    return this.demos.update(claims, id, dto);
  }
}
