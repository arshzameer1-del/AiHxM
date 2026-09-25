import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthedRequest } from "./platform-admin.guard";
import { SessionSecurityService } from "./session-security.service";
import { REQUIRE_STEP_UP } from "./step-up.decorator";

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. Applied ALONGSIDE
 * PlatformAdminGuard/SessionGuard, never instead of either — e.g.
 * `@UseGuards(PlatformAdminGuard, StepUpGuard)` — and relies on
 * `req.claims.sessionId` already being set by whichever of those ran
 * first: NestJS runs the guards listed in `@UseGuards()` in order, against
 * the same request object, so this always sees claims already populated
 * by the time it runs.
 *
 * A no-op on any route without `@RequireStepUp()` (the common case —
 * every route this doesn't decorate is completely unaffected by having
 * this guard present in a controller's chain), so it's safe to add to a
 * controller's guard list once and opt individual sensitive routes in
 * with the decorator, rather than needing a per-controller decision.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly sessionSecurity: SessionSecurityService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_STEP_UP, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const sessionId = req.claims?.sessionId;
    // No `jti` at all (a token minted before sessions/step-up existed)
    // can never be step-up verified — fail closed on a sensitive route
    // rather than silently letting an un-trackable session through.
    if (!sessionId || !(await this.sessionSecurity.hasRecentStepUp(sessionId))) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "step_up_required",
        message: "This action requires you to re-confirm your identity. Please verify with your authenticator app.",
      });
    }
    return true;
  }
}
