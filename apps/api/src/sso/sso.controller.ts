import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { SsoService } from "./sso.service";

/**
 * Phase 3 item #1 — no `@UseGuards` anywhere in this file, same posture
 * as `public-branding.controller.ts` and `auth.controller.ts`'s own
 * public routes: every route here runs BEFORE any session exists by
 * definition (this IS the login flow). `@Throttle` for the same
 * per-route-not-per-session reason those files already document.
 */
@Controller()
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("public/tenants/:slug/sso")
  getPublicStatus(@Param("slug") slug: string) {
    return this.sso.getPublicStatus(slug.toLowerCase());
  }

  /** A real browser navigation (an `<a href>`, never a `fetch()`), so this 302s rather than returning JSON. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("auth/sso/:companySlug/login")
  async login(@Param("companySlug") companySlug: string, @Res() res: Response) {
    const url = await this.sso.buildAuthorizationUrl(companySlug.toLowerCase());
    res.redirect(url);
  }

  /**
   * The one redirect URI registered with every tenant's IdP — deliberately
   * NOT company-slug-scoped in its own path, because the company is
   * recovered from the signed state ticket the IdP echoes back (see
   * `SsoStateTicketPayload`), not from the URL. This keeps one static
   * "Redirect URI" value in this codebase's own docs/`.env.production.
   * example` for every tenant to register with their IdP, instead of a
   * different one per company that would need reconfiguring on a slug
   * rename.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("auth/sso/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response
  ) {
    const { redirectTo } = await this.sso.handleCallback({ code, state, error, error_description: errorDescription });
    res.redirect(redirectTo);
  }
}
