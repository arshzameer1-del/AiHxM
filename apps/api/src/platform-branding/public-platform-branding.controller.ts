import { Controller, Get, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { PlatformBrandingService } from "./platform-branding.service";

/**
 * No `@UseGuards` — deliberately, same reasoning as
 * public-branding.controller.ts. This has to load on the default (no
 * tenant) /login page before anyone has a session, AND on every tenant's
 * own subdomain login page for the "Powered by AIHXM" credit, so it can
 * never be behind auth. `@Throttle` for the same reason every other public
 * route in this codebase has one — no session-based rate limiting is
 * possible pre-auth.
 */
@Controller("public/platform-branding")
export class PublicPlatformBrandingController {
  constructor(private readonly branding: PlatformBrandingService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  getBranding() {
    return this.branding.getBranding();
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("logo/asset")
  async getLogoAsset(@Res() res: Response) {
    const { buffer, mimeType } = await this.branding.downloadLogoAsset();
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", "inline");
    // Every page load of every login screen on the platform hits this —
    // aggressive caching matters here more than for a single tenant's own
    // logo. A re-upload gets a new storagePath (uploadLogo never
    // overwrites in place), so a cached response is never stale in a way
    // that matters.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  }
}
