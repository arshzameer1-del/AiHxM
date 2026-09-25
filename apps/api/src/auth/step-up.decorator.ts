import { SetMetadata } from "@nestjs/common";

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. Marks a route (or
 * every route on a controller) as requiring a recent `POST /auth/step-up`
 * grant, checked by StepUpGuard. Purely additive metadata: a route with no
 * `@RequireStepUp()` is completely unaffected by StepUpGuard being present
 * in its guard chain (see StepUpGuard's own doc comment).
 */
export const REQUIRE_STEP_UP = "requireStepUp";
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP, true);
