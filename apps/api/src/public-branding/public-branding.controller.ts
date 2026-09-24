import { BadRequestException, Controller, Get, Param, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { PublicBrandingService } from "./public-branding.service";

type PublicAssetSlot = "logo" | "login-background";
const PUBLIC_ASSET_SLOTS: PublicAssetSlot[] = ["logo", "login-background"];

function parsePublicSlot(value: string): PublicAssetSlot {
  if (!PUBLIC_ASSET_SLOTS.includes(value as PublicAssetSlot)) {
    throw new BadRequestException(`Unknown branding slot "${value}"`);
  }
  return value as PublicAssetSlot;
}

/**
 * No `@UseGuards` anywhere in this file, deliberately — a tenant's own
 * login page (leadhcm.aihxm.com/login) has to load this before anyone has
 * a session, exactly like `/auth/login` and `/signup` are already
 * reachable with no guard. `@Throttle` on every route for the same reason
 * auth.controller.ts throttles its own public routes: no session-based
 * rate limiting is possible pre-auth, so the per-IP default alone
 * (ThrottlerModule.forRoot in app.module.ts) isn't enough of a floor for
 * something reachable by anyone on the internet.
 */
@Controller("public/tenants")
export class PublicBrandingController {
  constructor(private readonly branding: PublicBrandingService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(":slug/branding")
  getBranding(@Param("slug") slug: string) {
    return this.branding.getBranding(slug.toLowerCase());
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(":slug/branding/:slot/asset")
  async getBrandingAsset(@Param("slug") slug: string, @Param("slot") slot: string, @Res() res: Response) {
    const { buffer, mimeType } = await this.branding.getBrandingAsset(slug.toLowerCase(), parsePublicSlot(slot));
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", "inline");
    // Public, cosmetic, and immutable in practice (a re-upload is a new
    // storagePath, never an overwrite in place — see
    // CompaniesService.uploadBrandingAsset) — safe for a browser/CDN to
    // cache aggressively rather than re-fetching on every login-page load.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  }
}
