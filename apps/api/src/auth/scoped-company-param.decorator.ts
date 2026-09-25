import { SetMetadata } from "@nestjs/common";

/**
 * Phase 2 gap-fill item #7 — Platform Admin delegation ('scoped' access
 * level). Applied at the CONTROLLER-class level (Nest's Reflector reads
 * class metadata the same way it reads handler metadata) rather than
 * per-method, because almost every Tenant Management controller is
 * already mounted under a single `platform/companies/:companyId/...` (or
 * CompaniesController's own `:id`) prefix — one line per controller
 * class is enough to cover every route in it, instead of decorating
 * dozens of individual handlers.
 *
 * `paramName` names the route param PlatformAdminGuard should read as the
 * target company id for that controller. A controller with no company-id
 * param at all (creating a new tenant, managing the platform admin
 * roster, saved-views search) is simply left undecorated — scoping has
 * nothing to check there, which is the correct behavior, not a gap.
 */
export const SCOPED_COMPANY_PARAM = "scopedCompanyParam";
export const ScopedCompanyParam = (paramName: string) => SetMetadata(SCOPED_COMPANY_PARAM, paramName);
