/**
 * Shared TypeScript types across apps/api and apps/web.
 *
 * Phase 2 adds the Platform Provisioning Panel's domain shapes. These are
 * hand-written rather than generated from a schema (Decision #2 dropped
 * Prisma), so when a migration changes a table shape, update the matching
 * type here in the same PR — there is no build step that would catch the
 * two drifting apart.
 */

export type HealthStatus = {
  status: "ok" | "degraded" | "down";
  service: string;
  phase: string;
  timestamp: string;
};

// --- Module catalog -----------------------------------------------------
// The nine real modules from the prototype, plus `dummy` — Phase 5's
// scaffolding module (see apps/api/migrations/0006_module_entitlement.sql
// header), included here so the existing Company Config "Modules" screen
// can toggle it through the real UI with no separate mechanism. Real
// per-tenant licensing now exists (module_catalog / package_tier /
// package_tier_modules / tenant_module_entitlement, migration 0006) —
// CompanyConfig.enabledModules below is a live view over
// tenant_module_entitlement, not a value anyone sets directly anymore.
export const MODULE_KEYS = [
  "employee",
  "leave",
  "recruitment",
  "performance",
  "payroll",
  "succession",
  "learning",
  "exit",
  "bi",
  // UI re-skin ESS build-out (2026-10, Part 2 category 6) — the one
  // module this list was missing versus what the design spec documents
  // as a real ESS category. See apps/api/migrations/0115_expense_management.sql.
  "expense",
  "dummy",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type PackageTier = "starter" | "growth" | "professional" | "enterprise";

// "locked"/"archived"/"draft" added for the Tenant Management module
// (TM-030 Tenant Lock, TM-037 Lifecycle). "churned" is kept for existing
// data; new code should prefer "archived".
export type CompanyStatus = "draft" | "trial" | "active" | "suspended" | "locked" | "archived" | "churned";

// --- Employee Number format (plan doc Section 5) -------------------------
export type EmployeeNumberFormat = {
  prefix: string;
  padding: number;
  startingSequence: number;
  preserveImportedNumbers: boolean;
};

// TM-015 — asset presence flags rather than raw storage paths (same
// "never leak the internal reference, only whether it's set" posture
// TenantIntegration.hasSecrets uses). The actual bytes are fetched
// through GET /platform/companies/:id/branding/:slot, an authenticated
// stream — see BrandingAssetSlot.
export type BrandingAssetSlot = "logo" | "favicon" | "login-background";

/** Where the logo sits within its own header strip — see `logoBackgroundColor` below. */
export type LogoAlignment = "left" | "center" | "right";
export type HorizontalPosition = "left" | "center" | "right";
export type VerticalPosition = "top" | "center" | "bottom";

export type CompanyBranding = {
  primaryColor?: string;
  secondaryColor?: string;
  hasLogo: boolean;
  hasFavicon: boolean;
  hasLoginBackground: boolean;
  /** Defaults to "left" (the layout every company had before this existed). */
  logoAlignment?: LogoAlignment;
  /** Logo's rendered height in px, both here and on the public login page. Defaults to 32 (the previous hardcoded size). */
  logoHeightPx?: number;
  /** Background color of the strip the logo sits in (distinct from `primaryColor`, which colors buttons/links) — undefined/omitted means "match the card" (white), the previous look. */
  logoBackgroundColor?: string;
  // --- Login page layout (full-page background photo + the sign-in card
  // itself) — distinct from the logo strip settings above. All default to
  // the fixed values the login page always used before these existed
  // (centered background, a 384px/max-w-sm white card, dead center).
  /** CSS object-position X for the uploaded login-background photo. Default "center". */
  loginBackgroundPositionX?: HorizontalPosition;
  /** CSS object-position Y for the uploaded login-background photo. Default "center". */
  loginBackgroundPositionY?: VerticalPosition;
  /** Sign-in card's rendered width in px. Default 384 (the previous hardcoded max-w-sm). */
  loginCardWidthPx?: number;
  /** Where the sign-in card sits horizontally on screen. Default "center". */
  loginCardPosition?: HorizontalPosition;
  /** Sign-in card's background color (before opacity is applied). Default "#FFFFFF". */
  loginCardBackgroundColor?: string;
  /** Sign-in card's background opacity, 0-100. Default 100 (fully solid, the previous look). */
  loginCardOpacity?: number;
};

/**
 * What a tenant's OWN login page (leadhcm.aihxm.com/login, not the shared
 * /login every company used to hit) shows before anyone has a session —
 * the public, no-auth counterpart to CompanyBranding above. Deliberately a
 * narrower shape than CompanyBranding: no `hasFavicon` (not consumed by
 * the login page yet) and it carries `companyName`/`slug` since a public
 * visitor has no other way to know which tenant they're looking at.
 */
export type PublicTenantBranding = {
  slug: string;
  companyName: string;
  primaryColor?: string;
  secondaryColor?: string;
  hasLogo: boolean;
  hasLoginBackground: boolean;
  logoAlignment?: LogoAlignment;
  logoHeightPx?: number;
  logoBackgroundColor?: string;
  loginBackgroundPositionX?: HorizontalPosition;
  loginBackgroundPositionY?: VerticalPosition;
  loginCardWidthPx?: number;
  loginCardPosition?: HorizontalPosition;
  loginCardBackgroundColor?: string;
  loginCardOpacity?: number;
};

/**
 * The platform's OWN logo (migration 0046) — what Layout.tsx's sidebar and
 * the default (non-tenant) login page show instead of a hardcoded mark,
 * and what the small "Powered by AIHXM" credit on a tenant's own
 * subdomain login page renders when present. One row, ever — there is
 * exactly one platform. `GET /public/platform-branding` (no auth) returns
 * this same shape for the public, pre-auth read.
 */
export type PlatformBranding = {
  hasLogo: boolean;
  updatedAt: string;
};

export type Company = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  packageTier: PackageTier;
  createdAt: string;
  updatedAt: string;
  // Tenant Management additions (migration 0042) — all nullable/defaulted
  // so every pre-existing company row reads back cleanly.
  legalName: string | null;
  companyCode: string | null;
  registrationNumber: string | null;
  industry: string | null;
  country: string;
  timezone: string;
  currency: string;
  fiscalYearStartMonth: number;
  customDomain: string | null;
  seatsPurchased: number;
  storageQuotaMb: number;
  statusReason: string | null;
  statusChangedAt: string | null;
  deletionRequestedAt: string | null;
  deletionReason: string | null;
  deletionPurgeAt: string | null;
  // Tenant Management gap-fill Phase 1 item #5 — second-approver rule.
  // `deletionApprovalRequired` is decided once, at request time, from the
  // tenant's employee count (CompaniesService.SECOND_APPROVAL_EMPLOYEE_THRESHOLD);
  // when true, `deletionPurgeAt` above stays null (the grace-period clock
  // hasn't started) until a DIFFERENT Platform Admin approves — see
  // `deletionApprovedBy`/`deletionApprovedAt`. `deletionGraceDays` is the
  // grace period chosen at request time, held here so approving doesn't
  // require re-entering it. `deletionRequestedByEmail` is only populated
  // by `getDetail()` (a LEFT JOIN to resolve the requester's email), so
  // the Danger Zone can tell a different admin "who asked" and hide the
  // Approve action from the requester themselves.
  deletionApprovalRequired: boolean;
  deletionGraceDays: number | null;
  deletionApprovedBy: string | null;
  deletionApprovedAt: string | null;
  deletionRequestedByEmail?: string | null;
};

// Tenant Management gap-fill Phase 1 item #5 — shown before a Platform
// Admin ever submits a deletion request, so "what will this actually
// affect" isn't a guess. `requiresSecondApproval` mirrors exactly what
// `requestDeletion()` itself will decide server-side (same threshold),
// so the UI can warn about the second-approval step up front rather than
// surprising the admin after they've already typed a reason.
export type DeletionImpactPreview = {
  companyId: string;
  employeeCount: number;
  adminCount: number;
  activeIntegrationsCount: number;
  storageUsedMb: number;
  requiresSecondApproval: boolean;
  secondApprovalThresholdEmployees: number;
};

/** Dashboard row — a Company plus display-only figures that aren't real billing data yet. */
export type CompanyDashboardRow = Company & {
  /**
   * Deterministic mock figure, not a real billing integration. Phase 2
   * has no billing system; this exists only so the Dashboard screen the
   * plan doc describes ("all companies, MRR, status") isn't blank. Wire
   * a real value here once billing exists.
   */
  mockMrrUsd: number;
  adminCount: number;
};

export type CompanyConfig = {
  companyId: string;
  branding: CompanyBranding;
  /**
   * Always read fresh from `tenant_module_entitlement` (Phase 5) — the
   * real licensing source of truth `EntitlementsService.isModuleEnabled()`
   * gates on. Setting this via `updateCompanyConfig` writes real
   * entitlement rows, not just a display value.
   */
  enabledModules: ModuleKey[];
  employeeNumberFormat: EmployeeNumberFormat;
  updatedAt: string;
};

export type CompanyAdminStatus = "active" | "locked";

export type CompanyAdmin = {
  id: string;
  companyId: string;
  fullName: string;
  email: string;
  status: CompanyAdminStatus;
  createdAt: string;
  /** Whether a real login (Phase 3 user_accounts row) exists for this admin yet. */
  hasLogin: boolean;
  /** Null until a login exists (hasLogin). Used to target Force Logout (TM-017). */
  userAccountId: string | null;
  /**
   * Platform Admin-chosen identifier (e.g. "LHM_Admin1"), set once when
   * this admin's login is created — see CreateLoginRequest.loginId. Null
   * for admins with no login yet, and for admins whose login predates
   * this field (they still sign in via email on the shared /login page).
   * The SAME value is what that admin types into the identifier field on
   * their company's own /:companySlug/login (AuthService matches it
   * alongside employees.employee_number there).
   */
  loginId: string | null;
  /**
   * Tenant Management gap-fill batch 1, Phase 1 item #3 — mirrors
   * `user_accounts.failed_login_attempts` (AuthService's own lockout
   * counter, `MAX_FAILED_ATTEMPTS = 5`). Always 0 for an admin with no
   * login yet.
   */
  failedLoginAttempts: number;
  /**
   * Mirrors `user_accounts.locked_until` — set once `failedLoginAttempts`
   * crosses AuthService's threshold, cleared automatically by a
   * successful login, a password reset, or the Security tab's "Unlock
   * now" action (CompaniesService.unlockAdminAccount). Null when not
   * currently locked, or when there's no login yet.
   */
  lockedUntil: string | null;
  /**
   * Tenant Management gap-fill Phase 1 item #7 — periodic access-review
   * attestation. Null until a Platform Admin has ever clicked "Mark
   * reviewed" for this admin. Not automatically cleared by other admin
   * changes (status/password/MFA) — a deliberately minimal, additive first
   * pass; a review-invalidation policy can be layered on later without
   * touching this shape.
   */
  lastAccessReviewedAt: string | null;
  lastAccessReviewedBy: string | null;
  /**
   * Tenant Management gap-fill Phase 1 item #8 — Login/invitation
   * lifecycle visibility. AIHXM hands a Platform-Admin-chosen password
   * straight to the admin rather than emailing an accept-link, so there's
   * no separate invitation record — this is computed from whether/when the
   * login has ever actually been used:
   *  - "no_login": no login has been created yet (see `hasLogin`).
   *  - "pending": a login exists, was created/reset recently, and has
   *    never been used to sign in yet.
   *  - "expired": same as "pending", but it's been sitting unused long
   *    enough (7 days) that it's worth re-issuing or revoking.
   *  - "active": has been used to sign in at least once.
   *  - "revoked": never signed in, and a Platform Admin explicitly revoked
   *    it before it was ever used (see `revokeAdminLogin`) — distinct from
   *    the existing manual Lock/Unlock (`status`), which applies to an
   *    established login instead.
   */
  loginStatus: "no_login" | "pending" | "expired" | "active" | "revoked";
  lastLoginAt: string | null;
};

/** TM-002/TM-003 — Tenant Directory search + filters (GET /platform/companies). */
export type CompanyListFilters = {
  search?: string;
  status?: CompanyStatus[];
  packageTier?: PackageTier[];
  country?: string[];
};

export type CompanyDetail = {
  company: Company;
  config: CompanyConfig;
  admins: CompanyAdmin[];
};

export type CreateCompanyRequest = {
  name: string;
  slug: string;
  packageTier?: PackageTier;
  enabledModules?: ModuleKey[];
  employeeNumberFormat?: Partial<EmployeeNumberFormat>;
  initialAdmin?: {
    fullName: string;
    email: string;
  };
  // TM-006/007/008 — the Create Tenant wizard's Company/Business/Domain
  // steps. All optional so `CreateCompanyRequest` stays backward
  // compatible with every existing caller (SignupService's own request
  // shape, tests) that only ever set name/slug/packageTier.
  legalName?: string;
  companyCode?: string;
  registrationNumber?: string;
  industry?: string;
  country?: string;
  timezone?: string;
  currency?: string;
  fiscalYearStartMonth?: number;
  customDomain?: string;
  seatsPurchased?: number;
};

// TM-008 — Domain step's "Check Availability" action.
export type DomainAvailabilityResult = {
  slug: string;
  slugAvailable: boolean;
  customDomain: string | null;
  customDomainAvailable: boolean | null;
};

// TM-010 — Plan selection step. No fabricated pricing: this platform has
// no billing/pricing table yet (see CompanyDashboardRow's mockMrrFor
// comment for the one place a placeholder number is used, and why), so
// this reflects only what's real — the tier's name/description and the
// modules it actually includes by default.
export type PackageTierSummary = {
  key: PackageTier;
  name: string;
  description: string | null;
  includedModuleKeys: ModuleKey[];
};

// TM-009 — "Send Test Invitation": a real email through MailerService
// with no persisted tenant/admin record (there is no tenant yet at this
// point in the wizard). `sent: false` with a reason mirrors
// NotificationsService's own honest "logged, not delivered" behavior
// when SMTP isn't configured, rather than pretending success.
export type TestInvitationResult = {
  sent: boolean;
  reason?: string;
};

/**
 * The public, unauthenticated counterpart of `CreateCompanyRequest` —
 * a prospective customer creating their OWN company and first login,
 * with no Platform Admin in the loop at all. See
 * `apps/api/src/signup/signup.service.ts` for what this actually
 * provisions in one transaction (company, config, entitlements, the
 * admin's login, AND their `hr_admin` role — unlike the Platform-Admin
 * flow, there's no separate human to grant that role afterward).
 */
export type SignupRequest = {
  companyName: string;
  slug?: string;
  packageTier?: PackageTier;
  adminFullName: string;
  adminEmail: string;
  adminPassword: string;
};

export type SignupResponse = {
  companyId: string;
  slug: string;
  packageTier: PackageTier;
};

export type AuditLogEntry = {
  id: string;
  companyId: string | null;
  companyName?: string | null;
  actor: string;
  /** Human-readable actor (name/email) resolved server-side from the raw
   * `actor` id; null when the id is a service identity or no longer resolves. */
  actorLabel?: string | null;
  /** SEC-06 structured fields (null on rows written before migration 0118). */
  actorId?: string | null;
  actorType?: "user" | "platform_admin" | "service" | null;
  correlationId?: string | null;
  sourceChannel?: string | null;
  reason?: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

// Tenant Management gap-fill Phase 1 item #6 — Audit tab search/filter.
// `actor`/`action` are partial (ILIKE) matches, not exact — the audit
// log's `action` values are free-form dot-namespaced strings
// (`company.impersonate`, `company.admin.mfa_reset`, ...) with no fixed
// vocabulary to select from, so a substring filter is what's actually
// usable here. `from`/`to` are inclusive ISO-8601 timestamps.
export type AuditLogFilters = {
  companyId?: string;
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
};

// Tenant Management gap-fill Phase 1 item #4 — "Login As" hardening.
// `sessionId` is the token's real `jti` (a genuine `user_sessions` row,
// same shape as any other login session), which is what makes an
// impersonation session show up in the Security tab's session list and
// be individually end-able via the existing revoke-session endpoint,
// instead of only ever expiring on its own after 30 minutes.
export type ImpersonateRequest = {
  reason: string;
};

export type ImpersonateResponse = {
  token: string;
  sessionId: string;
  expiresAt: string;
  companyId: string;
  companyName: string;
  impersonatedAdminEmail: string;
};

// --- Tenant Management: Sessions (TM-017/029) ----------------------------
// A row in `user_sessions` — see auth/session-security.service.ts for how
// this is actually enforced (jti-based revocation checked in
// PlatformAdminGuard/SessionGuard), not merely stored.
export type UserSessionView = {
  id: string;
  userAccountId: string;
  companyId: string | null;
  isPlatformAdmin: boolean;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  // Phase 3 item #8 — see auth/auth.service.ts's `issueSessionToken` doc
  // comment for the full scoping decision (no geo-IP; these are the two
  // honest, zero-external-data signals computed at session-issuance time).
  // `ipAddress` is included here (not just the two boolean flags) so the
  // Security tab can show WHICH network a flagged session actually came
  // from, not just that something looked unusual.
  ipAddress: string | null;
  isNewDevice: boolean;
  isRapidNetworkChange: boolean;
};

// --- Tenant Management: Saved Views (TM-003, extended by Phase 1 item #6) -
// A named, reusable filter combination. Platform-wide (not per-admin) —
// `createdBy` is attribution only, matching the spec's "Save as reusable
// view" note with no per-user scoping requirement. `viewType` discriminates
// which screen a saved view belongs to (added in migration 0051) — every
// row created before item #6 is a Tenant Directory view, since saved views
// didn't exist anywhere else until now.
export type PlatformSavedViewType = "tenant_directory" | "audit_log";

export type PlatformSavedView = {
  id: string;
  name: string;
  viewType: PlatformSavedViewType;
  filters: CompanyListFilters | AuditLogFilters;
  createdBy: string;
  createdAt: string;
};

// --- Tenant Management: Configuration (TM-018/019/020) --------------------
// A generic Platform-Admin-facing settings store with real inheritance —
// distinct from configuration-center's `ConfigurationDomainSummary`, which
// is a tenant-facing INDEX of existing per-module screens (leave policy,
// shifts, ...). This is a new key/value override system: `defaultValue`
// is the product default; `overrideValue` is this tenant's row in
// `tenant_configuration` if one exists; `effectiveValue` is what actually
// applies (override, falling back to default) — the "effective value"
// column the spec calls for.
export type TenantConfigurationCategory =
  | "general"
  | "organization"
  | "attendance"
  | "leave"
  | "payroll"
  | "security"
  // Phase 3 item #7 — Backup & Disaster Recovery (advanced): RTO/RPO
  // targets, informational only (no automated enforcement — see migration
  // 0063's own header comment).
  | "backup_dr";

export type TenantConfigurationValueType = "boolean" | "integer" | "text";

export type TenantConfigurationSetting = {
  category: TenantConfigurationCategory;
  settingKey: string;
  label: string;
  description: string | null;
  valueType: TenantConfigurationValueType;
  defaultValue: unknown;
  overrideValue: unknown | null;
  effectiveValue: unknown;
  isOverridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type TenantConfigurationVersion = {
  id: string;
  companyId: string;
  category: string;
  settingKey: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
  changedAt: string;
  /** CFG-03: 'applied' (in force / was in force), 'scheduled' (future), 'cancelled'. */
  status?: "applied" | "scheduled" | "cancelled";
  effectiveFrom?: string | null;
  changeReason?: string | null;
};

// --- Tenant Management: Modules & Feature Entitlements (TM-021–024) -------
export type ModuleCatalogEntry = {
  key: string;
  label: string;
  category: string | null;
  dependsOn: string | null;
  enabled: boolean;
};

export type TenantFeatureEntitlement = {
  featureKey: string;
  moduleKey: string;
  name: string;
  description: string | null;
  defaultLimit: number | null;
  enabled: boolean;
  usageLimit: number | null;
  effectiveLimit: number | null;
};

// --- Tenant Management: Subscription (TM-025/026) --------------------------
export type SubscriptionHistoryEntry = {
  id: string;
  fromTier: string | null;
  toTier: string;
  seatsPurchased: number | null;
  changedBy: string;
  changedAt: string;
};

export type SubscriptionSummary = {
  companyId: string;
  packageTier: PackageTier;
  seatsPurchased: number;
  seatsUsed: number;
  seatsAvailable: number;
  history: SubscriptionHistoryEntry[];
};

// --- Tenant Management: Usage & Storage (TM-027/028) -----------------------
export type TenantDailyUsagePoint = {
  date: string;
  apiRequestCount: number;
  emailSentCount: number;
};

export type TenantUsageSummary = {
  companyId: string;
  employeeCount: number;
  userCount: number;
  storageUsedMb: number;
  storageQuotaMb: number;
  apiRequestsLast30Days: number;
  emailsSentLast30Days: number;
  dailyUsage: TenantDailyUsagePoint[];
};

// --- Tenant Management: Integrations (TM-031) ------------------------------
export type IntegrationProviderKey = "smtp" | "sso" | "biometric_device" | "webhook";

export type TenantIntegration = {
  companyId: string;
  providerKey: IntegrationProviderKey;
  enabled: boolean;
  // Secrets in `config` are never returned by GET — see tenant-integrations
  // service. Reflects only non-secret fields plus a `hasSecrets` flag.
  config: Record<string, unknown>;
  hasSecrets: boolean;
  updatedAt: string;
  updatedBy: string;
  /**
   * Tenant Management gap-fill Phase 1 item #12 — API key/webhook secret
   * rotation. Only ever set for `biometric_device`/`webhook` (the two
   * providers whose secret AIHXM itself issues — see
   * ROTATABLE_PROVIDER_KEYS in integrations.service.ts). Non-null between
   * a Rotate action and the grace period's end: the previous secret value
   * is never exposed here (same write-only discipline as the current
   * one), only that one exists and until when it should still be honored.
   */
  previousSecretExpiresAt: string | null;
};

/** Tenant Management gap-fill Phase 1 item #12 — the one-time plaintext response from a Rotate action. */
export type RotateIntegrationSecretResponse = {
  integration: TenantIntegration;
  newSecretValue: string;
  previousSecretExpiresAt: string;
};

// --- Phase 3 item #4: Webhooks & Eventing -----------------------------------

/**
 * The delivery lifecycle of one queued webhook event — see
 * `webhook_events` (migration 0061) and `WebhookDispatchService` for the
 * full state machine (backoff schedule, max attempts, dead-lettering).
 * `pending`/`failed` are both "still eligible for the next sweep tick" —
 * the two are kept distinct only so the admin delivery log can show
 * whether a row has ever actually been attempted yet.
 */
export type WebhookEventStatus = "pending" | "delivered" | "failed" | "dead_letter";

/**
 * One row of a tenant's webhook delivery log — `GET
 * /platform/companies/:id/webhook-events`. `payload` is included (unlike
 * an integration secret) since it's the tenant's own event data, not a
 * credential; there is nothing here to redact.
 */
export type WebhookEvent = {
  id: string;
  companyId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: WebhookEventStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastResponseStatus: number | null;
  createdAt: string;
  deliveredAt: string | null;
};

// --- Phase 3 item #1: SSO & Identity Federation (OpenID Connect + SAML) ----

/**
 * JIT role-resolution fields common to every SSO protocol's config —
 * `SsoService.resolveRoleKey()` reads only these two, regardless of
 * whether the login came in over OIDC or SAML, so they live in one place
 * both `OidcSsoConfig` and `SamlSsoConfig` extend rather than being
 * redeclared (and risking drift) on each. Exported (not just used
 * internally) as of slice 3 (SCIM) — `SsoService.resolveRoleKey()` takes
 * this base type rather than the full `SsoIntegrationConfig` union so
 * SCIM's provisioning path (which has no `protocol` at all when a tenant
 * configures SCIM without ever configuring OIDC/SAML login) can call the
 * exact same role-resolution logic without fabricating a fake protocol.
 */
export type SsoRoleResolutionConfig = {
  /** IdP group/role name -> this tenant's `roles.key` (e.g. "hr_admin"). First match wins. */
  roleMapping?: Record<string, string>;
  /** The role a brand-new SSO-provisioned user gets when no group mapping matches. */
  defaultRoleKey?: string;
};

/**
 * The shape of `tenant_integrations.config` for `providerKey: "sso"` once
 * `protocol` is `"oidc"` — read directly by `SsoService`, configured by a
 * Platform Admin the same way every other integration is (TM-031's own
 * `IntegrationsController`, Platform-Admin + step-up gated). `clientSecret`
 * is one of `SECRET_FIELDS.sso` (integrations.service.ts) — never returned
 * by a GET, exactly like every other provider's secret. `SamlSsoConfig`
 * below is this protocol's sibling — its own fields, never repurposing
 * these.
 */
export type OidcSsoConfig = SsoRoleResolutionConfig & {
  protocol: "oidc";
  /** The IdP's issuer URL — `${issuerUrl}/.well-known/openid-configuration` must resolve. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated OAuth scopes. Defaults to "openid email profile" if unset. */
  scopes?: string;
  /**
   * Which ID-token claim (if any) carries the IdP's group/role names for
   * JIT role mapping — e.g. "groups" (Okta/Azure AD common default), or
   * unset to skip mapping and always fall back to `defaultRoleKey`.
   */
  groupsClaim?: string;
};

/**
 * The shape of `tenant_integrations.config` for `providerKey: "sso"` once
 * `protocol` is `"saml"` (Phase 3 item #1, slice 2) — AIHXM as a SAML 2.0
 * Service Provider. No client secret exists in this protocol the way OIDC
 * has one: what proves the IdP's identity here is `idpCertificate`, the
 * IdP's own public signing certificate, checked against every assertion's
 * XML-DSig signature — not a value AIHXM has to keep confidential, so it
 * is deliberately NOT one of `SECRET_FIELDS.sso` (a wrong/expired cert
 * just needs replacing, never rotating like a leaked secret would).
 *
 * There is likewise no SP private key here: this SP does not sign its own
 * AuthnRequests (see `SsoService.buildSamlClient()`'s doc comment for why
 * that's a deliberate scope decision, not an oversight), so nothing on
 * this side of the exchange is ever secret.
 */
export type SamlSsoConfig = SsoRoleResolutionConfig & {
  protocol: "saml";
  /** The IdP's own Issuer/EntityID, checked against every assertion's `<Issuer>`. */
  idpEntityId: string;
  /** Where `SsoService` sends the browser to start a login — the IdP's "SSO URL" / "Sign-on URL". */
  idpSsoUrl: string;
  /** The IdP's X.509 signing certificate, PEM-encoded (`-----BEGIN CERTIFICATE-----...`). */
  idpCertificate: string;
  /**
   * Which SAML assertion attribute (if any) carries the IdP's group/role
   * names — e.g. "http://schemas.xmlsoap.org/claims/Group" (AD FS) or a
   * plain "groups" (Okta/OneLogin apps commonly let the admin name this
   * themselves). Unset skips mapping and always falls back to
   * `defaultRoleKey`, same as OIDC's `groupsClaim`.
   */
  groupsAttribute?: string;
  /**
   * Which SAML assertion attribute carries the person's email, for IdPs
   * that don't put it in the NameID itself. Unset falls back, in order,
   * to the assertion's `email`/`mail` attributes and then the NameID
   * itself when it's already email-shaped — the common case for most
   * IdPs' default SAML app configuration, so this is rarely needed.
   */
  emailAttribute?: string;
};

/** Whichever protocol a given tenant's `sso` integration is actually configured for. */
export type SsoIntegrationConfig = OidcSsoConfig | SamlSsoConfig;

/**
 * The public, no-session answer to "does this tenant's login page need a
 * 'Sign in with SSO' button" — reachable the same way branding is
 * (`public/tenants/:slug/...`), since a login page has to know this
 * before anyone has a session. Deliberately carries nothing else: no
 * issuer URL, no client ID — a stranger probing this route learns only
 * whether SSO exists for a real, non-archived tenant, nothing about how
 * it's configured.
 */
export type PublicSsoStatus = {
  enabled: boolean;
};

// --- Phase 3 item #1, slice 3: SCIM 2.0 inbound provisioning ---------------

/**
 * Admin-facing status of a tenant's SCIM provisioning configuration —
 * `GET /platform/companies/:id/scim/status`. Never carries the bearer
 * token itself (only whether one exists), same "never returned by a GET"
 * discipline every other integration secret in this codebase follows.
 */
export type ScimProvisioningStatus = {
  enabled: boolean;
  hasToken: boolean;
  /** The exact SCIM base URL to hand this tenant's IdP admin — always ends "/scim/v2/<slug>". */
  baseUrl: string;
};

/**
 * The one-time plaintext response from generating or rotating a tenant's
 * SCIM bearer token — same "show plaintext exactly once" pattern as
 * `RotateIntegrationSecretResponse` above. Rotating immediately invalidates
 * the previous token (no grace period, unlike `biometric_device`/`webhook`
 * secret rotation): this credential controls provisioning of tenant portal
 * access, and an overlapping-validity window is a real risk here in a way
 * it isn't for a device API key or a webhook signature.
 */
export type GenerateScimTokenResponse = {
  token: string;
  baseUrl: string;
};

// --- Tenant Management: Health (TM-032) ------------------------------------
export type HealthCheckStatus = "ok" | "degraded" | "down";

export type HealthCheckResult = {
  checkKey: string;
  status: HealthCheckStatus;
  detail: string | null;
  checkedAt: string;
};

// --- Tenant Management: Platform-wide Health Monitoring (Phase 3 item #9) --
// Cross-tenant aggregation on top of the same tenant_health_check_log table
// TM-032 writes to. A company with zero rows there is never folded into
// "ok" — see HealthService.getPlatformSummary's own doc comment — so it is
// counted separately via `companiesNeverChecked` instead.
export type PlatformHealthFailingCheck = {
  checkKey: string;
  status: Exclude<HealthCheckStatus, "ok">;
  detail: string | null;
  checkedAt: string;
};

export type PlatformHealthFailingCompany = {
  companyId: string;
  companyName: string;
  companySlug: string;
  failingChecks: PlatformHealthFailingCheck[];
};

export type PlatformHealthSummary = {
  generatedAt: string;
  totalCompanies: number;
  companiesNeverChecked: number;
  perCheckCounts: Record<string, { ok: number; degraded: number; down: number }>;
  failingCompanies: PlatformHealthFailingCompany[];
};

// --- Tenant Management: Support Tickets (TM-033) ---------------------------
export type SupportTicketPriority = "low" | "normal" | "high" | "urgent";
export type SupportTicketStatus = "open" | "in_progress" | "resolved" | "closed";

export type SupportTicket = {
  id: string;
  companyId: string;
  subject: string;
  description: string;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  createdBy: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Tenant Management gap-fill Phase 1 item #9 — Support ticket SLA
   * basics. Purely computed from `createdAt` + a fixed per-priority
   * response window (see SLA_HOURS_BY_PRIORITY in
   * support-tickets.service.ts) — no new column, no migration. `dueBy`
   * is always present even for a resolved/closed ticket (so the list can
   * still show what the target was); `slaBreached` is only ever true for
   * a ticket that is BOTH past its `dueBy` AND still open/in_progress —
   * a resolved ticket never shows as breached regardless of how long it
   * took, since this is a live "needs attention now" signal, not a
   * historical SLA-compliance report.
   */
  dueBy: string;
  slaBreached: boolean;
};

// --- Tenant Management: Backups (TM-035) -----------------------------------
export type TenantBackup = {
  id: string;
  companyId: string;
  status: "queued" | "running" | "completed" | "failed";
  sizeBytes: number | null;
  fileKey: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

// --- Tenant Management: Data Export (TM-036) --------------------------------
export type DataExportScope = "full" | "employees" | "payroll" | "attendance";
export type DataExportFormat = "json" | "csv";

export type TenantDataExport = {
  id: string;
  companyId: string;
  scope: DataExportScope;
  format: DataExportFormat;
  status: "queued" | "running" | "completed" | "failed";
  sizeBytes: number | null;
  fileKey: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  error: string | null;
  /** Phase 2 gap-fill item #6 — true when a download password was set at
   * request time. The password itself is never stored or returned
   * anywhere; the UI uses this only to know whether to prompt for one
   * before calling download. */
  isPasswordProtected: boolean;
};

export type RequestDataExportRequest = {
  scope: DataExportScope;
  format: DataExportFormat;
  /** Optional — when set, the export is encrypted at rest under THIS
   * password instead of the server's own key, and the same password must
   * be supplied again to download it. Never persisted anywhere. */
  password?: string;
};

/**
 * Phase 3 item #5 — "Encryption & Secrets (advanced)": a tenant-dedicated
 * export encryption key with independent rotation, NOT a true
 * customer-held/HSM-backed key (see TenantExportKeyService's own doc
 * comment for the full, honest scope of what this is and isn't).
 * `GET /platform/companies/:id/export-key`. Deliberately carries no key
 * material of any kind, wrapped or not — that never leaves the server,
 * unlike a rotated integration secret or SCIM token, since this key is
 * only ever used internally and never needs to be copy-pasted anywhere.
 */
export type TenantExportKeyStatus = {
  enabled: boolean;
  /** True once a key has ever been generated for this tenant, even if `enabled` is currently false (disabling keeps the key material so already-encrypted exports stay decryptable). */
  hasKey: boolean;
  createdAt: string | null;
  /** Non-null only while a just-rotated-out previous key generation is still inside its 7-day grace period. */
  previousKeyExpiresAt: string | null;
};

/**
 * Phase 3 item #6 — "Data Residency & Sovereignty", the honest,
 * proportionate version: a residency DECLARATION + DISCLOSURE mechanism,
 * not real multi-region data placement (this platform runs on a single
 * Supabase Postgres region and has no multi-region infrastructure to move
 * data between). `platformActualRegion` is a fixed, platform-wide
 * constant (`PLATFORM_DATA_REGION`, see DataResidencyService) — it is the
 * SAME for every tenant, since there is only one region. `requiredRegion`
 * is whatever a Platform Admin recorded on behalf of this tenant's own
 * contract/expectation, freely-entered text since real requirements vary
 * ("Pakistan", "EU", "No requirement", etc.) — null means nothing has
 * ever been recorded. `complianceStatus` is computed, never stored:
 * "no_requirement" when `requiredRegion` is null/empty, "matches" when it
 * case-insensitively appears within `platformActualRegion` (or vice
 * versa), "mismatch" otherwise. `acknowledgedBy`/`acknowledgedAt` are only
 * ever set (via POST .../residency/acknowledge) while a mismatch exists,
 * and are cleared automatically the next time `requiredRegion` changes —
 * an acknowledgment of one stated requirement must never be read as
 * covering a different one recorded later.
 */
export type DataResidencyComplianceStatus = "matches" | "no_requirement" | "mismatch";

export type DataResidencyStatus = {
  companyId: string;
  platformActualRegion: string;
  requiredRegion: string | null;
  complianceStatus: DataResidencyComplianceStatus;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
};

// --- Phase 3 item #7: Backup & Disaster Recovery (advanced) ----------------
// RTO/RPO targets ride the existing `tenant_configuration_defaults`/
// `tenant_configuration` mechanism (category 'backup_dr', migration 0063)
// and so need no dedicated type here — TenantConfigurationSetting already
// covers them. What's new is the manual DR test evidence log: there is no
// automated failover harness in this platform (explicitly out of scope —
// no real infrastructure exists to fail over between), so this is an
// honest record of actual, manually-performed recovery tests a Platform
// Admin ran, kept for the same reason a real ops team keeps one: to show
// a compliance-conscious customer or auditor genuine evidence of when
// this tenant's data was last tested for recoverability, and how it went.
export type DrTestOutcome = "pass" | "fail" | "partial";

export type TenantDrTestLogEntry = {
  id: string;
  companyId: string;
  testedAt: string;
  outcome: DrTestOutcome;
  notes: string | null;
  recordedBy: string;
  createdAt: string;
};

export type RecordDrTestRequest = {
  testedAt: string;
  outcome: DrTestOutcome;
  notes?: string;
};

// --- Phase 3: Auth & Identity --------------------------------------------
// Real per-account authentication (password + mandatory TOTP MFA),
// replacing Phase 2's single shared platform-admin credential. See
// apps/api/migrations/0002_auth_identity.sql and DECISIONS.md Decision #3.

export type LoginRequest = {
  email: string;
  password: string;
};

/**
 * A tenant's own login page (aihxm.com/<slug>/login) authenticates by a
 * typed identifier, not email — the company is already known from the
 * path, and both identifier namespaces below are only unique WITHIN a
 * company (`employees.employee_number`: migration 0010's `UNIQUE
 * (company_id, employee_number)`; `company_admins.login_id`: migration
 * 0048's case-insensitive unique index), which is exactly why
 * `companySlug` has to travel alongside it here. `employeeNumber` is kept
 * as the field name for API/DTO stability, but the backend
 * (AuthService.findAccountByEmployeeNumber) matches it against EITHER an
 * Employee Core row's employee_number OR a Company (Super) Admin's own
 * login_id — the same field on the login page works for both, since a
 * Company Admin has no Employee Core record to have an employee number
 * in the first place. Password reset still goes through email regardless
 * of how someone logs in — see PasswordResetRequestBody — this only
 * changes the login identifier.
 */
export type LoginWithEmployeeNumberRequest = {
  companySlug: string;
  employeeNumber: string;
  password: string;
};

/**
 * Discriminated on `status`. MFA is mandatory for both admin tiers, so a
 * fresh account always gets `mfa_setup_required` on its very first
 * successful password check, never a bare `ok`.
 */
export type LoginResult =
  | { status: "ok"; token: string }
  | { status: "mfa_setup_required"; mfaTicket: string; otpauthUrl: string; secretForManualEntry: string }
  | { status: "mfa_required"; mfaTicket: string };

export type MfaEnrollConfirmRequest = {
  mfaTicket: string;
  code: string;
};

export type MfaVerifyRequest = {
  mfaTicket: string;
  code: string;
};

/**
 * Tenant Management gap-fill batch 1 — MFA recovery codes. The fallback for
 * "I lost my authenticator device": one of the ten single-use codes issued
 * once at enrollment (see SessionResult.recoveryCodes) substitutes for a
 * TOTP code on this one alternate path off the normal mfa_verify ticket.
 */
export type MfaRecoveryCodeVerifyRequest = {
  mfaTicket: string;
  code: string;
};

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. Re-proves an
 * already-logged-in session's second factor immediately before a
 * particularly sensitive action (granting/changing Platform Admin
 * access, resetting a tenant admin's password, "Login As" impersonation,
 * rotating an integration secret) — the same mandatory-MFA credential
 * every session already enrolled at login, via `POST /auth/step-up`,
 * never a new/separate one. Exactly one of totpCode/recoveryCode must be
 * present (the same either-credential shape as the login-time MFA step).
 */
export type StepUpVerifyRequest = {
  totpCode?: string;
  recoveryCode?: string;
};

/** `verifiedForSeconds` is how long the resulting step-up grant lasts —
 *  purely informational for the frontend (e.g. a countdown); the server
 *  is the sole source of truth for whether it's still valid. */
export type StepUpVerifyResponse = {
  verifiedForSeconds: number;
};

export type SessionResult = {
  status: "ok";
  token: string;
  /**
   * Present ONLY on the response to `/auth/mfa/enroll/confirm` — a fresh
   * batch of ten single-use recovery codes, shown to the user exactly this
   * once (never retrievable again; only the salted hashes are persisted).
   * Absent everywhere else, including `/auth/mfa/verify` and
   * `/auth/mfa/recovery-code/verify`, both of which reuse this same type.
   */
  recoveryCodes?: string[];
};

/**
 * `GET /auth/me` — Decision #13. What a logged-in session actually is, for
 * the frontend's own purposes: which portal shell to render (Platform
 * Admin vs. a tenant's HR Admin/Manager/Employee screens) and which nav
 * sections to show. This is describing the session, not a new
 * authorization mechanism — every real read/write still goes through
 * EntitlementsService/RbacService server-side exactly as before; a client
 * that lies about what it does with this response gets 403s and 404s same
 * as always. `roleKeys` is independent of which of AuthService's three
 * login tiers actually resolved the session (see its SessionIdentity doc
 * comment) — it's always a direct read of this user's own
 * `user_role_assignments` rows in this company, which is why a Company
 * (Super) Admin who hasn't yet been granted a tenant role via
 * `POST /platform/role-assignments` correctly gets `roleKeys: []` here
 * (Decision #12's "what this unblocks").
 */
export type MeResponse = {
  isPlatformAdmin: boolean;
  companyId: string | null;
  companyName: string | null;
  /** The company's slug (companies.slug) — null for Platform Admin. Lets the
   * authenticated portal shell fetch this tenant's own uploaded branding
   * (logo/colors) from the same public, no-auth /public/tenants/:slug/branding
   * endpoint the tenant login page already uses, instead of hardcoding the
   * plain "AI HXM" wordmark once a session exists. */
  companySlug: string | null;
  email: string;
  fullName: string;
  roleKeys: TenantRoleKey[];
  /** The `employees` row linked to this login, if any — null for Platform Admin and for a Company Admin with no Employee record. */
  employeeId: string | null;
  enabledModules: ModuleKey[];
};

export type PasswordResetRequestBody = {
  email: string;
};

/**
 * Phase 3 has no email/notification system yet (that's Phase 6's WRICEF
 * Interfaces work) — the reset token comes back directly in this
 * response, clearly labeled, rather than being silently unusable.
 */
export type PasswordResetRequestResult = {
  message: string;
  devModeToken?: string;
};

export type PasswordResetConfirmRequest = {
  token: string;
  newPassword: string;
};

export type CreateLoginRequest = {
  initialPassword: string;
  /**
   * Only meaningful for a Company (Super) Admin's login
   * (CompaniesService.createAdminLogin) — a Company Admin has no Employee
   * Core record, so without this they have no identifier for their own
   * company's own /:companySlug/login page at all. Optional: omit it and
   * the admin can still sign in via email on the shared /login page, just
   * not through their company's own tenant-path login.
   */
  loginId?: string;
};

/**
 * Platform Admin profile row (platform_admins table). Distinct from
 * CompanyAdmin — no companyId, and creation always bundles a login in one
 * step (see PlatformAdminsService) rather than a separate "add profile,
 * then create login" flow, since a Platform Admin with no login is never
 * a useful intermediate state the way a freshly-imported CompanyAdmin is.
 */
/** Phase 2 gap-fill item #7 — Platform Admin delegation. "scoped" replaces
 *  the roadmap's original "regional" wording: this schema has no real
 *  geographic region concept, so scoping by an explicit tenant list is the
 *  honest, useful version of the idea instead. */
export type PlatformAdminAccessLevel = "full" | "read_only" | "scoped";

export type PlatformAdmin = {
  id: string;
  fullName: string;
  email: string;
  status: CompanyAdminStatus;
  accessLevel: PlatformAdminAccessLevel;
  /** Only non-empty (and only meaningful) when accessLevel === "scoped". */
  scopedCompanyIds: string[];
  createdAt: string;
};

export type CreatePlatformAdminRequest = {
  fullName: string;
  email: string;
  initialPassword: string;
  /** Defaults to "full" when omitted — every admin created before this existed keeps that behavior. */
  accessLevel?: PlatformAdminAccessLevel;
  scopedCompanyIds?: string[];
};

export type SetPlatformAdminAccessRequest = {
  accessLevel: PlatformAdminAccessLevel;
  scopedCompanyIds?: string[];
};

// --- Phase 4: RBAC + Field-Level Permission Engine -----------------------
// See apps/api/migrations/0004_rbac.sql and apps/api/src/rbac/rbac.service.ts.
// `can()` (object/record-level) and `resolveFieldAccess()` (field-level,
// including conditional sibling-field rules) are the two engines the plan
// doc's enforcement order calls for; these types describe the catalog and
// assignment data they read, plus the dummy_records proof-of-concept
// object used to test them until Employee Core (Phase 7) provides a real one.

/** `masked` (ACC-01): the field is returned, but its value is obscured by the rule's mask_rule. */
export type FieldAccess = "view" | "edit" | "hidden" | "masked";

export type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** ACC-02: null = platform role. */
  companyId?: string | null;
  isSystem?: boolean;
  isActive?: boolean;
};

export type FieldMaskRule = "full" | "last4" | "first1" | "email";

export type FieldPermissionRuleView = {
  id: string;
  roleId: string;
  companyId: string | null;
  objectKey: string;
  fieldKey: string;
  access: FieldAccess;
  maskRule: FieldMaskRule | null;
  priority: number;
  denyOverrides: boolean;
  sensitivityClass: "public" | "internal" | "confidential" | "restricted" | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  condition: { field: string; equals: unknown } | null;
};

export type CreateFieldPermissionRuleRequest = {
  roleId: string;
  objectKey: string;
  fieldKey: string;
  access: FieldAccess;
  maskRule?: FieldMaskRule;
  priority?: number;
  denyOverrides?: boolean;
  sensitivityClass?: "public" | "internal" | "confidential" | "restricted";
  effectiveFrom?: string;
  effectiveTo?: string;
  condition?: { field: string; equals: unknown };
};

export type PermissionView = {
  id: string;
  key: string;
  description: string | null;
  objectKey: string | null;
  action: string | null;
  scope: string | null;
};

export type CreateCustomRoleRequest = {
  key: string;
  name: string;
  description?: string;
  permissionKeys?: string[];
};

export type Permission = {
  id: string;
  key: string;
  description: string | null;
};

export type RoleAssignmentSource = "manual" | "scim" | "sso" | "workflow" | "delegation" | "system";

export type UserRoleAssignment = {
  id: string;
  userAccountId: string;
  companyId: string;
  roleId: string;
  roleKey: string;
  createdAt: string;
  /** ACC-03: the grant counts only from effectiveFrom to effectiveTo (inclusive); null = open. */
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  source?: RoleAssignmentSource;
  grantedBy?: string | null;
  reason?: string | null;
  /** True when today falls inside the window. */
  isActive?: boolean;
};

export type AssignRoleRequest = {
  userAccountId: string;
  companyId: string;
  roleKey: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  source?: RoleAssignmentSource;
  reason?: string;
};

/**
 * Organization Management Phase 11 (Unified Integration & Synchronization
 * Requirements, Section 19 — assignment-based Data Scope). A row says
 * "this user's `.scoped` view permission for this scope type is
 * restricted to this entity (and, for org_unit/location, that entity's
 * whole subtree)" — a user can hold several rows (e.g. two org units),
 * and holding zero rows for a scope type their role's `.scoped`
 * permission covers means seeing nothing along that dimension: Data
 * Scope fails closed, not open. `scopeEntityId` is a bare id whose table
 * depends on `scopeType` (org_units.id / locations.id / cost_centers.id)
 * — kept generic here the same way the underlying `data_scope_assignments`
 * table is, rather than three near-identical tables/types.
 */
export type DataScopeType = "org_unit" | "location" | "cost_center";
/** ACC-04: scope types an assignment can carry; payroll_area is direct (no subtree). */
export type DataScopeAssignmentScopeType = DataScopeType | "payroll_area";

export type DataScopeAssignmentView = {
  id: string;
  userAccountId: string;
  companyId: string;
  scopeType: DataScopeAssignmentScopeType;
  scopeEntityId: string;
  createdAt: string;
  /** ACC-04 */
  includeDescendants?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  grantedBy?: string | null;
  reason?: string | null;
  roleId?: string | null;
  objectKey?: string | null;
  isActive?: boolean;
};

export type AssignDataScopeRequest = {
  userAccountId: string;
  companyId: string;
  scopeType: DataScopeAssignmentScopeType;
  scopeEntityId: string;
  includeDescendants?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  reason?: string;
  roleId?: string;
  objectKey?: string;
};

/**
 * Organization Management Phase 12 (Unified Integration & Synchronization
 * Requirements, Section 24 — Legacy Data Migration), building directly on
 * the `legacy_records_not_mapped` warning Phase 8's
 * `OrganizationCommandCenterService` already computes: that warning is a
 * COUNT ONLY (Section 25's own mockup shows counts, not lists — see that
 * service's own class doc comment), deliberately left as "this report's
 * read-only first half; the actual backfill tool is Phase 12's own
 * scope." This is that second half — the actual list of affected active
 * employees, one entry per employee, each carrying every gap that
 * employee currently has (an employee can have more than one: a legacy
 * department AND a legacy location, for instance).
 *
 * Scope is intentionally the exact three cases Phase 8's own query
 * already checks — department/orgUnitId, location/locationId,
 * managerId/direct-relationship — not also `designation`/`positionId`
 * (Section 24 lists `designation` among the legacy fields, but Section
 * 25's warning, and therefore this report built on it, never included a
 * `designation` check). Core Employee Enterprise Phase 11 picked exactly
 * this one up (see `LegacyReconciliationService`'s own doc comment) —
 * `"designation"` is the fourth gap type, matched against `positions`'
 * own `position_title` the same way `"department"`/`"location"` match
 * against `org_units`/`locations`. The rest of Core Employee Enterprise's
 * own new sub-entities (Contact/Address/Family/Education/Qualifications/
 * Cost-Allocation/Assets, Phases 6-9) are deliberately NOT extended here —
 * they were built with real canonical foreign keys from day one, so there
 * is no pre-existing free-text legacy value for any of them to reconcile
 * against; this report only ever finds a gap where one field pair is
 * free-text-only and another is canonical-id-only for the same fact.
 */
export type LegacyReconciliationGapType = "department" | "location" | "manager" | "designation";

/**
 * A candidate canonical entity a `department`/`location` gap's free text
 * might refer to, resolved by this codebase's own two-tier match (see
 * `legacy-reconciliation.service.ts`'s `suggestMatches()`): `"exact"`
 * means the free text equals the candidate's name once both are trimmed
 * and lowercased; `"fuzzy"` means one contains the other as a substring
 * under the same normalization. Deliberately NOT `pg_trgm`/`similarity()`
 * — this codebase has never taken a dependency on that extension, and a
 * human reviews every suggestion before it's applied (this list informs,
 * it never auto-applies), so a simple, dependency-free heuristic is
 * enough.
 */
export type LegacyReconciliationSuggestion = {
  id: string;
  name: string;
  matchType: "exact" | "fuzzy";
};

/**
 * A `"manager"` gap is never ambiguous the way `department`/`location`
 * gaps are — `employees.managerId` already points at a real, existing
 * employee row (a live FK, `ON DELETE SET NULL`); what's missing is only
 * the canonical, TYPED `org_relationships` row Phase 3 introduced
 * alongside it (see `OrgRelationshipsService`'s own class doc comment for
 * why the legacy field and the typed row can drift apart). So this gap
 * carries the already-known `managerEmployeeId`/`managerName` directly,
 * not a `suggestions` list — there is nothing to choose between, only a
 * single action to take (`POST .../link-manager-relationship`).
 */
export type LegacyReconciliationGap =
  | { gapType: "department"; legacyValue: string; suggestions: LegacyReconciliationSuggestion[] }
  | { gapType: "location"; legacyValue: string; suggestions: LegacyReconciliationSuggestion[] }
  | { gapType: "manager"; legacyValue: string; managerEmployeeId: string }
  // Phase 11 — suggestions here are VACANT positions only (a filled/
  // frozen/abolished one can never be the target of
  // PositionsService.assignEmployee(), the same write path this gap's own
  // `link-position` action delegates to), matched by `position_title`.
  | { gapType: "designation"; legacyValue: string; suggestions: LegacyReconciliationSuggestion[] };

export type LegacyReconciliationEmployeeView = {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  gaps: LegacyReconciliationGap[];
};

/** `GET /organization/legacy-reconciliation`. `totalAffectedEmployees`
 * counts EMPLOYEES (matching how many rows the admin screen will render),
 * not gaps — one employee with two gaps still counts once, distinct from
 * `OrganizationCommandCenterSummary.integrityWarnings`' own
 * `legacy_records_not_mapped` count, which is a query-row count over the
 * same WHERE clause and can therefore be equal to or less than the sum of
 * every employee's gap count here (it never double-counts a multi-gap
 * employee either, since that warning's query also counts rows, not
 * gaps — the two numbers agree). */
export type LegacyReconciliationReport = {
  generatedAt: string;
  totalAffectedEmployees: number;
  employees: LegacyReconciliationEmployeeView[];
};

export type LinkOrgUnitRequest = {
  orgUnitId: string;
};

export type LinkLocationRequest = {
  locationId: string;
};

/**
 * dummy_records, filtered through RbacService.filterRecordFields before it
 * ever reaches the client — `testField`/`secretField` are simply absent
 * from the object (not present-but-null) when the caller's role doesn't
 * grant them. Never a real product object; exists only to prove the
 * engine (see this phase's own exit criterion).
 */
export type DummyRecordView = {
  id: string;
  companyId: string;
  ownerUserAccountId: string | null;
  title: string;
  status: "locked" | "unlocked";
  createdAt: string;
  testField?: string | null;
  secretField?: string | null;
};

// --- Phase 6: WRICEF Framework Skeleton — Workflow engine -----------------
// See apps/api/migrations/0007_wricef_workflow.sql and
// apps/api/src/workflow/workflow.service.ts. "manager_of_submitter" was
// deliberately not a supported ApproverType at first — it needed the
// employee/manager hierarchy Phase 7 (Employee Core) introduces — and is
// added in Phase 9 (0014_workflow_manager_of_submitter.sql) as that
// phase's own leave-approval routing needs it. It carries neither a
// `roleId` nor a `userAccountId` at template-configuration time (there is
// no fixed role or person to name in advance); WorkflowService resolves
// it fresh, per instance, from the submitting employee's own manager at
// the moment the step activates. It is deliberately NOT a valid
// `escalationApproverType` — escalating to "the manager's manager" is
// unbuilt scope (see KNOWN_ISSUES.md); an escalation target is always
// `role` or `specific_user`, enforced by the DTO independently of this
// shared type.

export type ApproverType =
  | "role"
  | "specific_user"
  | "manager_of_submitter"
  // WFL-04
  | "org_unit_head"
  | "dotted_line_manager"
  | "position"
  | "group";

export type EscalationApproverType = "role" | "specific_user";

export type WorkflowApproverConfig = {
  approverType: ApproverType;
  roleId?: string;
  userAccountId?: string;
  /** WFL-04: `position` approver - whoever currently occupies this position. */
  positionId?: string;
  /** WFL-04: `group` approver - any current member of this employee group. */
  employeeGroupId?: string;
  /** WFL-04: `org_unit_head` approver - head of this unit; omit for the submitter's own unit. */
  orgUnitId?: string;
  escalationApproverType?: EscalationApproverType;
  escalationRoleId?: string;
  escalationUserAccountId?: string;
};

/**
 * Step / start condition. `{field, equals}` is the original form. WFL-04 adds
 * comparison operators for amount-threshold routing, e.g.
 * `{field: "amount", op: "gte", value: 100000}`, and `all` / `any` groups.
 */
export type WorkflowFieldCondition =
  | { field: string; equals: unknown }
  | { field: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: unknown }
  | { field: string; op: "in" | "not_in"; value: unknown[] }
  | { field: string; op: "between"; value: [number, number] }
  | { all: WorkflowFieldCondition[] }
  | { any: WorkflowFieldCondition[] };

export type WorkflowApprovalMode = "all" | "any" | "quorum";
export type WorkflowPriority = "low" | "normal" | "high" | "urgent";

export type WorkflowStepConfig = {
  stepOrder: number;
  name: string;
  condition?: WorkflowFieldCondition | null;
  /** WFL-05: all lines must approve (default), any one line, or `quorumCount` lines. */
  approvalMode?: WorkflowApprovalMode;
  quorumCount?: number;
  /** WFL-05: steps sharing a group name (and adjacent) run in parallel. */
  parallelGroup?: string | null;
  /** WFL-05: remind pending approvers every N hours. */
  reminderHours?: number;
  /** WFL-05: a rejection must carry a comment. */
  requireCommentOnReject?: boolean;
  /** Hours until a pending approval on this step is escalated. Omit for no SLA. */
  slaHours?: number;
  /** One entry per required approval line — more than one means every line must approve ("parallel"). */
  approvers: WorkflowApproverConfig[];
};

export type WorkflowTemplate = {
  id: string;
  companyId: string;
  key: string;
  name: string;
  objectKey: string;
  isActive: boolean;
  steps: WorkflowStepConfig[];
  createdAt: string;
  /** WFL-02: the version new submissions are pinned to. */
  currentVersionNo?: number;
  description?: string | null;
  /** WFL-05 */
  triggerEvent?: string | null;
  startCondition?: WorkflowFieldCondition | null;
};

export type CreateWorkflowTemplateRequest = {
  key: string;
  name: string;
  objectKey: string;
  description?: string;
  triggerEvent?: string;
  startCondition?: WorkflowFieldCondition | null;
  steps: WorkflowStepConfig[];
};

export type WorkflowInstanceStatus = "in_progress" | "approved" | "rejected" | "cancelled" | "returned" | "on_hold";
export type WorkflowStepStatus = "pending" | "skipped" | "approved" | "rejected" | "returned";
export type WorkflowApprovalStatus = "pending" | "escalated" | "approved" | "rejected" | "returned" | "withdrawn";
export type WorkflowDecision = "approved" | "rejected" | "send_back";

export type WorkflowStepApprovalView = {
  id: string;
  approverType: ApproverType;
  roleId: string | null;
  userAccountId: string | null;
  status: WorkflowApprovalStatus;
  dueAt: string | null;
  escalatedAt: string | null;
  escalatedToUserAccountId: string | null;
  decidedByUserAccountId: string | null;
  decision: WorkflowDecision | null;
  comment: string | null;
  /** ACC-06 */
  delegatedToUserAccountId?: string | null;
  delegatedFromUserAccountId?: string | null;
};

export type WorkflowStepInstanceView = {
  id: string;
  stepOrder: number;
  name: string;
  status: WorkflowStepStatus;
  approvals: WorkflowStepApprovalView[];
  approvalMode?: WorkflowApprovalMode;
  quorumCount?: number | null;
  parallelGroup?: string | null;
  requireCommentOnReject?: boolean;
};

export type WorkflowInstanceView = {
  id: string;
  companyId: string;
  templateId: string;
  templateKey: string;
  objectKey: string;
  recordId: string;
  submittedByUserAccountId: string;
  /** See 0014_workflow_manager_of_submitter.sql: who a `manager_of_submitter`
   * approver resolves against — the caller for an ordinary submission, or
   * (for an On-Behalf submission) the employee the request is actually about. */
  subjectUserAccountId: string;
  status: WorkflowInstanceStatus;
  steps: WorkflowStepInstanceView[];
  createdAt: string;
  updatedAt: string;
  /** WFL-02 / WFL-07 */
  templateVersionNo?: number | null;
  title?: string | null;
  priority?: WorkflowPriority;
  dueAt?: string | null;
  holdReason?: string | null;
};

export type SubmitForApprovalRequest = {
  templateKey: string;
  objectKey: string;
  recordId: string;
  /**
   * A snapshot of the record's fields at submission time, used only to
   * evaluate conditional steps (WorkflowStepConfig.condition). The engine
   * never queries the object's own table itself — see
   * 0007_wricef_workflow.sql's header comment.
   */
  record: Record<string, unknown>;
  /** See WorkflowInstanceView.subjectUserAccountId. Omit for an ordinary
   * self-submission; set for an On-Behalf submission. */
  subjectUserAccountId?: string;
  /** WFL-07: shown in My Inbox; defaults to the template name. */
  title?: string;
  priority?: WorkflowPriority;
  /** WFL-07: explicit deadline; otherwise derived from the step SLAs. */
  dueAt?: string;
};

export type ApprovalDecisionRequest = {
  decision: WorkflowDecision;
  comment?: string;
};

// --- Step 6 (WFL-03, WFL-06, WFL-07, ACC-06): My Inbox, comments, delegation ---

export type WorkflowCommentKind =
  | "comment" | "info_request" | "info_response" | "send_back" | "resubmit" | "delegation" | "decision" | "reminder" | "system";

export type WorkflowCommentView = {
  id: string;
  workflowInstanceId: string;
  stepInstanceId: string | null;
  authorUserAccountId: string | null;
  kind: WorkflowCommentKind;
  body: string;
  visibility: "participants" | "approvers";
  createdAt: string;
};

export type WorkflowAttachmentView = {
  id: string;
  workflowInstanceId: string;
  commentId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  visibility: "participants" | "approvers";
  uploadedByUserAccountId: string;
  createdAt: string;
};

export type InboxSlaState = "none" | "on_track" | "due_soon" | "overdue";

export type InboxItemView = {
  instanceId: string;
  stepInstanceId: string | null;
  objectKey: string;
  objectLabel: string;
  recordId: string;
  title: string;
  status: WorkflowInstanceStatus;
  priority: WorkflowPriority;
  stepName: string | null;
  submittedByUserAccountId: string;
  submittedAt: string;
  dueAt: string | null;
  slaState: InboxSlaState;
  /** the caller can act directly, or only on behalf of this delegator */
  actingFor: string | null;
  /** why the item is in this inbox */
  reason: "approver" | "delegate" | "escalation" | "submitter_returned" | "submitter_on_hold" | "task";
  canSendBack: boolean;
  summary?: string | null;
  deepLink?: string | null;
};

export type InboxCountsView = {
  toApprove: number;
  overdue: number;
  returnedToMe: number;
  waitingOnMe: number;
};

export type InboxDecisionRequest = {
  decision: WorkflowDecision | "request_info" | "delegate";
  comment?: string;
  delegateToUserAccountId?: string;
};

export type DelegationView = {
  id: string;
  delegatorUserAccountId: string;
  delegateUserAccountId: string;
  scopeObjectKeys: string[] | null;
  validFrom: string;
  validTo: string;
  reason: string;
  status: "active" | "revoked";
  createdByUserAccountId: string;
  createdAt: string;
};

export type CreateDelegationRequest = {
  delegateUserAccountId: string;
  /** omit to delegate every approval; HR may set it to create a delegation on someone's behalf */
  delegatorUserAccountId?: string;
  scopeObjectKeys?: string[];
  validFrom?: string;
  validTo: string;
  reason: string;
};

// --- Phase 6: WRICEF Framework Skeleton — Enhancements (custom fields) ---

export type CustomFieldType = "text" | "number" | "boolean" | "date" | "select";

export type CustomFieldDefinition = {
  id: string;
  companyId: string;
  objectKey: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired: boolean;
  // Hiring Card Field Configuration (2026-09-27) — a custom field is never
  // hard-deleted (values referencing it may already exist), only
  // deactivated. Every pre-existing row defaults to `true` via the
  // migration that added this column, so nothing already using this type
  // needs to change.
  isActive: boolean;
  createdAt: string;
};

export type DefineCustomFieldRequest = {
  objectKey: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired?: boolean;
};

export type SetCustomFieldValueRequest = {
  objectKey: string;
  recordId: string;
  fieldKey: string;
  value: unknown;
};

// --- Hiring Card Field Configuration (2026-09-27) -------------------------
// kumail's own request, looking at the Hiring Card Designer's card-level
// toggles: "there should be configuration available for their fields under
// their respective tile — field enable/disable, add custom field option —
// custom field once added will be visible in respective tile." This is the
// field-level depth the v2 gap analysis flagged as "then 2" — see
// claude/core-employee-configuration-hr-admin-v2-gap-analysis-and-roadmap.md.
// Built-in field enable/disable/required is a NEW per-company catalog
// (`core_employee_card_field_definitions`); "add custom field" reuses the
// existing WRICEF custom-fields engine (`CustomFieldDefinition` above)
// rather than forking a parallel one, scoped under `hiring_card:<cardKey>`
// and mirrored under `employee` so the same field also shows on the
// employee's own profile after hiring (kumail's second scoping choice).

// "then 2" Phase 3 (2026-10-02, gap-table item #3) — the field-level
// validation/default/conditional-display depth beyond enable/disable/
// required. See 0108_hiring_card_field_depth.sql for the full rationale.
export type FieldValidationRules = {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
};

export type FieldConditionalOn = {
  fieldKey: string;
  operator: "equals" | "notEquals";
  value: string;
};

export type CardFieldType = "text" | "textarea" | "number" | "date" | "boolean" | "select" | "catalog" | "reference" | "file" | "email" | "phone";
export type CardFieldAuditPolicy = "none" | "changes" | "reads_and_changes";
/** A rule slot holds either the inline JSON condition used so far or a reference into the central rule registry (CFG-14). */
export type CardRuleSlot = FieldConditionalOn | { ref: string } | null;

export type CardFieldDefinitionView = {
  cardKey: string;
  fieldKey: string;
  label: string;
  isEnabled: boolean;
  isRequired: boolean;
  sortOrder: number;
  defaultValue: string | null;
  validationRules: FieldValidationRules | null;
  conditionalOn: FieldConditionalOn | null;
  /** CFG-12 metadata. fieldType is null until classified. */
  fieldType: CardFieldType | null;
  helpText: string | null;
  placeholder: string | null;
  optionValues: string[] | null;
  referenceCatalogType: string | null;
  referenceObject: string | null;
  sensitivityClass: FieldSensitivityTier | null;
  visibilityRule: CardRuleSlot;
  editabilityRule: CardRuleSlot;
  dataScopeRule: CardRuleSlot;
  workflowRule: CardRuleSlot;
  auditPolicy: CardFieldAuditPolicy;
  isEffectiveDated: boolean;
  labelI18n: Record<string, string>;
  helpI18n: Record<string, string>;
};

/** What one card's field-configuration screen (and the live Hiring Wizard) needs: this card's built-in fields plus whatever custom fields have been added to it. */
export type CardFieldsConfigView = {
  cardKey: string;
  builtIn: CardFieldDefinitionView[];
  custom: CustomFieldDefinition[];
};

export type UpdateCardFieldConfigRequest = {
  isEnabled?: boolean;
  isRequired?: boolean;
  defaultValue?: string | null;
  validationRules?: FieldValidationRules | null;
  conditionalOn?: FieldConditionalOn | null;
  fieldType?: CardFieldType | null;
  label?: string | null;
  helpText?: string | null;
  placeholder?: string | null;
  optionValues?: string[] | null;
  referenceCatalogType?: string | null;
  referenceObject?: string | null;
  sensitivityClass?: FieldSensitivityTier | null;
  visibilityRule?: CardRuleSlot;
  editabilityRule?: CardRuleSlot;
  dataScopeRule?: CardRuleSlot;
  workflowRule?: CardRuleSlot;
  auditPolicy?: CardFieldAuditPolicy;
  isEffectiveDated?: boolean;
  labelI18n?: Record<string, string>;
  helpI18n?: Record<string, string>;
};

export type AddCardCustomFieldRequest = {
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired?: boolean;
};

// --- Phase 6: WRICEF Framework Skeleton — Interfaces (notifications) -----
// Logged/stubbed only, per the plan doc's own wording — see
// 0009_wricef_fields_notifications_forms.sql's header comment and
// KNOWN_ISSUES.md for what "real provider" means when it's built.

export type NotificationChannel = "email" | "whatsapp" | "push" | "in_app";

export type DispatchNotificationRequest = {
  channel: NotificationChannel;
  recipient: string;
  templateKey: string;
  payload?: Record<string, unknown>;
};

export type NotificationLogEntry = {
  id: string;
  companyId: string;
  channel: NotificationChannel;
  recipient: string;
  templateKey: string;
  payload: Record<string, unknown>;
  status: "logged" | "sent" | "failed";
  createdAt: string;
};

// --- Phase 6: WRICEF Framework Skeleton — Forms (document templates) -----

export type DocumentTemplate = {
  id: string;
  companyId: string;
  key: string;
  name: string;
  objectKey: string;
  templateBody: string;
  createdAt: string;
};

export type CreateDocumentTemplateRequest = {
  key: string;
  name: string;
  objectKey: string;
  templateBody: string;
};

export type RenderDocumentRequest = {
  templateKey: string;
  record: Record<string, unknown>;
};

export type RenderedDocument = {
  templateKey: string;
  content: string;
};

// --- Phase 6: WRICEF Framework Skeleton — Conversions (import/export) ----
// No dedicated types beyond this — ImportExportService works generically
// against whatever column/DTO shape a caller hands it (see
// apps/api/src/import-export/import-export.service.ts).

export type CsvImportRowError = {
  row: number;
  message: string;
};

export type CsvImportResult<T> = {
  imported: number;
  rows: T[];
  errors: CsvImportRowError[];
};

// --- Phase 7: Employee Core -------------------------------------------
// The first real HR object — plan doc Section 5 (the Employee Number
// rules) and Section 7's Phase 7 row. `EmployeeView` is what the API
// actually returns: a sensitive field the caller's role can't see is
// OMITTED from the object entirely (see RbacService.filterRecordFields
// and its Phase 7 sibling filterRecordFieldsWithScope), so every
// sensitive field below is typed optional, not nullable — `"cnic" in
// employee` is the real presence check, not `employee.cnic != null`.

/** EMP-06: system states plus catalog-defined states (employment_status catalog). */
export type EmploymentStatus = "active" | "on_leave" | "terminated" | "suspended" | "notice_period" | (string & {});

// Phase 8 addition (plan doc Section 12's own canonical example names both
// "location" and "employment type" as attributes a tenant would group
// employees by) — a real employee attribute, not scaffolding invented only
// to make Employee Groups have something to condition on.
//
// Widened from a 4-value literal union to `string` as part of HR
// Administration v2 (2026-09-27): `employment_type` used to be a
// hardcoded `CHECK` constraint on `employees` (exactly these 4 values,
// enforceable only by a migration) — the v2 spec's Section 38 explicitly
// lists "tenant-specific requiredness" among what must never be
// hard-coded. It's now a tenant-editable `hr_reference_catalog_items`
// catalog (seeded with these same 4 values so no existing data changes
// meaning), validated at the service layer instead of the database, so
// the type can no longer promise a closed set. `permanent`/`contract`/
// `probation`/`intern` remain every existing tenant's seeded starting
// values — this comment is not a lie, just no longer enforced by the
// compiler.
export type EmploymentType = string;

export type EmployeeView = {
  id: string;
  companyId: string;
  userAccountId: string | null;
  employeeNumber: string;
  /**
   * Core Employee Enterprise Phase 1 addition (0081_person_identity.sql)
   * — a stable identity record standing behind this employee row, so a
   * rehire (or, later, a genuine second concurrent employment) can be
   * linked to the SAME person instead of creating an unrelated duplicate.
   * Set for every employee created through EmployeesService.create()
   * going forward. Nullable rather than always-present — deliberately,
   * the same reason `orgUnitId`/`locationId` above are nullable: a
   * number of employee rows across this codebase are written directly
   * via raw SQL outside EmployeesService (test fixtures today; possibly
   * other integrations later), and this migration doesn't chase down
   * every one of those call sites. `null` means exactly what
   * `orgUnitId: null` already means — this employee hasn't been linked
   * to the canonical record yet. `employees` stays authoritative for
   * identity fields below (firstName/lastName/cnic/dateOfBirth/gender)
   * — `persons` is a derived shadow record kept in sync by
   * PersonsService, not the other way around, until a real Person
   * UI/API exists. See 0081_person_identity.sql's own header comment
   * for why this is additive rather than the "employees becomes a view"
   * shape originally proposed.
   */
  personId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  maritalStatus: string | null;
  department: string | null;
  /**
   * Organization Management Phase 1 addition (0065_organization_units.sql)
   * — nullable, additive. When set, `department` above is kept in sync
   * with this unit's current name by EmployeesService (see
   * `syncDepartmentFromOrgUnit()`), so anything still reading the legacy
   * free-text field never breaks. `null` means this employee hasn't been
   * migrated onto the canonical hierarchy yet — `department` is then
   * whatever free text was typed directly, same as before this phase.
   */
  orgUnitId: string | null;
  /**
   * Organization Management Phase 2 addition
   * (0068_job_position_architecture.sql) — nullable, additive. Set ONLY
   * by PositionsService.assignEmployee()/unassignEmployee() (see that
   * service's own doc comment for why): there is deliberately no
   * `positionId` field on `CreateEmployeeRequest`/`UpdateEmployeeRequest`
   * this phase — occupancy is a Position Workbench action, not a plain
   * employee-record field edit. `null` means this employee doesn't
   * currently occupy any position.
   */
  positionId: string | null;
  designation: string | null;
  location: string | null;
  /**
   * Organization Management Phase 4 addition
   * (0073_locations_and_financial_centers.sql) — nullable, additive. When
   * set, `location` above is kept in sync with this location's current
   * name by EmployeesService (see `resolveLocation()`), the same
   * `orgUnitId`/`department` relationship Phase 1 established. `null`
   * means this employee hasn't been linked to the canonical location
   * hierarchy yet — `location` is then whatever free text was typed
   * directly, same as before this phase.
   */
  locationId: string | null;
  employmentType: EmploymentType;
  /**
   * Untyped self-reference (0010_employee_core.sql) — kept working exactly
   * as-is for backward compatibility (still writable directly via
   * `CreateEmployeeRequest`/`UpdateEmployeeRequest`'s own `managerId`
   * field below). Organization Management Phase 3
   * (0071_employee_org_assignments_and_relationships.sql) adds the
   * canonical, TYPED alternative — `org_relationships` with
   * `relationshipType: 'direct'` — and OrgRelationshipsService syncs THIS
   * field, point-in-time, on every direct-relationship create/update/end
   * (plain SQL across the table boundary, exactly PositionsService's own
   * `employees.positionId` precedent — see that service's class doc
   * comment). This is a WRITE-ONLY, point-in-time sync, not a live view:
   * editing this field directly (the legacy path, still supported) does
   * NOT create or update a corresponding `org_relationships` row — a
   * documented, deliberate gap, not an oversight (see
   * org-relationships.service.ts's own header comment).
   */
  managerId: string | null;
  employmentStatus: EmploymentStatus;
  dateOfJoining: string;
  terminationDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sensitive — present only when the caller's field-level access resolves to non-"hidden". */
  cnic?: string | null;
  dateOfBirth?: string | null;
  salaryBand?: string | null;
  bankAccountNumber?: string | null;
  terminationReason?: string | null;
};

export type CreateEmployeeRequest = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  cnic?: string;
  /** EMP-02 - link to an existing person (rehire / second employment). */
  personId?: string;
  /** EMP-02 - confirm a possible-duplicate warning is a different human. */
  confirmNotDuplicate?: boolean;
  /** LIF-06 - HR override of a "not eligible for rehire" record; recorded in the audit log. */
  rehireOverrideReason?: string;
  dateOfBirth?: string;
  gender?: string;
  maritalStatus?: string;
  department?: string;
  /** Organization Management Phase 1 — set this instead of (or alongside)
   * `department` to link the employee to a canonical org unit; the
   * server derives/overwrites `department`'s text from it. */
  orgUnitId?: string;
  designation?: string;
  location?: string;
  /** Organization Management Phase 4 — set this instead of (or alongside)
   * `location` to link the employee to a canonical location; the server
   * derives/overwrites `location`'s text from it. */
  locationId?: string;
  employmentType?: EmploymentType;
  managerId?: string;
  dateOfJoining?: string;
  salaryBand?: string;
  bankAccountNumber?: string;
  userAccountId?: string;
  /**
   * Set only when preserving a client's pre-existing legacy staff number
   * during migration (plan doc Section 5's "bulk import must support
   * preserving... not only auto-generating fresh ones"). Omitted (the
   * normal case): EmployeesService assigns the next number from the
   * company's own configured format/sequence automatically.
   */
  employeeNumber?: string;
};

export type UpdateEmployeeRequest = Partial<
  Omit<CreateEmployeeRequest, "employeeNumber" | "userAccountId">
> & {
  employmentStatus?: EmploymentStatus;
  terminationDate?: string;
  terminationReason?: string;
};

/**
 * The four real tenant RBAC roles (0011_employee_seed.sql,
 * 0024_system_admin.sql) — deliberately excludes the `rbac_demo_*`
 * proof-of-concept roles from Phase 4, which `EmployeesService.createLogin()`
 * refuses to grant (see Decision #12). `system_admin` (Decision #20) was
 * added additively alongside the original three, not in place of any of
 * them.
 */
export type TenantRoleKey = "hr_admin" | "line_manager" | "employee_self_service" | "ess_portal" | "system_admin" | "payroll_approver";

/**
 * Decision #12: before this, there was no way for an Employee record to
 * get an actual login — `AuthService`'s real `/auth/login` flow only ever
 * recognized Platform Admin and Company (Super) Admin identities, and a
 * Company Admin's own login carried no `user_role_assignments` row at
 * all, so it held zero permissions against any Phase 4+ module. This is
 * the tenant-scoped, HR-Admin-self-service counterpart to the
 * Platform-Admin-only `POST /platform/role-assignments` endpoint —
 * `EmployeesService.createLogin()` creates the `user_accounts` row AND
 * grants role(s) in one call, gated by `employee.manage.all` so an HR
 * Admin never needs a Platform Admin or a database console to onboard
 * their own tenant's users.
 */
export type CreateEmployeeLoginRequest = {
  initialPassword: string;
  roleKeys: TenantRoleKey[];
};

export type CreateEmployeeLoginResponse = {
  employee: EmployeeView;
  rolesGranted: TenantRoleKey[];
};

// --- Core Employee Enterprise Phase 2: Hiring Process Engine -----------
// See apps/api/migrations/0082_hiring_process_engine.sql and
// employees/hiring/hiring-process.service.ts for the full design. Scoped
// state machine (Section 10 of the spec, minus the approval branch —
// deferred until a later phase wires real per-card Workflow approval).

export type HireProcessStatus =
  | "draft"
  | "in_progress"
  | "validation_required"
  | "ready_for_completion"
  | "submitted"
  | "approved"
  | "rejected"
  | "hired"
  | "failed"
  | "cancelled";
export type HireValidationState = "unvalidated" | "valid" | "invalid";
export type HireProcessStatusHistoryEntry = {
  id: string;
  fromStatus: HireProcessStatus | null;
  toStatus: HireProcessStatus;
  actorUserAccountId: string | null;
  reason: string | null;
  createdAt: string;
};
export type StartHireProcessRequest = {
  hireReasonCode?: string;
  effectiveHireDate?: string;
  plannedEndDate?: string;
};
export type RejectHireProcessRequest = { reason: string };
export type TransferHireOwnershipRequest = { ownerUserAccountId: string; reason?: string };
export type SetHireDelegateRequest = { delegateUserAccountId: string | null };
export type HireProcessValidationResult = {
  hireProcessId: string;
  validationState: HireValidationState;
  validatedAt: string;
  cards: { cardKey: string; validationState: HireValidationState; errors: string[] }[];
};

export type CardDefinitionView = {
  cardKey: string;
  label: string;
  description: string | null;
  dependsOnCardKey: string | null;
  displayOrder: number;
  isEnabled: boolean;
  isRequired: boolean;
  /** CFG-11 metadata */
  applicabilityRule: CardRuleSlot;
  workflowTemplateKey: string | null;
  isEffectiveDated: boolean;
  attachmentRequirement: "none" | "optional" | "required";
  editableAfterSave: boolean;
  isCompletionGate: boolean;
  visibilityRule: CardRuleSlot;
  validationRuleKeys: string[];
  defaultRuleKeys: string[];
  displayNameI18n: Record<string, string>;
  configStatus: "draft" | "validated" | "published" | "retired";
  configVersion: number;
};

export type HireProcessCardView = {
  cardKey: string;
  /** "pending" (untouched) | "saved" (data persisted) | "complete" (satisfies this phase's completion rule — see HiringProcessService). */
  status: "pending" | "saved" | "complete";
  savedAt: string | null;
  validationState: HireValidationState;
  validationErrors: string[];
  completedAt: string | null;
  definition: CardDefinitionView;
};

export type HireProcessView = {
  id: string;
  companyId: string;
  status: HireProcessStatus;
  currentCardKey: string | null;
  revision: number;
  employeeId: string | null;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  ownerUserAccountId: string | null;
  delegateUserAccountId: string | null;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  validationState: HireValidationState;
  hireReasonCode: string | null;
  effectiveHireDate: string | null;
  plannedEndDate: string | null;
  reservedEmployeeNumber: string | null;
  failureReason: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  /** the published configuration version the process was started under, if one existed */
  configurationVersionId: string | null;
  cards: HireProcessCardView[];
};

export type HireProcessCardDataView = {
  cardKey: string;
  data: Record<string, unknown>;
  revision: number;
  updatedAt: string;
};

export type SaveHireProcessCardRequest = {
  data: Record<string, unknown>;
  /**
   * Optimistic-lock check (spec Section 25) — omit only for a card's
   * very first save (no prior revision exists to conflict with).
   * Mismatched against the stored revision throws a 409.
   */
  expectedRevision?: number;
};

/** Phase 3 — Configuration Center's own scoped admin surface: enable/disable and reorder, per kumail's scoping decision. Requiredness is also editable; per-field rules are not (deferred, per that same decision). */
export type UpdateCardDefinitionRequest = {
  isEnabled?: boolean;
  isRequired?: boolean;
  displayOrder?: number;
  applicabilityRule?: CardRuleSlot;
  workflowTemplateKey?: string | null;
  isEffectiveDated?: boolean;
  attachmentRequirement?: "none" | "optional" | "required";
  editableAfterSave?: boolean;
  isCompletionGate?: boolean;
  visibilityRule?: CardRuleSlot;
  validationRuleKeys?: string[];
  defaultRuleKeys?: string[];
  displayNameI18n?: Record<string, string>;
  configStatus?: "draft" | "validated" | "published" | "retired";
};

/** Phase 6 — Contact card (0084_core_employee_contact_address.sql). */
export type EmployeeContactType = "business_email" | "personal_email" | "business_phone" | "personal_phone" | "emergency_contact";

export type EmployeeContactView = {
  id: string;
  companyId: string;
  employeeId: string;
  contactType: EmployeeContactType;
  label: string | null;
  value: string;
  isPrimary: boolean;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeContactRequest = {
  employeeId: string;
  contactType: EmployeeContactType;
  value: string;
  label?: string;
  isPrimary?: boolean;
};

export type UpdateEmployeeContactRequest = {
  value?: string;
  label?: string | null;
  isPrimary?: boolean;
};

/** Phase 6 — Addresses card. At most one open row per {employee, addressType} — see the migration's own header comment. */
export type EmployeeAddressType = "permanent" | "current" | "mailing";

export type EmployeeAddressView = {
  id: string;
  companyId: string;
  employeeId: string;
  addressType: EmployeeAddressType;
  line1: string;
  line2: string | null;
  city: string | null;
  stateProvince: string | null;
  postalCode: string | null;
  country: string | null;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeAddressRequest = {
  employeeId: string;
  addressType: EmployeeAddressType;
  line1: string;
  line2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
};

export type UpdateEmployeeAddressRequest = Partial<Omit<CreateEmployeeAddressRequest, "employeeId" | "addressType">>;

/** Phase 7 — Important Dates card (0085_core_employee_important_dates.sql). At most one open row per {employee, dateType}, EXCEPT `document_expiry` which may have several. */
export type EmployeeImportantDateType = "joining" | "confirmation" | "probation_end" | "contract_end" | "document_expiry";

export type EmployeeImportantDateView = {
  id: string;
  companyId: string;
  employeeId: string;
  dateType: EmployeeImportantDateType;
  dateValue: string;
  label: string | null;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeImportantDateRequest = {
  employeeId: string;
  dateType: EmployeeImportantDateType;
  dateValue: string;
  label?: string;
};

export type UpdateEmployeeImportantDateRequest = {
  dateValue?: string;
  label?: string;
};

/** Phase 8 — Payment/Bank card (0086_core_employee_payment_cost_allocation.sql). At most one open primary per employee. */
export type EmployeePaymentMethod = "bank_transfer" | "cash" | "cheque";

export type EmployeePaymentAccountView = {
  id: string;
  companyId: string;
  employeeId: string;
  paymentMethod: EmployeePaymentMethod;
  bankName: string | null;
  accountTitle: string | null;
  accountNumber: string | null;
  iban: string | null;
  branchCode: string | null;
  isPrimary: boolean;
  status: "active" | "ended";
  /** EMP-08 */
  validFrom: string;
  validTo: string | null;
  priority: number;
  splitPercent: number | null;
  currency: string;
  bankKey: string | null;
  bankCountry: string;
  verificationStatus: EmployeePaymentVerificationStatus;
  verifiedAt: string | null;
  approvalStatus: EmployeePaymentApprovalStatus;
  submittedByUserAccountId: string | null;
  approvedByUserAccountId: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  /** set on a pending replacement: the primary account it will supersede once approved */
  replacesAccountId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmployeePaymentVerificationStatus = "unverified" | "verified" | "failed";
export type EmployeePaymentApprovalStatus = "pending" | "approved" | "rejected";

export type CreateEmployeePaymentAccountRequest = {
  employeeId: string;
  paymentMethod: EmployeePaymentMethod;
  bankName?: string;
  accountTitle?: string;
  accountNumber?: string;
  iban?: string;
  branchCode?: string;
  isPrimary?: boolean;
  validFrom?: string;
  validTo?: string;
  priority?: number;
  /** 0 < n <= 100; live splits of one employee may not exceed 100 in total */
  splitPercent?: number;
  currency?: string;
  bankKey?: string;
  bankCountry?: string;
};

export type RejectEmployeePaymentAccountRequest = { reason: string };
export type VerifyEmployeePaymentAccountRequest = { status: EmployeePaymentVerificationStatus };

export type UpdateEmployeePaymentAccountRequest = Partial<Omit<CreateEmployeePaymentAccountRequest, "employeeId">>;

/** Phase 8 — Cost Allocation card. Multiple OPEN rows per employee are normal (split costing); at most one is primary. */
export type EmployeeCostAllocationView = {
  id: string;
  companyId: string;
  employeeId: string;
  costCenterId: string;
  allocationPercentage: number;
  isPrimary: boolean;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeCostAllocationRequest = {
  employeeId: string;
  costCenterId: string;
  allocationPercentage: number;
  isPrimary?: boolean;
};

export type UpdateEmployeeCostAllocationRequest = {
  allocationPercentage?: number;
  isPrimary?: boolean;
};

/** Phase 9 — Family/Dependents card (0087_core_employee_family_education_qualifications_assets.sql). A list entity: no one-row-per-employee constraint. */
export type EmployeeFamilyRelationship = "spouse" | "child" | "parent" | "sibling" | "other";

export type EmployeeFamilyMemberView = {
  id: string;
  companyId: string;
  employeeId: string;
  relationship: EmployeeFamilyRelationship;
  fullName: string;
  dateOfBirth: string | null;
  cnic: string | null;
  isDependent: boolean;
  isBeneficiary: boolean;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeFamilyMemberRequest = {
  employeeId: string;
  relationship: EmployeeFamilyRelationship;
  fullName: string;
  dateOfBirth?: string;
  cnic?: string;
  isDependent?: boolean;
  isBeneficiary?: boolean;
};

export type UpdateEmployeeFamilyMemberRequest = Partial<Omit<CreateEmployeeFamilyMemberRequest, "employeeId">>;

/** Phase 9 — Education card. A list entity (education history). */
export type EmployeeEducationView = {
  id: string;
  companyId: string;
  employeeId: string;
  degreeTitle: string;
  institution: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  grade: string | null;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeEducationRequest = {
  employeeId: string;
  degreeTitle: string;
  institution?: string;
  fieldOfStudy?: string;
  startDate?: string;
  endDate?: string;
  grade?: string;
};

export type UpdateEmployeeEducationRequest = Partial<Omit<CreateEmployeeEducationRequest, "employeeId">>;

/** Phase 9 — Qualifications/Skills card. A list entity. */
export type EmployeeQualificationType = "certificate" | "license" | "skill";

export type EmployeeQualificationView = {
  id: string;
  companyId: string;
  employeeId: string;
  qualificationType: EmployeeQualificationType;
  title: string;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  proficiencyLevel: string | null;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeQualificationRequest = {
  employeeId: string;
  qualificationType: EmployeeQualificationType;
  title: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiryDate?: string;
  proficiencyLevel?: string;
};

export type UpdateEmployeeQualificationRequest = Partial<Omit<CreateEmployeeQualificationRequest, "employeeId">>;

/** Phase 9 — Assets card. A list entity; `status` tracks the assignment's own lifecycle (assigned/returned) on the same row. */
export type EmployeeAssetView = {
  id: string;
  companyId: string;
  employeeId: string;
  assetType: string;
  assetTag: string | null;
  description: string | null;
  assignedDate: string;
  returnedDate: string | null;
  status: "assigned" | "returned";
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeAssetRequest = {
  employeeId: string;
  assetType: string;
  assetTag?: string;
  description?: string;
  assignedDate?: string;
};

export type UpdateEmployeeAssetRequest = {
  assetTag?: string;
  description?: string;
};

export type OrgChartNode = {
  id: string;
  employeeNumber: string;
  fullName: string;
  designation: string | null;
  department: string | null;
  directReports: OrgChartNode[];
};

/**
 * "My Org Chart" (Employee Self Service, 2026-10): a person's own place in the organization, like the SAP ESS org chart.
 * Public fields only (name, designation, department); nothing about pay, contact or personal data.
 * An employee sees their manager chain, peers (same manager) and direct reports. A manager's `downline` spans every
 * department their people sit in, and `departments` lists each department they cover or head.
 */
export type MyOrgChartPerson = {
  id: string;
  employeeNumber: string;
  fullName: string;
  designation: string | null;
  department: string | null;
};
export type MyOrgChartNode = MyOrgChartPerson & { directReports: MyOrgChartNode[] };
export type MyOrgChart = {
  me: MyOrgChartPerson;
  /** From the top of the line down to the person's own manager (empty for the top person). */
  managerChain: MyOrgChartPerson[];
  /** People who report to the same manager. */
  peers: MyOrgChartPerson[];
  /** The person's own reports with their reports below them, across every department. */
  downline: MyOrgChartNode[];
  /** Departments the person belongs to, heads, or whose people report to them. */
  departments: string[];
  /** True when the downline was cut at the size limit. */
  truncated: boolean;
};

export type EmployeeDocumentView = {
  id: string;
  employeeId: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

// Core Employee Enterprise Phase 10 (0088_core_employee_lifecycle_transactions.sql)
// widened this vocabulary with the 6 values below ('demotion' through
// 'reactivation') for EmployeeLifecycleService's own explicit, named
// transactions — see that migration's own header comment for why the
// pre-existing 7 values (used by EmployeesService.autoRecordJobHistory()'s
// field-diff inference, unchanged) keep working exactly as before.
export type JobHistoryEventType =
  | "hire"
  | "promotion"
  | "transfer"
  | "salary_change"
  | "termination"
  | "rehire"
  | "other"
  | "demotion"
  | "secondment"
  | "acting"
  | "manager_change"
  | "location_change"
  | "reactivation"
  // Cross-module integration follow-up (2026-10-01) — written only by
  // `PositionsService.assignEmployee()` (the Position Workbench) when the
  // assignment moves the employee into a seat in a different org unit;
  // see 0104_employee_job_history_position_assignment_event.sql.
  | "position_assignment";

export type JobHistoryEntryView = {
  id: string;
  employeeId: string;
  eventType: JobHistoryEventType;
  effectiveDate: string;
  department: string | null;
  designation: string | null;
  salaryBand?: string | null;
  notes: string | null;
  createdAt: string;
  // Phase 10 — set only for 'secondment'/'acting' rows (both temporary by
  // nature); null for every other event type.
  endDate?: string | null;
  // HR Administration v2 — the selected `hr_reference_catalog_items.code`
  // for this transaction's mapped `lifecycle_reason:*` catalog, when one
  // was supplied. Null for older rows (the column is additive) and for
  // any call that didn't supply a reason.
  reasonCode?: string | null;
};

export type RecordJobHistoryRequest = {
  eventType: JobHistoryEventType;
  effectiveDate: string;
  department?: string;
  designation?: string;
  salaryBand?: string;
  notes?: string;
};

// --- Core Employee Enterprise Phase 10: Explicit Lifecycle Transactions ---
// Each request below drives one EmployeeLifecycleService method. Unlike
// EmployeesService.update()'s generic PATCH (which infers a job-history
// event from whatever changed), each of these names its own intent up
// front, so the employee_job_history row it writes records that intent
// exactly rather than a guess — see EmployeeLifecycleService's own class
// doc comment.

// HR Administration v2 — every request below also accepts an optional
// `reasonCode`, validated by EmployeeLifecycleService against that
// transaction's mapped `lifecycle_reason:*` HR Administration catalog
// (HrReferenceCatalogService) when supplied, and stored on the resulting
// `employee_job_history` row. Optional and additive: a caller that omits
// it behaves exactly as before this phase.

export type TransferEmployeeRequest = {
  orgUnitId?: string;
  department?: string;
  locationId?: string;
  location?: string;
  /** Cross-module integration audit Item 2 (2026-10-01) — optional new
   * (vacant) Position; the old seat is vacated and the primary org
   * assignment replaced in the same transaction. */
  positionId?: string;
  effectiveDate: string;
  reasonCode?: string;
  notes?: string;
};

export type PromoteEmployeeRequest = {
  designation: string;
  salaryBand?: string;
  /** Optional new (vacant) Position — see TransferEmployeeRequest.positionId. */
  positionId?: string;
  effectiveDate: string;
  reasonCode?: string;
  notes?: string;
};

export type DemoteEmployeeRequest = {
  designation: string;
  salaryBand?: string;
  /** Optional new (vacant) Position — see TransferEmployeeRequest.positionId. */
  positionId?: string;
  effectiveDate: string;
  reasonCode?: string;
  notes?: string;
};

// Secondment/Acting both name an end date (spec Section 26) — the
// temporary posting/role reverts automatically in intent (not enforced by
// a scheduler in this phase; `endDate` is a descriptive fact on the
// history row, same scope decision as Section 26's other transactions).
export type SecondEmployeeRequest = {
  orgUnitId?: string;
  department?: string;
  designation?: string;
  locationId?: string;
  location?: string;
  /** Optional host-side supervisor — creates a `temporary` org relationship. */
  managerEmployeeId?: string;
  effectiveDate: string;
  endDate: string;
  reasonCode?: string;
  notes?: string;
};

export type AssignActingRoleRequest = {
  designation: string;
  orgUnitId?: string;
  department?: string;
  /** Position acted in — recorded on the `acting` assignment, NOT occupied. */
  positionId?: string;
  /** Optional supervisor for the acting period — an `acting` org relationship. */
  managerEmployeeId?: string;
  effectiveDate: string;
  endDate: string;
  reasonCode?: string;
  notes?: string;
};

export type ChangeEmployeeManagerRequest = {
  managerId: string;
  effectiveDate: string;
  reasonCode?: string;
  notes?: string;
};

export type ChangeEmployeeLocationRequest = {
  locationId: string;
  effectiveDate: string;
  reasonCode?: string;
  notes?: string;
};

export type TerminateEmployeeRequest = {
  terminationDate: string;
  terminationReason?: string;
  reasonCode?: string;
  notes?: string;
};

export type ReactivateEmployeeRequest = {
  effectiveDate: string;
  reasonCode?: string;
  notes?: string;
  /** LIF-06 - HR override of a "not eligible for rehire" record; recorded in the audit log. */
  rehireOverrideReason?: string;
};

export type LifecycleEventStatus = "scheduled" | "applied" | "failed" | "cancelled";
export type LifecycleEventChannel = "ui" | "api" | "hire_process" | "offboarding" | "scheduler" | "bulk_import" | "system" | "backfill";

/** LIF-01: one lifecycle action as recorded. Applied/cancelled events are immutable. */
export type LifecycleEventView = {
  id: string;
  employeeId: string;
  employmentId: string | null;
  /** Job-history event types plus "correction". */
  actionType: string;
  reasonCode: string | null;
  effectiveDate: string;
  plannedEndDate: string | null;
  status: LifecycleEventStatus;
  sourceChannel: LifecycleEventChannel;
  workflowInstanceId: string | null;
  /** LIF-04: the event this one corrects (the original is never rewritten). */
  correctsEventId: string | null;
  /** LIF-04: set when a later applied correction supersedes this event. */
  correctedByEventId: string | null;
  jobHistoryId: string | null;
  requestedByUserAccountId: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  notes: string | null;
  failureReason: string | null;
  appliedAt: string | null;
  createdAt: string;
};

export type LifecycleTransactionResult = {
  employee: EmployeeView;
  /** null while the action is only scheduled (future effective date). */
  jobHistory: JobHistoryEntryView | null;
  event: LifecycleEventView;
};

export type CorrectLifecycleEventRequest = {
  /** Fields of the original request to change (e.g. designation, orgUnitId). */
  changes: Record<string, unknown>;
  effectiveDate?: string;
  reason: string;
};

export type CancelLifecycleEventRequest = { reason?: string };

// --- HR Administration Reference Catalog (Core Employee Configuration/
// HR-Admin v2, 2026-09-27) ------------------------------------------------
// See `hr-administration/catalog-type-registry.ts` on the API side for the
// full list of registered `catalogType` values (currently `employment_type`
// plus 19 `lifecycle_reason:*` types from spec Section 6.2) and their
// group/display labels — deliberately not duplicated as a literal union
// here, the same reasoning as `EmploymentType` above: new catalog types are
// meant to be added to that registry alone, without a shared-types change.

export type HrReferenceCatalogItemView = {
  id: string;
  companyId: string;
  catalogType: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  /** CAT-01: first/last date the item may be chosen (null = unbounded). */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** CAT-01: free-form scope rules, e.g. { employmentTypes: ["permanent"] }. */
  applicability: Record<string, unknown>;
  /** CAT-01: localized labels keyed by locale, e.g. { ur: "..." }. */
  labels: Record<string, string>;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HrReferenceCatalogItemUsage = { itemId: string; usageCount: number; canRemove: boolean };

export type HrReferenceCatalogTypeSummary = {
  catalogType: string;
  groupLabel: string;
  label: string;
  description: string;
  activeCount: number;
};

export type CreateHrReferenceCatalogItemRequest = {
  catalogType: string;
  code: string;
  label: string;
  description?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  applicability?: Record<string, unknown>;
  labels?: Record<string, string>;
};

export type UpdateHrReferenceCatalogItemRequest = {
  label?: string;
  description?: string;
  isActive?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  applicability?: Record<string, unknown>;
  labels?: Record<string, string>;
};

export type ReorderHrReferenceCatalogItemsRequest = {
  orderedIds: string[];
};

// --- HR Administration v2 "then 2" Phase 2 (2026-10-02) — Business
// Policies, gap-table item #8. See hr-business-policy.service.ts's own
// class doc comment for the full design rationale (named, rules-carrying
// objects, one generic table, exactly-one-default-per-type-per-company).
export type HrBusinessPolicyView = {
  id: string;
  companyId: string;
  policyType: string;
  code: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
  isDefault: boolean;
  sortOrder: number;
  isActive: boolean;
  /** CAT-07: window in which this policy applies (null = unbounded). */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** CAT-07: who the policy applies to, e.g. { employmentTypes: ["probation"] }. */
  applicability: Record<string, unknown>;
  /** CAT-07: bumped each time `rules` changes. */
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type HrBusinessPolicyTypeSummary = {
  policyType: string;
  label: string;
  description: string;
  rulesShape: string;
  wiredInto: string;
  policyCount: number;
  hasDefault: boolean;
};

export type CreateHrBusinessPolicyRequest = {
  policyType: string;
  code: string;
  name: string;
  description?: string;
  rules?: Record<string, unknown>;
  isDefault?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  applicability?: Record<string, unknown>;
};

export type UpdateHrBusinessPolicyRequest = {
  name?: string;
  description?: string;
  rules?: Record<string, unknown>;
  isDefault?: boolean;
  isActive?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  applicability?: Record<string, unknown>;
};

export type ReorderHrBusinessPoliciesRequest = {
  orderedIds: string[];
};

// --- HR Administration v2 "then 2" Phases 4+5 (2026-10-02, consolidated)
// — Configuration Hierarchy & Resolution / Mapping Engine, gap-table
// items #11+#12. See configuration-rule-mapping.service.ts's own class
// doc comment, and 0109_configuration_rule_mappings.sql's header
// comment, for the full design rationale and the deliberate scope-level
// bounding (org_unit/location/employee only).
export type ConfigurationRuleMappingScopeType =
  | "org_unit"
  | "location"
  | "employee"
  // CFG-05
  | "tenant"
  | "employee_group"
  | "position"
  | "job";

export type ConfigurationRuleMappingView = {
  id: string;
  companyId: string;
  configDomain: string;
  configKey: string;
  scopeType: ConfigurationRuleMappingScopeType;
  scopeValue: string;
  ruleValue: Record<string, unknown>;
  /** Lower number wins among overrides of the same specificity. Default 100. */
  priority: number;
  isActive: boolean;
  /** CFG-04 */
  scopeId: string | null;
  objectType: string | null;
  objectId: string | null;
  fieldKey: string | null;
  ruleType: string | null;
  ruleReference: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  configurationVersion: number | null;
  status: "draft" | "active" | "retired";
  changeReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateConfigurationRuleMappingRequest = {
  configDomain: string;
  configKey: string;
  scopeType: ConfigurationRuleMappingScopeType;
  scopeValue: string;
  ruleValue?: Record<string, unknown>;
  priority?: number;
  objectType?: string;
  objectId?: string;
  fieldKey?: string;
  ruleType?: string;
  ruleReference?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  changeReason?: string;
};

export type UpdateConfigurationRuleMappingRequest = {
  ruleValue?: Record<string, unknown>;
  priority?: number;
  isActive?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  changeReason?: string;
};

/** What the resolver is told about the subject (CFG-05). Anything omitted that can be derived from employeeId is. */
export type ConfigurationResolutionContext = {
  employeeId?: string | null;
  locationId?: string | null;
  orgUnitId?: string | null;
  positionId?: string | null;
  jobId?: string | null;
  employeeGroupIds?: string[];
  /** YYYY-MM-DD; defaults to today. */
  asOf?: string;
};

/** One layer considered while resolving (CFG-05 provenance). */
export type ConfigurationProvenanceEntry = {
  layer: ConfigurationRuleMappingScopeType | "default";
  scopeValue: string | null;
  ruleId: string | null;
  ruleValue: Record<string, unknown>;
  priority: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** true for every matching layer except the one that won */
  shadowed: boolean;
};

export type ResolvedConfiguration = {
  /** baseValue with the winning override's keys laid over it */
  value: Record<string, unknown>;
  winner: ConfigurationProvenanceEntry | null;
  /** most specific first; ends with the default layer */
  chain: ConfigurationProvenanceEntry[];
  asOf: string;
};

// The resolution primitive's return shape — the single most specific
// ACTIVE override that matched, or null (caller falls back to the
// plain company-wide default).
export type ResolvedConfigurationOverride = {
  scopeType: ConfigurationRuleMappingScopeType;
  scopeValue: string;
  ruleValue: Record<string, unknown>;
};

// --- HR Administration v2 "then 2" Phase 6 (2026-10-02) — Configuration
// Publish Lifecycle, gap-table item #13. See
// configuration-change-request.service.ts's own class doc comment, and
// 0110_configuration_change_requests.sql's header comment, for the full
// design rationale (a wrapper lifecycle around the three existing
// configuration engines, not a rearchitecture of any of them; the
// deliberate merging of Validate/Dependency-Check/Impact-Preview into one
// `validate()` call and of Effective-Date/Active into one `published`
// state).
export type ConfigurationChangeDomain = "hr_reference_catalog_item" | "hr_business_policy" | "configuration_rule_mapping";
export type ConfigurationChangeOperation = "create" | "update" | "deactivate";
export type ConfigurationChangeStatus = "draft" | "validated" | "pending_approval" | "approved" | "rejected" | "published" | "retired";

export type ConfigurationChangeValidationResult = {
  hasBlockingIssues: boolean;
  warnings: string[];
  impactPreview: string;
};

export type ConfigurationChangeRequestView = {
  id: string;
  companyId: string;
  configDomain: ConfigurationChangeDomain;
  operation: ConfigurationChangeOperation;
  targetId: string | null;
  payload: Record<string, unknown>;
  status: ConfigurationChangeStatus;
  effectiveFrom: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  validationResult: ConfigurationChangeValidationResult | null;
  rejectionReason: string | null;
  previousChangeId: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  /** CFG-07: what publishing would touch; approval needs this to exist. */
  impactSummary: string[] | null;
  affectedCounts: Record<string, number> | null;
  riskLevel: "low" | "medium" | "high" | null;
  impactComputedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateConfigurationChangeRequestRequest = {
  configDomain: ConfigurationChangeDomain;
  operation: ConfigurationChangeOperation;
  targetId?: string;
  payload?: Record<string, unknown>;
  effectiveFrom?: string;
};

export type RejectConfigurationChangeRequestRequest = {
  reason: string;
};

// --- Core Employee Enterprise Phase 11: Sensitivity Tier Classification ---
// Gap #10 from the audit: a real flat role-based field permission engine
// already exists (`field_permission_rules`, enforced by
// `RbacService.filterRecordFields()`/`filterRecordFieldsWithScope()`) and
// already applies to every one of `EmployeesService`'s `SENSITIVE_FIELDS`
// — what was missing was a NAMED classification on top of it (so a field
// is labeled "this is Restricted data," independent of which roles a
// given tenant happens to grant view/edit on it) and view-audit-logging
// for the two most sensitive tiers. This is a FIXED, spec-defined
// vocabulary (Normal/Confidential/Restricted/Highly Restricted), not
// tenant-configurable data — the same "closed vocabulary → union type,
// not a lookup table" call every other closed list in this codebase
// (job history event types, employee document types, ...) already made.
export type FieldSensitivityTier = "normal" | "confidential" | "restricted" | "highly_restricted";

export type EmployeeFieldSensitivityEntry = {
  fieldKey: string;
  tier: FieldSensitivityTier;
};

// --- Core Employee Enterprise Phase 12: Workforce Analytics ---------------
// A single read-only summary, the same "one dashboard-shaped aggregate
// query set, not a generic reporting engine" scope
// `OrganizationCommandCenterService.getSummary()` already established for
// Organization Management's own integrity dashboard. Every count/group
// below is scoped to ACTIVE (non-terminated) employees except
// `terminationsLast90Days` itself, which is exactly the opposite by
// definition.
export type EmployeeHeadcountBreakdown = {
  key: string;
  count: number;
};

export type EmployeeAnalyticsSummary = {
  generatedAt: string;
  totalActiveEmployees: number;
  headcountByDepartment: EmployeeHeadcountBreakdown[];
  headcountByEmploymentType: EmployeeHeadcountBreakdown[];
  genderBreakdown: EmployeeHeadcountBreakdown[];
  /** `null` when no active employee has a `dateOfJoining` set at all
   * (nothing to average) rather than `0`, which would misleadingly read
   * as "everyone joined today." */
  averageTenureYears: number | null;
  terminationsLast90Days: number;
  /** Phase 7's Important Dates card (`joining`/`confirmation`/
   * `probation_end`/`contract_end`/`document_expiry`) due in the next 30
   * days — the same "surface it, don't silently let it lapse" purpose
   * that card's own migration doc comment describes. */
  upcomingImportantDatesNext30Days: number;
  /** Phase 9's Assets card — how many `employee_assets` rows are
   * currently `assigned` (not yet `returned`) company-wide. */
  assetsCurrentlyAssigned: number;
};

// --- Phase 8: Employee Groups & Leave Policy Config -------------------
// Plan doc Section 12: a generic per-group policy resolution mechanism
// that reuses Phase 4's own resolver pattern rather than inventing a
// second one — most-specific-match-wins (a group's specificity is simply
// how many conditions it has), additive combination (independent
// resolution per `PolicyType`, combined by the caller), safe-deny default
// (an unmatched employee falls back to the tenant's explicitly-designated
// default policy for that type, never a guess). See
// 0012_employee_groups_leave_policy.sql's header comment for the full
// design writeup and Decision #8 in DECISIONS.md.

/** The fixed, validated set of employee attributes a group can condition
 * on — matches the CHECK constraint on employee_group_conditions.field.
 * Deliberately not "any employee field" (typo-ing a field name here would
 * otherwise silently produce a condition that can never match). */
/** The first five match the employee's text attributes (kept working unchanged);
 * the last five (CAT-05) match canonical IDs and survive a rename. */
export type EmployeeGroupConditionField =
  | "department"
  | "location"
  | "designation"
  | "employmentType"
  | "employmentStatus"
  | "orgUnitId"
  | "locationId"
  | "positionId"
  | "jobId"
  | "subgroupId";

export type EmployeeGroupCondition = {
  field: EmployeeGroupConditionField;
  equals: string;
};

export type EmployeeGroupView = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  /** ANDed together — a group matches an employee only when EVERY
   * condition matches. Its length is also this group's specificity for
   * most-specific-match-wins resolution. */
  conditions: EmployeeGroupCondition[];
  /** This group's current policy assignments (Task #49's Admin Center UI
   * needs to show "what's assigned right now" without an extra call per
   * group per policyType) — populated the same way `conditions` is, a
   * second batch query alongside the group list, not N+1. */
  policyAssignments: EmployeeGroupPolicyAssignmentView[];
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeGroupRequest = {
  name: string;
  description?: string;
  /** At least one condition is required — a group with zero conditions
   * would match every employee, which is what the tenant-level default
   * policy already exists to express explicitly (see LeavePolicyView.isDefault). */
  conditions: EmployeeGroupCondition[];
};

export type UpdateEmployeeGroupRequest = Partial<CreateEmployeeGroupRequest>;

/** Only "leave" exists yet (Phase 8 builds exactly one concrete policy
 * type to prove the mechanism) — more can be added later without any
 * schema change to employee_groups/employee_group_conditions themselves. */
export type PolicyType =
  | "leave"
  // CAT-06: any HR business policy type can be assigned to a group
  | "probation"
  | "confirmation"
  | "document"
  | "correction"
  | "transfer"
  | "rehire"
  | "termination_exit"
  | "retention"
  | "required_info";

export type EmployeeSubgroupView = {
  id: string;
  companyId: string;
  groupId: string;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

export type CreateEmployeeSubgroupRequest = {
  code: string;
  name: string;
  description?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
};

export type UpdateEmployeeSubgroupRequest = Partial<Omit<CreateEmployeeSubgroupRequest, "code">> & { isActive?: boolean };

export type EmployeeGroupMembershipView = {
  id: string;
  groupId: string;
  employeeId: string;
  source: "rule" | "manual";
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type RefreshGroupMembershipsResult = { added: number; closed: number; currentCount: number };

// annualLeaveDays/casualLeaveDays/sickLeaveDays live on this view for API
// stability, but as of 0033_effective_dating_leave_tax.sql they're sourced
// from this policy's CURRENT leave_policy_versions row, not a column on
// leave_policies itself (see LeavePolicyVersionView below) — the id/name/
// isDefault fields are this policy's stable identity and never version.
export type LeavePolicyView = {
  id: string;
  companyId: string;
  name: string;
  annualLeaveDays: number;
  casualLeaveDays: number;
  sickLeaveDays: number;
  /** TLM-01: every per-leave-type entitlement of the CURRENT version (includes annual / casual / sick). */
  entitlements: LeaveEntitlementView[];
  /** At most one leave policy per tenant may have this set — the
   * safe-deny fallback target when no employee group matches. */
  isDefault: boolean;
  /** The CURRENT version's effective_from — when today's entitlement figures took effect. */
  effectiveFrom: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateLeavePolicyRequest = {
  name: string;
  annualLeaveDays?: number;
  casualLeaveDays?: number;
  sickLeaveDays?: number;
  /** TLM-01: entitlements for any leave type (annual / casual / sick here win over the three legacy fields). */
  entitlements?: LeaveEntitlementInput[];
  isDefault?: boolean;
};

export type UpdateLeavePolicyRequest = Partial<CreateLeavePolicyRequest>;

/** One historical (or current) entitlement version of a leave policy —
 * `GET /leave-policies/:id/history`, ordered oldest first. */
export type LeavePolicyVersionView = {
  id: string;
  policyId: string;
  annualLeaveDays: number;
  casualLeaveDays: number;
  sickLeaveDays: number;
  entitlements?: LeaveEntitlementView[];
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

export type EmployeeGroupPolicyAssignmentView = {
  id: string;
  groupId: string;
  policyType: PolicyType;
  policyId: string;
  /** CAT-06: optional window; resolution ignores the assignment outside it. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
};

export type AssignGroupPolicyRequest = {
  policyType: PolicyType;
  policyId: string;
  effectiveFrom?: string;
  effectiveTo?: string;
};

/** The resolver's own return shape — `groupId: null` and `isDefault: true`
 * together mean "no group matched, the tenant's default policy applied";
 * `policyId: null` means genuinely unconfigured (no group matched AND no
 * default exists for this policyType) — safe-deny, not a guess. */
export type ResolvedPolicyView = {
  policyType: PolicyType;
  policyId: string | null;
  groupId: string | null;
  isDefault: boolean;
};

// --- Phase 9: Leave & Attendance ---------------------------------------
// Plan doc Section 7's own words: "the real go/no-go checkpoint." See
// 0015_leave_attendance.sql for the schema and Decision #9 for the
// design writeup (balance seeding from Phase 8's resolver, overlap
// notices, On-Behalf, manager_of_submitter routing, employee_number-keyed
// clock-in).

/**
 * `unpaid` was added in Phase 12 (see Decision #14 and
 * 0021_leave_unpaid_type.sql) specifically so `PayrollService` has real
 * leave data to compute an unpaid-leave deduction against — it carries no
 * entitlement/balance of its own (`LeaveRequestsService` skips policy
 * resolution and balance checking entirely for it), unlike the other
 * three types.
 */
/**
 * TLM-01: a leave type is a tenant-configurable code (see `LeaveTypeView`), no longer a closed
 * union. The four built-ins are always present for every tenant.
 */
export type LeaveType = string;
export type BuiltInLeaveType = "annual" | "casual" | "sick" | "unpaid";

export type AccrualMethod = "upfront" | "monthly" | "none";
export type LeaveGenderRestriction = "any" | "male" | "female";
export type LeaveDayPart = "full" | "first_half" | "second_half";

export type LeaveTypeView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isPaid: boolean;
  /** false = no entitlement / balance (unpaid): always requestable, never decremented. */
  tracksBalance: boolean;
  accrualMethod: AccrualMethod;
  carryForwardAllowed: boolean;
  carryForwardCapDays: number | null;
  carryForwardExpiryMonths: number | null;
  encashable: boolean;
  documentRequired: boolean;
  /** The document is required only when the request is longer than this many days (0 = always). */
  documentRequiredAfterDays: number;
  genderRestriction: LeaveGenderRestriction;
  minServiceMonths: number;
  halfDayAllowed: boolean;
  maxConsecutiveDays: number | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
};

export type CreateLeaveTypeRequest = {
  code: string;
  name: string;
  description?: string | null;
  isPaid?: boolean;
  tracksBalance?: boolean;
  accrualMethod?: AccrualMethod;
  carryForwardAllowed?: boolean;
  carryForwardCapDays?: number | null;
  carryForwardExpiryMonths?: number | null;
  encashable?: boolean;
  documentRequired?: boolean;
  documentRequiredAfterDays?: number;
  genderRestriction?: LeaveGenderRestriction;
  minServiceMonths?: number;
  halfDayAllowed?: boolean;
  maxConsecutiveDays?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

/** `code` and `isSystem` are immutable. */
export type UpdateLeaveTypeRequest = Partial<Omit<CreateLeaveTypeRequest, "code">>;

export type LeaveEntitlementView = {
  leaveType: string;
  days: number;
  /** null = inherit the leave type's accrual method. */
  accrualMethod: AccrualMethod | null;
  carryForwardCapDays: number | null;
  expiresAfterMonths: number | null;
};

export type LeaveEntitlementInput = {
  leaveType: string;
  days: number;
  accrualMethod?: AccrualMethod | null;
  carryForwardCapDays?: number | null;
  expiresAfterMonths?: number | null;
};

export type LeaveLedgerEntryType = "opening" | "accrual" | "deduction" | "reversal" | "carry_forward" | "adjustment" | "encashment" | "expiry";

export type LeaveLedgerEntryView = {
  id: string;
  employeeId: string;
  leaveType: string;
  year: number;
  entryType: LeaveLedgerEntryType;
  /** Signed: grants / reversals positive, deductions / encashments / expiries negative. */
  days: number;
  effectiveDate: string;
  expiresOn: string | null;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  reason: string | null;
  createdAt: string;
};

export type AdjustLeaveBalanceRequest = {
  employeeId: string;
  leaveType: string;
  year?: number;
  /** Signed number of days. */
  days: number;
  reason: string;
};

export type LeaveBalanceView = {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  leaveTypeName?: string;
  year: number;
  entitledDays: number;
  usedDays: number;
  remainingDays: number;
  /** TLM-02 components of `entitledDays`. */
  openingDays?: number;
  accruedDays?: number;
  carriedForwardDays?: number;
  adjustedDays?: number;
  encashedDays?: number;
  expiredDays?: number;
};

export type LeaveRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type LeaveCancellationStatus = "requested" | "approved" | "declined";

export type OverlapWarning = {
  employeeId: string;
  employeeFullName: string;
  leaveRequestId: string;
  startDate: string;
  endDate: string;
};

export type LeaveRequestView = {
  id: string;
  companyId: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason: string | null;
  status: LeaveRequestStatus;
  submittedByUserAccountId: string;
  /** True when `submittedByUserAccountId` differs from the employee's own
   * `userAccountId` — an On-Behalf submission (HR/a manager submitting
   * for someone who can't use the app themselves), derived rather than
   * separately stored. */
  isOnBehalf: boolean;
  workflowInstanceId: string | null;
  /** TLM-03 */
  dayPart: LeaveDayPart;
  attachmentDocumentId: string | null;
  rejectionReason: string | null;
  /** First day the employee is expected back (first-half leave: the same day). */
  returnDate: string | null;
  delegateEmployeeId: string | null;
  cancellationStatus: LeaveCancellationStatus | null;
  cancellationReason: string | null;
  cancellationRequestedAt: string | null;
  /** true when the leave type is unpaid, i.e. payroll deducts for it. */
  payrollImpact: boolean;
  createdAt: string;
  updatedAt: string;
  /** LV-UP: display fields so the screen never has to look employees up itself. */
  employeeName?: string;
  employeeNumber?: string;
  /** The tenant's own name for the leave type (`leaveType` is only its code). */
  leaveTypeName?: string;
  delegateEmployeeName?: string | null;
  /** Calendar days from start to end, both included (SAP "Absence days"); `daysRequested` is the working days charged. */
  absenceDays?: number;
  /** LV-UP: the approval chain, one entry per approver line, in step order. */
  approvals?: LeaveApprovalLineView[];
};

export type LeaveApprovalLineView = {
  stepOrder: number;
  stepName: string;
  /** A person's name, or the role's name when the line is "anyone holding this role". */
  approverName: string | null;
  status: "pending" | "escalated" | "approved" | "rejected";
  decidedAt: string | null;
};

/** LV-UP: edit a request that is still pending. Omitted fields are left as they are; `delegateEmployeeId: null` clears the relief person. */
export type UpdateLeaveRequestRequest = {
  leaveType?: LeaveType;
  startDate?: string;
  endDate?: string;
  reason?: string | null;
  dayPart?: LeaveDayPart;
  delegateEmployeeId?: string | null;
};

/** LV-UP: a colleague's leave on the team calendar. Dates and status only; never the type or the reason. */
export type TeamLeaveEntryView = {
  leaveRequestId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  startDate: string;
  endDate: string;
  dayPart: LeaveDayPart;
  status: "pending" | "approved";
};

/** LV-UP: who can be named as the relief person - the colleagues under the same manager. */
/** LV-UP: who is expected to approve a new request, shown on the create form before anything is submitted. */
export type LeaveApproverPreviewView = {
  stepOrder: number;
  stepName: string;
  /** Person's name, or the role name when the step is approved by anyone holding a role. */
  approverName: string | null;
};

export type LeaveColleagueView = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
};

export type SubmitLeaveRequestRequest = {
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
  /** Half-day leave: start and end must be the same date. */
  dayPart?: LeaveDayPart;
  attachmentDocumentId?: string;
  delegateEmployeeId?: string;
};

export type RequestLeaveCancellationRequest = { reason: string };
export type DecideLeaveCancellationRequest = { decision: "approved" | "declined"; comment?: string };

export type SubmitLeaveRequestResponse = {
  request: LeaveRequestView;
  /** Non-blocking — plan doc Section 7 calls these "overlap notices," not
   * overlap rejections. Empty when nothing on the same team overlaps. */
  overlapWarnings: OverlapWarning[];
};

export type DecideLeaveRequestRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- Expense Management (Part 2 category 6, UI re-skin build-out 2026-10) ---
// Same shape discipline as Leave above: a View type per real object, and
// Request/Response types only for the service methods whose payload is
// more than "the DTO, verbatim" (submit's response bundles receipts;
// decide/pay are simple enough the DTO IS the request type, same as
// leave's DecideLeaveRequestRequest above).

export type ExpenseCategory =
  | "travel"
  | "meals"
  | "accommodation"
  | "office_supplies"
  | "communication"
  | "training"
  | "other";

export type ExpenseClaimStatus = "draft" | "pending" | "approved" | "rejected" | "paid" | "cancelled";

export type ExpenseReceiptView = {
  id: string;
  expenseClaimId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

export type ExpenseClaimView = {
  id: string;
  companyId: string;
  employeeId: string;
  category: ExpenseCategory;
  expenseDate: string;
  amount: number;
  currency: string;
  description: string | null;
  status: ExpenseClaimStatus;
  submittedByUserAccountId: string | null;
  /** Same derived-not-stored On-Behalf flag as LeaveRequestView.isOnBehalf. */
  isOnBehalf: boolean;
  workflowInstanceId: string | null;
  paidAt: string | null;
  paidByUserAccountId: string | null;
  receipts: ExpenseReceiptView[];
  createdAt: string;
  updatedAt: string;
};

export type SubmitExpenseClaimRequest = {
  employeeId: string;
  category: ExpenseCategory;
  expenseDate: string;
  amount: number;
  currency?: string;
  description?: string;
};

export type DecideExpenseClaimRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- Learning & Development (Part 2 category 7, UI re-skin build-out 2026-10) ---
// Same View/Request shape discipline as Expense Management above.
// `CourseEnrollmentStatus` adds "overdue" on top of the three raw values
// a write actually produces (0116_learning_and_development.sql's own
// header comment on why that's derived, not stored) — the service maps
// a raw DB row into this richer view type, never the reverse.

export type CourseCategory = "compliance" | "technical" | "soft_skills" | "leadership" | "other";

export type CourseView = {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  category: CourseCategory;
  durationMinutes: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateCourseRequest = {
  title: string;
  description?: string;
  category: CourseCategory;
  durationMinutes: number;
};

export type CourseEnrollmentRawStatus = "assigned" | "in_progress" | "completed";

export type CourseEnrollmentStatus = CourseEnrollmentRawStatus | "overdue";

export type CourseEnrollmentView = {
  id: string;
  companyId: string;
  employeeId: string;
  /** The learner's name and number, so a manager's team view can tell people apart. */
  employeeName: string | null;
  employeeNumber: string | null;
  courseId: string;
  course: CourseView;
  status: CourseEnrollmentStatus;
  progressPercent: number;
  dueDate: string | null;
  /** Same derived-not-stored On-Behalf flag as LeaveRequestView.isOnBehalf
   * — true when `assignedByUserAccountId` is set and differs from the
   * employee's own user account (an HR assignment rather than a genuine
   * self-enrollment, which leaves this null). */
  isOnBehalf: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EnrollInCourseRequest = {
  employeeId: string;
  courseId: string;
  dueDate?: string;
};

export type UpdateCourseEnrollmentProgressRequest = {
  progressPercent: number;
};

export type AttendanceSource = "biometric" | "gps" | "manual";

// Computed at read time by AttendanceService, joining the employee's
// shift assignment as of the punch's own date — never stored on
// attendance_records itself. "no_shift_assigned" is deliberately not an
// error: most SMB pilots won't configure Shift Management on day one, and
// attendance recording must keep working with no shift resolved at all.
// "rest_day"/"holiday" added 2026-09-18 by the Work Schedule Resolution
// Service (see below) — before that, a day the weekly pattern marked off
// (or a mandatory holiday) was evaluated against the shift's flat
// start/end time like any other day, which could mis-flag a scheduled
// day off as "late." Adding union members is additive/non-breaking for
// any existing caller matching on the other four values.
export type AttendanceStatus = "on_time" | "late" | "early_departure" | "no_shift_assigned" | "rest_day" | "holiday";

// --- Step 8B: TLM-04 / TLM-05 / TLM-06 ------------------------------------

export type AttendanceDailyStatus =
  | "present"
  | "absent"
  | "late"
  | "early_departure"
  | "late_and_early"
  | "half_day"
  | "on_leave"
  | "on_duty"
  | "holiday"
  | "rest_day"
  | "no_schedule";

/** One processed attendance day (the time-evaluation job's output). */
export type AttendanceDailyResultView = {
  id: string;
  employeeId: string;
  workDate: string;
  shiftId: string | null;
  scheduleName: string | null;
  status: AttendanceDailyStatus;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  firstInAt: string | null;
  lastOutAt: string | null;
  punchCount: number;
  leaveRequestId: string | null;
  onDutyRequestId: string | null;
  exceptions: string[];
  isOverridden: boolean;
  overrideReason: string | null;
  evaluatedAt: string;
};

export type AttendancePeriodSummary = {
  employeeId: string;
  from: string;
  to: string;
  days: number;
  byStatus: Record<string, number>;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
};

/** One person on a manager's team, for the Team Attendance page. */
export type TeamAttendanceMember = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  /** Processed status of the last day of the window, if that day has been processed. */
  lastDayStatus: AttendanceDailyStatus | null;
  /** Set when the person is clocked in right now (no clock-out yet). */
  clockedInSince: string | null;
  summary: AttendancePeriodSummary;
};

export type TeamAttendanceView = { from: string; to: string; members: TeamAttendanceMember[] };

export type OverrideAttendanceDayRequest = { employeeId: string; workDate: string; status: AttendanceDailyStatus; reason: string };

export type EvaluateAttendanceRequest = { from: string; to: string; employeeId?: string };

export type AttendanceDeviceType = "biometric" | "face" | "card" | "mobile" | "kiosk";

export type AttendanceDeviceView = {
  id: string;
  name: string;
  deviceType: AttendanceDeviceType;
  vendor: string | null;
  serialNumber: string | null;
  locationId: string | null;
  timezone: string;
  isActive: boolean;
  hasApiKey: boolean;
  apiKeyPrefix: string | null;
  lastSeenAt: string | null;
  enrolledCount: number;
};

export type CreateAttendanceDeviceRequest = {
  name: string;
  deviceType?: AttendanceDeviceType;
  vendor?: string;
  serialNumber?: string;
  locationId?: string;
  timezone?: string;
};
export type UpdateAttendanceDeviceRequest = Partial<CreateAttendanceDeviceRequest> & { isActive?: boolean };

/** Returned once, when a device is created or its key is rotated; only a hash is stored. */
export type AttendanceDeviceWithKey = AttendanceDeviceView & { apiKey: string };

export type DeviceEnrollmentView = {
  id: string;
  deviceId: string;
  employeeId: string;
  employeeName: string;
  deviceUserId: string;
  status: "active" | "revoked";
  enrolledAt: string;
};
export type EnrollDeviceUserRequest = { employeeId: string; deviceUserId: string };

export type DevicePunchInput = {
  deviceUserId: string;
  /** ISO timestamp the device recorded. */
  punchedAt: string;
  direction?: "in" | "out";
  /** The device's own event id, when it has one (strongest de-duplication). */
  externalId?: string;
};
export type IngestPunchesRequest = { punches: DevicePunchInput[] };
export type IngestPunchesResult = { received: number; processed: number; duplicates: number; unmatched: number; rejected: number };

export type RawPunchView = {
  id: string;
  deviceId: string;
  deviceUserId: string;
  employeeId: string | null;
  punchedAt: string;
  direction: "in" | "out" | "unknown";
  status: "received" | "processed" | "duplicate" | "unmatched" | "rejected";
  attendanceRecordId: string | null;
  error: string | null;
  receivedAt: string;
};

export type TimesheetStatus = "draft" | "pending" | "approved" | "rejected" | "returned" | "cancelled";

export type TimesheetEntryView = {
  id: string;
  workDate: string;
  minutes: number;
  costCenterId: string | null;
  taskRef: string | null;
  description: string | null;
};
export type TimesheetEntryInput = { workDate: string; minutes: number; costCenterId?: string | null; taskRef?: string | null; description?: string | null };

export type TimesheetView = {
  id: string;
  employeeId: string;
  employeeName?: string;
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  totalMinutes: number;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  workflowInstanceId: string | null;
  entries: TimesheetEntryView[];
  /** Minutes the attendance engine recorded per day, for comparison while filling the sheet. */
  recordedMinutesByDay: Record<string, number>;
};

export type SaveTimesheetEntriesRequest = { entries: TimesheetEntryInput[] };
export type DecideTimesheetRequest = { decision: "approved" | "rejected"; comment?: string };


// --- Step 8C: TLM-07 / TLM-08 / TLM-10 / TLM-11 -----------------------------

export type TimeRecordingProfile = "clock" | "timesheet" | "exception_only" | "none";

/** Planned working time for one employee over a period (no row = full time, clock, tenant hours). */
/** PAY-24: the tenant-wide standard hours; an employee's own work profile wins over it. */
export type CompanyWorkTimeDefaultView = {
  standardMonthlyHours: number;
  standardWeeklyHours: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** "default" until a tenant sets its own: the figure then comes from the payroll settings or the built-in default. */
  source: "work_time_defaults" | "payroll_settings" | "built_in";
};

export type SetCompanyWorkTimeDefaultRequest = {
  standardMonthlyHours: number;
  standardWeeklyHours?: number | null;
  effectiveFrom?: string;
};

export type EmployeeWorkProfileView = {
  id: string;
  employeeId: string;
  employmentPercentage: number;
  weeklyHours: number | null;
  monthlyHours: number | null;
  /** monthlyHours, or weeklyHours x 52 / 12 when only weekly hours are given. */
  effectiveMonthlyHours: number | null;
  isPartTime: boolean;
  timeRecordingProfile: TimeRecordingProfile;
  notes: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type SetWorkProfileRequest = {
  employmentPercentage?: number;
  weeklyHours?: number | null;
  monthlyHours?: number | null;
  isPartTime?: boolean;
  timeRecordingProfile?: TimeRecordingProfile;
  notes?: string | null;
  effectiveFrom?: string;
};

export type OvertimePayoutMode = "pay" | "comp_off";

export type OvertimeAuthorizationView = {
  id: string;
  employeeId: string;
  workDate: string;
  maxMinutes: number | null;
  reason: string | null;
  status: "active" | "used" | "revoked";
  createdAt: string;
};
export type CreateOvertimeAuthorizationRequest = { employeeId: string; workDate: string; maxMinutes?: number; reason?: string };

/** A scoped overtime policy: applies to an employee group and/or a location (and its sub-locations). */
export type ScopedOvertimePolicyView = OvertimePolicyView & {
  scopeKey: string;
  name: string | null;
  employeeGroupId: string | null;
  locationId: string | null;
};
export type SetScopedOvertimePolicyRequest = SetOvertimePolicyRequest & {
  name?: string;
  employeeGroupId?: string;
  locationId?: string;
};

export type HolidayDateBasis = "fixed" | "lunar";

export type HolidayCalendarView = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  /** Empty = applies to every employee. */
  locationIds: string[];
  orgUnitIds: string[];
  holidayCount: number;
};
export type CreateHolidayCalendarRequest = { name: string; description?: string; locationIds?: string[]; orgUnitIds?: string[] };
export type UpdateHolidayCalendarRequest = Partial<CreateHolidayCalendarRequest> & { status?: "active" | "archived" };
export type RollHolidaysForwardRequest = { fromYear: number; toYear: number; calendarId?: string | null };

export type AttendanceRecordView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  source: AttendanceSource;
  clockInAt: string;
  clockOutAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  status: AttendanceStatus;
  shiftName: string | null;
};

export type ClockInRequest = {
  employeeNumber: string;
  source: AttendanceSource;
  gpsLat?: number;
  gpsLng?: number;
};

export type ClockOutRequest = {
  employeeNumber: string;
};

// --- Shift Management (0026_shift_management.sql) ----------------------
// See claude/aihxm-master-audit-and-roadmap.md Part 3 for why this exists:
// Attendance previously had no concept of a "supposed to start at" time,
// so there was no way to tell on-time from late. Deliberately scoped to
// definitions + effective-dated assignments + late/early detection —
// rotations, swaps, and shift premiums are explicitly out of scope for
// this increment (see the migration's own header comment).

export type ShiftView = {
  id: string;
  name: string;
  startTime: string; // "HH:MM" or "HH:MM:SS", local wall-clock time-of-day
  endTime: string;
  crossesMidnight: boolean;
  graceMinutesLate: number;
  graceMinutesEarly: number;
  isDefault: boolean;
  // Added 2026-09-18 by the Work Schedule architecture — see the section
  // below. Default server-side to 'fixed'/'Asia/Karachi' so every
  // pre-existing caller (frontend form, tests) keeps working unchanged.
  scheduleType: ScheduleType;
  timezone: string;
};

export type CreateShiftRequest = {
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight?: boolean;
  graceMinutesLate?: number;
  graceMinutesEarly?: number;
  isDefault?: boolean;
  scheduleType?: ScheduleType;
  timezone?: string;
};

export type UpdateShiftRequest = Partial<CreateShiftRequest>;

export type ShiftAssignmentView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  shiftId: string;
  shiftName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type AssignShiftRequest = {
  employeeId: string;
  shiftId: string;
  effectiveFrom: string;
  effectiveTo?: string;
};

// --- Work Schedule & Employee Schedule Assignment Architecture ---------
// See claude/aihxm-work-schedule-architecture.md (mandatory standard,
// pasted 2026-09-18) and claude/aihxm-master-audit-and-roadmap.md Part 4's
// reconciliation entry. This EXTENDS Shift Management above rather than
// replacing it: `ShiftView` is now also the Work Schedule "definition"
// object (gains `scheduleType`/`timezone`); what's new is its weekly
// pattern + breaks (previously every day implicitly shared one start/end
// time), configurable assignment RULES (Rules-Engine-backed, so an
// employee can receive a schedule via "Department = X AND Group = Y"
// rather than only a direct per-employee assignment), and the resolution
// surface (`ResolvedWorkScheduleView`) Attendance/Leave now consume
// instead of each computing their own notion of "working day."

export type ScheduleType = "fixed" | "flexible" | "shift" | "rotating" | "individual";

export type WorkScheduleBreakView = {
  id: string;
  startTime: string;
  endTime: string;
  isPaid: boolean;
};

export type WorkScheduleDayView = {
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday (Postgres EXTRACT(DOW)/JS Date#getUTCDay() convention)
  isWorking: boolean;
  startTime: string | null;
  endTime: string | null;
  isFlexible: boolean;
  flexibleStartTime: string | null;
  flexibleEndTime: string | null;
  coreStartTime: string | null;
  coreEndTime: string | null;
  isHalfDay: boolean;
  breaks: WorkScheduleBreakView[];
};

export type SetWeeklyPatternRequest = {
  days: Array<{
    dayOfWeek: number;
    isWorking: boolean;
    startTime?: string;
    endTime?: string;
    isFlexible?: boolean;
    flexibleStartTime?: string;
    flexibleEndTime?: string;
    coreStartTime?: string;
    coreEndTime?: string;
    isHalfDay?: boolean;
    breaks?: Array<{ startTime: string; endTime: string; isPaid?: boolean }>;
  }>;
};

// A deliberately narrow mirror of the RulesEngine's own expression
// grammar (apps/api/src/rules-engine/rules-engine.engine.ts) for exactly
// this one consumer — the Rules Engine itself is explicitly not yet a
// rule-authoring system with a shared, cross-domain expression type (see
// its own doc comment: "no field registry" until a second consumer
// defines what shape it needs). This is that second consumer's own
// narrow shape, not a premature shared registry.
export type WorkScheduleRuleOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "between"
  | "contains"
  | "isEmpty"
  | "isNotEmpty";

export type WorkScheduleRuleCondition = { field: string; operator: WorkScheduleRuleOperator; value?: unknown };

export type WorkScheduleRuleExpression =
  | { all: WorkScheduleRuleExpression[] }
  | { any: WorkScheduleRuleExpression[] }
  | { not: WorkScheduleRuleExpression }
  | WorkScheduleRuleCondition;

export type WorkScheduleAssignmentRuleView = {
  id: string;
  name: string;
  priority: number;
  conditionExpression: WorkScheduleRuleExpression;
  scheduleId: string;
  scheduleName: string;
  isActive: boolean;
};

export type CreateWorkScheduleAssignmentRuleRequest = {
  name: string;
  priority?: number;
  conditionExpression: WorkScheduleRuleExpression;
  scheduleId: string;
  isActive?: boolean;
};

export type UpdateWorkScheduleAssignmentRuleRequest = Partial<CreateWorkScheduleAssignmentRuleRequest>;

export type WorkScheduleAssignmentSource = "individual" | "temporary" | "rule" | "default";

/** The single resolved-schedule shape Attendance/Leave (and, per the
 * architecture doc's Section 36, a future `GET /employees/:id/work-schedule`
 * caller) all consume — see WorkScheduleResolutionService. */
export type ResolvedWorkScheduleView = {
  date: string;
  hasSchedule: boolean;
  scheduleId: string | null;
  scheduleName: string | null;
  scheduleType: ScheduleType | null;
  timezone: string | null;
  assignmentSource: WorkScheduleAssignmentSource | null;
  assignmentRuleName: string | null;
  isWorking: boolean;
  isHalfDay: boolean;
  startTime: string | null;
  endTime: string | null;
  crossesMidnight: boolean;
  isFlexible: boolean;
  flexibleStartTime: string | null;
  flexibleEndTime: string | null;
  coreStartTime: string | null;
  coreEndTime: string | null;
  breaks: WorkScheduleBreakView[];
  graceMinutesLate: number;
  graceMinutesEarly: number;
  isHoliday: boolean;
  isMandatoryHoliday: boolean;
  holidayName: string | null;
};

// --- Attendance Policies increment 1: correction requests --------------
// See 0028_attendance_corrections.sql — one decision (approve/reject),
// made by the requester's own manager or HR, not routed through the
// generic Workflow Engine.
export type AttendanceCorrectionStatus = "pending" | "approved" | "rejected" | "returned" | "cancelled";

export type AttendanceCorrectionRequestView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  attendanceRecordId: string | null;
  requestedDate: string;
  requestedClockIn: string | null;
  requestedClockOut: string | null;
  reason: string;
  status: AttendanceCorrectionStatus;
  isOnBehalf: boolean;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type SubmitAttendanceCorrectionRequest = {
  employeeId: string;
  requestedDate: string;
  requestedClockIn?: string;
  requestedClockOut?: string;
  reason: string;
  attendanceRecordId?: string;
};

export type DecideAttendanceCorrectionRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- Holiday Management (0030_holiday_management.sql) -------------------
// The calendar foundation Attendance Corrections' own header comment
// deferred ("absence reporting needs a working-days/holiday calendar
// first"). This increment is the calendar itself only — it does not yet
// feed leave day-count calculation or attendance absence detection.
export type HolidayView = {
  id: string;
  name: string;
  holidayDate: string;
  isOptional: boolean;
  /** TLM-10 - null = company-wide. */
  calendarId: string | null;
  isGazetted: boolean;
  dateBasis: "fixed" | "lunar";
  /** A moon-dependent date still awaiting confirmation. */
  isTentative: boolean;
};

export type CreateHolidayRequest = {
  name: string;
  holidayDate: string;
  isOptional?: boolean;
  calendarId?: string | null;
  isGazetted?: boolean;
  dateBasis?: "fixed" | "lunar";
  isTentative?: boolean;
};

export type UpdateHolidayRequest = Partial<CreateHolidayRequest>;

// --- Configuration Center (0032_configuration_center.sql) --------------
// A read-only, permission-filtered index over the configuration domains
// that already have their own real admin screen (leave policies, employee
// groups, shifts, holidays, workflow templates, custom fields, tax slabs)
// -- this does not introduce a new place configuration lives, it makes
// the six-plus existing places discoverable from one screen. `count` is
// omitted (not zero) for a domain the caller has no view/manage access to
// -- ConfigurationCenterService filters those out server-side rather than
// returning a card the caller can't act on.
export type ConfigurationDomainSummary = {
  domainKey: string;
  label: string;
  description: string;
  adminRoute: string;
  supportsEffectiveDating: boolean;
  count: number;
};

// --- Phase 10: Recruitment & Onboarding --------------------------------
// Plan doc Section 7: "Requisition to hire, Kanban pipeline... Employee
// number gets assigned here, at offer acceptance." See
// 0017_recruitment.sql for the schema and Decision #10 for the design
// writeup (requisition approval reusing the Phase 6 workflow engine
// as-is, candidates deliberately having no login/session of their own,
// and offer acceptance as the second real caller of Employee Number
// assignment).

export type RequisitionStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "closed"
  | "open"
  | "on_hold"
  | "filled"
  | "cancelled";

export type JobRequisitionView = {
  id: string;
  companyId: string;
  title: string;
  department: string | null;
  headcount: number;
  salaryBand: string | null;
  justification: string | null;
  hiringManagerId: string | null;
  /** ORG-01: the approved position (seat) this requisition hires into, and the
   * org dimensions it was raised against. `department` is derived from the org
   * unit's name when `orgUnitId` is set. */
  positionId: string | null;
  orgUnitId: string | null;
  jobId: string | null;
  locationId: string | null;
  filledHeadcount: number;
  statusReason: string | null;
  status: RequisitionStatus;
  workflowInstanceId: string | null;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateJobRequisitionRequest = {
  title: string;
  department?: string;
  /** Defaults to 1 when omitted. */
  headcount?: number;
  salaryBand?: string;
  justification?: string;
  hiringManagerId?: string;
  /** ORG-01: raise the requisition against an approved position with open
   * capacity. When given, orgUnitId/jobId default from the position and must
   * agree with it; `title` still names the advert. */
  positionId?: string;
  orgUnitId?: string;
  jobId?: string;
  locationId?: string;
};

export type JobRequisitionAction = "open" | "hold" | "resume" | "fill" | "cancel";

export const RECRUITMENT_SOURCES = [
  "referral", "job_board", "agency", "walk_in", "social_media", "company_website", "campus", "internal", "event", "other",
] as const;
export type RecruitmentSource = (typeof RECRUITMENT_SOURCES)[number];

export type CandidateView = {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** Masked (only the last four characters are visible): the full value is stored encrypted. */
  nationalIdMasked: string | null;
  nationalIdType: string;
  source: RecruitmentSource | null;
  sourceDetail: string | null;
  currentEmployer: string | null;
  currentDesignation: string | null;
  expectedSalary: number | null;
  noticePeriodDays: number | null;
  consentGivenAt: string | null;
  consentPurpose: string | null;
  retentionUntil: string | null;
  personId: string | null;
  anonymisedAt: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateCandidateRequest = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  nationalId?: string;
  source?: RecruitmentSource;
  sourceDetail?: string;
  currentEmployer?: string;
  currentDesignation?: string;
  expectedSalary?: number;
  noticePeriodDays?: number;
  consentGiven?: boolean;
  consentPurpose?: string;
  /** Create anyway when the duplicate check found a likely match. */
  allowDuplicate?: boolean;
};

export type UpdateCandidateRequest = Partial<Omit<CreateCandidateRequest, "allowDuplicate">>;

export type CandidateDuplicateMatch = {
  candidateId: string;
  fullName: string;
  matchedOn: Array<"national_id" | "email" | "phone">;
};

export type CandidateDocumentType = "resume" | "cover_letter" | "identity" | "certificate" | "reference" | "other";

export type CandidateDocumentView = {
  id: string;
  candidateId: string;
  docType: CandidateDocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
};

export type RecruitmentSettingsView = {
  candidateRetentionMonths: number | null;
  consentRequired: boolean;
  offerValidityDays: number | null;
  offerLetterTemplateKey: string | null;
};

export type UpdateRecruitmentSettingsRequest = Partial<RecruitmentSettingsView>;

/** The Kanban board's own column set. Forward-only; `rejected` is reachable from any non-terminal stage and needs a reason. */
/** A requisition the signed-in person is the hiring manager of, with how many applications sit at each stage (counts only, no candidate data). */
export type MyRequisitionView = {
  requisition: JobRequisitionView;
  applicationCounts: Record<ApplicationStage, number>;
};

export type ApplicationStage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";

export type ApplicationView = {
  id: string;
  companyId: string;
  requisitionId: string;
  candidateId: string;
  stage: ApplicationStage;
  source: RecruitmentSource | null;
  sourceDetail: string | null;
  rejectionReason: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateApplicationRequest = {
  requisitionId: string;
  candidateId: string;
  source?: RecruitmentSource;
  sourceDetail?: string;
};

export type MoveApplicationStageRequest = {
  stage: ApplicationStage;
  /** Required when `stage` is `rejected`. */
  reason?: string;
};

export type ApplicationStageHistoryView = {
  id: string;
  applicationId: string;
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  reason: string | null;
  changedBy: string | null;
  changedAt: string;
};

export type InterviewType = "phone" | "video" | "onsite" | "technical" | "hr" | "panel" | "other";
export type InterviewStatus = "scheduled" | "completed" | "cancelled" | "no_show";
export type InterviewRecommendation = "strong_yes" | "yes" | "no" | "strong_no";

export type ScorecardEntry = { criterion: string; rating: number; comment?: string };

export type InterviewFeedbackView = {
  id: string;
  interviewId: string;
  employeeId: string;
  overallRating: number;
  recommendation: InterviewRecommendation;
  strengths: string | null;
  concerns: string | null;
  scorecard: ScorecardEntry[];
  submittedAt: string;
};

export type InterviewView = {
  id: string;
  applicationId: string;
  /** For the interviewer's own list: who is being interviewed and for which requisition. */
  candidateName: string | null;
  requisitionTitle: string | null;
  roundNo: number;
  interviewType: InterviewType;
  scheduledStart: string;
  scheduledEnd: string;
  locationText: string | null;
  meetingLink: string | null;
  status: InterviewStatus;
  cancelReason: string | null;
  notes: string | null;
  interviewerEmployeeIds: string[];
  feedback: InterviewFeedbackView[];
  createdAt: string;
};

export type ScheduleInterviewRequest = {
  applicationId: string;
  roundNo?: number;
  interviewType?: InterviewType;
  scheduledStart: string;
  scheduledEnd: string;
  locationText?: string;
  meetingLink?: string;
  interviewerEmployeeIds: string[];
  notes?: string;
};

export type UpdateInterviewRequest = {
  scheduledStart?: string;
  scheduledEnd?: string;
  interviewType?: InterviewType;
  locationText?: string;
  meetingLink?: string;
  interviewerEmployeeIds?: string[];
  status?: InterviewStatus;
  cancelReason?: string;
  notes?: string;
};

export type SubmitInterviewFeedbackRequest = {
  overallRating: number;
  recommendation: InterviewRecommendation;
  strengths?: string;
  concerns?: string;
  scorecard?: ScorecardEntry[];
  /** HR may record feedback on behalf of an interviewer; interviewers omit this. */
  employeeId?: string;
};

export type PreEmploymentCheckType = "reference" | "education" | "employment_history" | "identity" | "criminal_record" | "medical" | "other";
export type PreEmploymentCheckStatus = "requested" | "in_progress" | "passed" | "failed" | "waived";

export type PreEmploymentCheckView = {
  id: string;
  applicationId: string;
  checkType: PreEmploymentCheckType;
  label: string | null;
  isRequired: boolean;
  status: PreEmploymentCheckStatus;
  resultNote: string | null;
  performedBy: string | null;
  updatedAt: string;
};

export type CreatePreEmploymentCheckRequest = {
  applicationId: string;
  checkType: PreEmploymentCheckType;
  label?: string;
  isRequired?: boolean;
};

export type UpdatePreEmploymentCheckRequest = {
  status?: PreEmploymentCheckStatus;
  resultNote?: string;
  isRequired?: boolean;
};

export type CandidateTimelineEntry = {
  at: string;
  kind: "created" | "application" | "stage" | "interview" | "feedback" | "offer" | "check" | "document" | "event";
  summary: string;
  refId: string | null;
};

export type ApplicationTimelineView = {
  application: ApplicationView;
  stageHistory: ApplicationStageHistoryView[];
  interviews: InterviewView[];
  checks: PreEmploymentCheckView[];
  offers: OfferView[];
};

export type OfferStatus =
  | "pending" | "pending_approval" | "approval_rejected" | "accepted" | "declined" | "rescinded" | "expired";

export type OfferComponentView = { componentId: string; componentKey: string; componentName: string; amount: number };

export type OfferView = {
  id: string;
  companyId: string;
  applicationId: string;
  salary: number;
  startDate: string;
  status: OfferStatus;
  extendedByUserAccountId: string;
  /** Set once `decideOffer()` records the candidate's decision. */
  hiredEmployeeId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  declineReason: string | null;
  rescindReason: string | null;
  currencyCode: string;
  notes: string | null;
  approvedAt: string | null;
  workflowInstanceId: string | null;
  components: OfferComponentView[];
  latestLetterVersion: number | null;
  createdAt: string;
};

export type ExtendOfferRequest = {
  applicationId: string;
  /** Optional when components are given (then the salary is the sum of the components). */
  salary?: number;
  startDate: string;
  components?: Array<{ componentId: string; amount: number }>;
  expiresAt?: string;
  notes?: string;
};

export type RescindOfferRequest = { reason?: string };

export type DecideOfferRequest = {
  decision: "accepted" | "declined";
  reason?: string;
};

export type DecideOfferResponse = {
  offer: OfferView;
  /** Present only when `decision: "accepted"`. */
  employee: EmployeeView | null;
  /** LIVE-15: set when the accepted hire already got an onboarding checklist from the tenant's template. */
  onboardingStarted?: boolean;
  /** LIVE-15: what HR still has to do for the new hire (login, department, payment account, onboarding template). */
  followUps?: string[];
};

export type OfferLetterView = {
  id: string;
  offerId: string;
  versionNo: number;
  templateKey: string | null;
  templateSource: "built_in" | "custom";
  content: string;
  contentHash: string;
  status: "issued" | "superseded";
  generatedAt: string;
};

export type GenerateOfferLetterRequest = { templateKey?: string };

export type RecruitmentEventType =
  | "career_fair" | "campus_drive" | "walk_in_drive" | "interview_day" | "info_session" | "job_posting" | "other";

export type RecruitmentEventView = {
  id: string;
  title: string;
  eventType: RecruitmentEventType;
  startsAt: string;
  endsAt: string | null;
  locationId: string | null;
  locationText: string | null;
  requisitionId: string | null;
  capacity: number | null;
  status: "planned" | "completed" | "cancelled";
  notes: string | null;
  attendeeCount: number;
};

export type UpsertRecruitmentEventRequest = {
  title: string;
  eventType?: RecruitmentEventType;
  startsAt: string;
  endsAt?: string;
  locationId?: string;
  locationText?: string;
  requisitionId?: string;
  capacity?: number;
  status?: "planned" | "completed" | "cancelled";
  notes?: string;
};

export type RecruitmentCalendarEntry = {
  kind: "interview" | "event";
  id: string;
  title: string;
  start: string;
  end: string | null;
  status: string;
};

// --- Phase 11: Performance & Goals --------------------------------------
// Plan doc Section 7: "Review cycles, calibration." See 0019_performance.sql
// for the schema and Decision #11 for the design writeup (why this phase
// deliberately does NOT route anything through the Phase 6 workflow
// engine, and how the self/manager/calibration visibility rule reuses
// the Phase 4 field-permission engine's conditional-rule mechanism).

export type ReviewCycleStatus = "draft" | "active" | "calibration" | "closed";

export type ReviewCycleView = {
  id: string;
  companyId: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  participantGroupId: string | null;
  status: ReviewCycleStatus;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
  /** TAL-07: deadlines per phase; empty when the cycle has no phase windows. */
  phases?: ReviewCyclePhaseView[];
  currentPhase?: ReviewPhaseKey | null;
};

export type CreateReviewCycleRequest = {
  name: string;
  periodStart: string;
  periodEnd: string;
  /** Omitted/null means "all active employees" — resolved at launch
   * time, not frozen into a list at creation time. */
  participantGroupId?: string;
};

/** Launching a cycle resolves its participant population (the group's
 * matching employees, or every active employee when none is set) and
 * creates one `performance_reviews` row per participant. */
export type LaunchReviewCycleResponse = {
  cycle: ReviewCycleView;
  participantCount: number;
};

export type GoalStatus = "active" | "in_progress" | "at_risk" | "overdue" | "completed" | "cancelled";

export type GoalView = {
  id: string;
  companyId: string;
  reviewCycleId: string;
  employeeId: string;
  parentGoalId: string | null;
  title: string;
  description: string | null;
  weight: number | null;
  /** The stored status. `overdue` is set by the nightly job; see `effectiveStatus` for the live value. */
  status: GoalStatus;
  /** `overdue` as soon as the due date has passed on an open goal, even before the nightly job persists it. */
  effectiveStatus: GoalStatus;
  dueDate: string | null;
  targetValue: number | null;
  targetUnit: string | null;
  currentValue: number | null;
  progressPct: number;
  completedAt: string | null;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateGoalRequest = {
  reviewCycleId: string;
  employeeId: string;
  parentGoalId?: string;
  title: string;
  description?: string;
  weight?: number;
  dueDate?: string;
  targetValue?: number;
  targetUnit?: string;
};

export type UpdateGoalRequest = {
  title?: string;
  description?: string;
  weight?: number;
  /** `overdue` is system-managed and cannot be set by hand. */
  status?: Exclude<GoalStatus, "overdue">;
  dueDate?: string | null;
  targetValue?: number | null;
  targetUnit?: string | null;
  currentValue?: number;
  progressPct?: number;
  /** Stored on the update history row. */
  note?: string;
};

export type GoalUpdateType = "created" | "progress" | "status" | "due_date" | "weight" | "edit" | "note" | "system";

export type GoalUpdateView = {
  id: string;
  goalId: string;
  updateType: GoalUpdateType;
  fromStatus: GoalStatus | null;
  toStatus: GoalStatus | null;
  progressPct: number | null;
  currentValue: number | null;
  note: string | null;
  changes: Record<string, unknown>;
  authorUserAccountId: string | null;
  createdAt: string;
};

export type GoalPlanStatus = "draft" | "finalised";

/** One employee's goals in one cycle: weights must add up to exactly 100 before the plan is finalised. */
export type GoalPlanView = {
  reviewCycleId: string;
  employeeId: string;
  status: GoalPlanStatus;
  goalCount: number;
  totalWeight: number;
  remainingWeight: number;
  /** Every open goal is weighted and the weights add up to 100. */
  isComplete: boolean;
  finalisedAt: string | null;
  reopenedReason: string | null;
};

export type GoalPlanRequest = { reviewCycleId: string; employeeId: string };
export type ReopenGoalPlanRequest = GoalPlanRequest & { reason: string };

export type GoalEvidenceView = { id: string; goalId: string; label: string; url: string; createdBy: string | null; createdAt: string };

// --- TAL-07 review cycle phases -------------------------------------------------------

export const REVIEW_PHASE_KEYS = ["goal_setting", "self_assessment", "manager_assessment", "calibration", "release"] as const;
export type ReviewPhaseKey = (typeof REVIEW_PHASE_KEYS)[number];

export type ReviewCyclePhaseView = {
  phaseKey: ReviewPhaseKey;
  startsOn: string;
  endsOn: string;
  /** Relative to today in the company's time zone. */
  state: "upcoming" | "open" | "closed";
};

export type SetReviewCyclePhasesRequest = {
  phases: Array<{ phaseKey: ReviewPhaseKey; startsOn: string; endsOn: string }>;
};

// --- TAL-06 competencies, ratings, feedback, development plans ------------------------

export type CompetencyView = { id: string; code: string; name: string; description: string | null; category: string | null; isActive: boolean };
export type UpsertCompetencyRequest = { code?: string; name: string; description?: string; category?: string; isActive?: boolean };

export type RatingSource = "self" | "manager" | "peer" | "upward" | "skip_level" | "calibration";

export type ReviewRatingInput = { goalId?: string; competencyId?: string; rating: number; comment?: string };
export type SetReviewRatingsRequest = { source: "self" | "manager" | "calibration"; ratings: ReviewRatingInput[] };

export type ReviewRatingView = {
  id: string;
  reviewId: string;
  source: RatingSource;
  goalId: string | null;
  competencyId: string | null;
  rating: number;
  comment: string | null;
  /** Absent for anonymous multi-rater input unless the caller is HR. */
  raterUserAccountId?: string | null;
  createdAt: string;
};

export type ScorecardGoalLine = {
  goalId: string;
  title: string;
  weight: number | null;
  progressPct: number;
  status: GoalStatus;
  ratings: Partial<Record<RatingSource, number>>;
};

export type ScorecardCompetencyLine = {
  competencyId: string;
  name: string;
  ratings: Partial<Record<RatingSource, { average: number; count: number }>>;
};

export type ReviewScorecardView = {
  reviewId: string;
  goals: ScorecardGoalLine[];
  competencies: ScorecardCompetencyLine[];
  /** Σ weight × rating / Σ weight per source, over goals that carry both. Information only - it never sets the review rating. */
  weightedGoalScore: Partial<Record<RatingSource, number>>;
  /** Anonymous multi-rater responses hidden because fewer than the tenant's minimum have arrived. */
  withheldAnonymousCount: number;
};

export type FeedbackType = "continuous" | "recognition" | "peer" | "upward" | "skip_level";
export type FeedbackVisibility = "subject" | "manager_only" | "hr_only";

export type FeedbackEvidenceInput = { label: string; url: string };

export type FeedbackView = {
  id: string;
  subjectEmployeeId: string;
  feedbackType: FeedbackType;
  reviewId: string | null;
  goalId: string | null;
  competencyId: string | null;
  body: string;
  rating: number | null;
  visibility: FeedbackVisibility;
  isAnonymous: boolean;
  /** Absent when the feedback is anonymous and the caller is not HR. */
  authorEmployeeId?: string | null;
  evidence: Array<{ id: string; label: string; url: string }>;
  createdAt: string;
};

export type GiveFeedbackRequest = {
  subjectEmployeeId: string;
  body: string;
  feedbackType?: "continuous" | "recognition";
  goalId?: string;
  competencyId?: string;
  rating?: number;
  visibility?: FeedbackVisibility;
  evidence?: FeedbackEvidenceInput[];
};

export type FeedbackRequestStatus = "requested" | "submitted" | "declined" | "cancelled";

export type FeedbackRequestView = {
  id: string;
  reviewId: string;
  subjectEmployeeId: string;
  raterEmployeeId: string;
  raterType: "peer" | "upward" | "skip_level" | "other";
  status: FeedbackRequestStatus;
  isAnonymous: boolean;
  dueDate: string | null;
  requestedAt: string;
  respondedAt: string | null;
};

export type RequestFeedbackRequest = {
  raterEmployeeIds: string[];
  raterType: "peer" | "upward" | "skip_level" | "other";
  dueDate?: string;
  isAnonymous?: boolean;
};

export type RespondFeedbackRequest = {
  body: string;
  rating?: number;
  competencyRatings?: Array<{ competencyId: string; rating: number; comment?: string }>;
  evidence?: FeedbackEvidenceInput[];
};

export type DevelopmentPlanStatus = "draft" | "active" | "completed" | "cancelled";
export type DevelopmentItemType = "course" | "mentoring" | "coaching" | "project" | "stretch_assignment" | "reading" | "other";
export type DevelopmentItemStatus = "not_started" | "in_progress" | "done";

export type DevelopmentPlanItemView = {
  id: string;
  planId: string;
  competencyId: string | null;
  courseId: string | null;
  itemType: DevelopmentItemType;
  action: string;
  dueDate: string | null;
  status: DevelopmentItemStatus;
  notes: string | null;
  completedAt: string | null;
};

export type DevelopmentPlanView = {
  id: string;
  employeeId: string;
  reviewCycleId: string | null;
  reviewId: string | null;
  title: string;
  objective: string | null;
  status: DevelopmentPlanStatus;
  targetDate: string | null;
  items: DevelopmentPlanItemView[];
  createdAt: string;
  updatedAt: string;
};

export type DevelopmentItemInput = {
  competencyId?: string;
  courseId?: string;
  itemType?: DevelopmentItemType;
  action: string;
  dueDate?: string;
  notes?: string;
};

export type CreateDevelopmentPlanRequest = {
  employeeId: string;
  title: string;
  objective?: string;
  targetDate?: string;
  reviewCycleId?: string;
  reviewId?: string;
  items?: DevelopmentItemInput[];
};

export type UpdateDevelopmentPlanRequest = {
  title?: string;
  objective?: string;
  targetDate?: string | null;
  status?: DevelopmentPlanStatus;
};

export type UpdateDevelopmentItemRequest = Partial<DevelopmentItemInput> & { status?: DevelopmentItemStatus };

export type PerformanceSettingsView = { minRatersForAnonymity: number | null };

export type PerformanceReviewStatus = "pending" | "in_progress" | "completed" | "calibrated" | "released";

/**
 * The sensitive fields below are `null`/absent for a caller the
 * conditional field-permission rules in 0020_performance_seed.sql don't
 * yet grant visibility into — e.g. an employee_self_service caller sees
 * all five as absent from the raw API response (not merely null) until
 * `status` reaches `"released"`, the same "genuinely absent from
 * `Object.keys()`" contract Phase 4's field-permission engine has always
 * had.
 */
export type PerformanceReviewView = {
  id: string;
  companyId: string;
  reviewCycleId: string;
  employeeId: string;
  status: PerformanceReviewStatus;
  selfAssessment: string | null;
  selfAssessmentSubmittedAt: string | null;
  managerAssessment?: string | null;
  managerRating?: number | null;
  managerAssessmentSubmittedAt: string | null;
  calibrationRating?: number | null;
  calibrationComment?: string | null;
  calibratedAt: string | null;
  finalRating?: number | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitSelfAssessmentRequest = {
  selfAssessment: string;
};

export type SubmitManagerAssessmentRequest = {
  managerAssessment: string;
  managerRating: number;
};

export type CalibrateReviewRequest = {
  calibrationRating: number;
  calibrationComment?: string;
};

/** Ratings distribution for one cycle (optionally scoped to one
 * employee group) — what an HR Admin actually looks at during
 * calibration before adjusting any individual review. */
export type RatingDistributionView = {
  reviewCycleId: string;
  /** Keyed by manager_rating (1-5, as a string key) -> count of reviews
   * currently at that rating and still awaiting calibration/release. */
  distribution: Record<string, number>;
  totalReviews: number;
  pendingCalibration: number;
};

// -----------------------------------------------------------------------
// Decision #20 (Task #52) — System Admin: the tenant-scoped counterpart to
// Platform Admin's `/platform/role-assignments`/`/platform/roles`
// (0004_rbac.sql, apps/api/src/rbac/). Reuses `UserRoleAssignment`/`Role`
// above for the underlying data shape; these types are specific to the
// system-admin module's own read model (an assignment joined with the
// employee it belongs to, for display) and request shape (keyed by
// employeeId rather than a bare userAccountId, since a System Admin picks
// "which employee" from a list, not a raw account id).
// -----------------------------------------------------------------------

/**
 * One row in the "who can I grant a login or a role to" picker
 * (`GET /system-admin/assignable-users`) — deliberately NOT `EmployeeView`:
 * a System Admin has no `employee.view.*` permission of their own (see
 * 0024_system_admin.sql's role description) and doesn't need one just to
 * see who exists and what access they already hold.
 */
export type AssignableUserView = {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  userAccountId: string | null;
  hasLogin: boolean;
  roleKeys: TenantRoleKey[];
};

export type SystemAdminRoleAssignmentView = {
  id: string;
  userAccountId: string;
  employeeId: string | null;
  employeeName: string | null;
  email: string | null;
  roleKey: TenantRoleKey;
  roleName: string;
  createdAt: string;
};

export type AssignSystemAdminRoleRequest = {
  employeeId: string;
  roleKey: TenantRoleKey;
};

// -----------------------------------------------------------------------
// Phase 12 — Compensation & Payroll (Decision #14). Plan doc Section 10's
// guardrail applies to every type below exactly as it does to the schema
// and the service: passing this phase's own tests is not the same thing
// as being safe to run with real money — see Decision #14 and
// KNOWN_ISSUES.md for exactly which figures still need direct accountant/
// EOBI/PESSI/SESSI confirmation.
// -----------------------------------------------------------------------

// --- Payroll Enterprise Gap Analysis & Roadmap, Phase P1 (2026-09-27) ---
// (claude/payroll-enterprise-gap-analysis-and-roadmap.md) — the single
// flat `monthlySalary` figure is replaced by a real component model
// (Basic Salary + named allowances, each independently effective-dated),
// and `PayrollSettingsView` gains the same effective-dating tax_slabs
// already had, so a run can resolve the EOBI/social-security rates that
// were actually in force during ITS OWN period.

/** One entry in a tenant's compensation-component catalog (Basic Salary,
 * House Rent Allowance, etc.). Pure identity/config — not itself
 * effective-dated; only the per-employee AMOUNT assigned against a
 * component (`CompensationView` below) carries a history. Lazily seeded
 * with a standard 6-component starter set the first time a tenant has
 * none, the same pattern used for tax slabs/payroll settings. */
/** Payroll Enterprise Gap Analysis Phase P3 (2026-10-02) — a component is
 * either an `earning` (added to gross, taxable per `isTaxable`) or a
 * `deduction` (a recurring "Benefits"-style item — a health-insurance
 * premium, a society membership fee — subtracted from NET pay, never
 * gross/taxable gross; always non-taxable by construction, enforced in
 * `EmployeeCompensationService`, not just a UI default). Defaults to
 * `earning` for every pre-existing component. */
export type CompensationComponentType =
  | "earning"
  | "deduction"
  | "employer_contribution"
  | "reimbursement"
  | "non_cash_benefit"
  | "arrears"
  | "retro"
  | "shift_premium";

/** PAY-07 - how an employee's monthly amount for a component is arrived at. */
export type CompensationCalculationType = "fixed" | "percentage" | "per_unit" | "formula" | "threshold";
export type CompensationBasisType = "none" | "basic_salary" | "component" | "gross_fixed_earnings";
export type CompensationRoundingMode = "none" | "nearest" | "up" | "down";
export type CompensationProrationMode = "prorated" | "none";
/** Who is eligible for a component; every key is optional and all that are present must hold. */
export type CompensationEligibility = {
  /** Months of service at the end of the pay period. */
  minServiceMonths?: number;
  /** hr_reference_catalog_items ids of `employment_type`. */
  employmentTypeCatalogItemIds?: string[];
};

/** The fields PAY-07 adds to a component definition (all optional on create / update). */
export type CompensationComponentRules = {
  categoryCatalogItemId?: string | null;
  calculationType?: CompensationCalculationType;
  basisType?: CompensationBasisType;
  basisComponentId?: string | null;
  defaultPercentage?: number | null;
  unitRate?: number | null;
  unitLabel?: string | null;
  thresholdAmount?: number | null;
  formulaExpression?: Record<string, unknown> | null;
  capAmount?: number | null;
  floorAmount?: number | null;
  roundingMode?: CompensationRoundingMode;
  roundingIncrement?: number;
  prorationMode?: CompensationProrationMode;
  eligibility?: CompensationEligibility;
  countsTowardEobiBase?: boolean;
  countsTowardGratuityBase?: boolean;
  countsTowardProvidentFundBase?: boolean;
  glAccountCode?: string | null;
  payslipLabel?: string | null;
  displayOrder?: number;
};

export type CompensationComponentView = {
  id: string;
  companyId: string;
  key: string;
  name: string;
  /** Deliberately defaults to true for every component, including the
   * seeded starter set — this codebase never presumes an allowance is
   * tax-exempt without a real accountant confirming the exemption
   * applies (see `claude/statutory-payroll-rates-pakistan.md`). Forced
   * `false` for every `deduction`-type component. */
  isTaxable: boolean;
  componentType: CompensationComponentType;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  // PAY-07
  categoryCatalogItemId: string | null;
  calculationType: CompensationCalculationType;
  basisType: CompensationBasisType;
  basisComponentId: string | null;
  defaultPercentage: number | null;
  unitRate: number | null;
  unitLabel: string | null;
  thresholdAmount: number | null;
  formulaExpression: Record<string, unknown> | null;
  capAmount: number | null;
  floorAmount: number | null;
  roundingMode: CompensationRoundingMode;
  roundingIncrement: number;
  prorationMode: CompensationProrationMode;
  eligibility: CompensationEligibility;
  countsTowardEobiBase: boolean;
  countsTowardGratuityBase: boolean;
  countsTowardProvidentFundBase: boolean;
  glAccountCode: string | null;
  payslipLabel: string | null;
  displayOrder: number;
};

export type CreateCompensationComponentRequest = CompensationComponentRules & {
  name: string;
  /** Slugified from name when omitted. */
  key?: string;
  isTaxable?: boolean;
  /** Defaults to "earning". */
  componentType?: CompensationComponentType;
};

export type UpdateCompensationComponentRequest = CompensationComponentRules & {
  name?: string;
  isTaxable?: boolean;
  isActive?: boolean;
  sortOrder?: number;
};

/** One effective-dated amount an employee is paid against ONE
 * compensation component. Component identity is denormalized alongside
 * the amount so a caller never needs a second round trip to label a
 * history row. `GET /payroll/compensation/:employeeId/history` returns
 * these flattened across every component an employee has ever had. */
export type CompensationView = {
  id: string;
  companyId: string;
  employeeId: string;
  componentId: string;
  componentKey: string;
  componentName: string;
  isTaxable: boolean;
  componentType: CompensationComponentType;
  /** The MONTHLY amount the payroll pays. For a percentage / per-unit / formula / threshold component this is the
   * amount resolved when the row was written (and re-resolved when its basis changes). */
  amount: number;
  effectiveFrom: string;
  /** null = this is the current amount for this component. */
  effectiveTo: string | null;
  createdByUserAccountId: string;
  createdAt: string;
  // PAY-07 / PAY-11
  calculationType: CompensationCalculationType;
  percentage: number | null;
  units: number | null;
  /** What was typed, in `payFrequency` terms (an annual figure is stored as typed; `amount` is its monthly share). */
  enteredAmount: number | null;
  payFrequency: CompensationPayFrequency;
  currencyCode: string;
  changeReasonCatalogItemId: string | null;
  changeReasonNote: string | null;
  salaryGradeId: string | null;
};

export type CompensationPayFrequency = "monthly" | "annual";

/** Back-compat, single-component convenience that sets/updates ONLY the
 * "Basic Salary" component (creating the standard catalog for the
 * tenant first if it doesn't exist yet). This is what the Hiring
 * Wizard's Compensation card still calls — a new hire's one number
 * becomes their starting Basic Salary; allowances are added afterward
 * via the Payroll admin screen. Anyone paying more than one component
 * uses `SetEmployeeCompensationComponentsRequest` below instead. */
export type SetCompensationRequest = {
  employeeId: string;
  monthlySalary: number;
  effectiveFrom: string;
};

/** Sets one or more components' amounts for an employee as of the same
 * date in one call — a component left out of `components` is untouched
 * (its existing effective row keeps running), so bumping just Basic
 * Salary doesn't require resubmitting every allowance. */
export type SetEmployeeCompensationComponentsRequest = {
  employeeId: string;
  effectiveFrom: string;
  /**
   * `amount` is the figure typed for a fixed or threshold component, and the RATE PER UNIT for a per-unit component.
   * `percentage` (of the component's basis) is for a percentage component and falls back to its default percentage;
   * `units` is for a per-unit component.
   */
  components: Array<{ componentId: string; amount?: number; percentage?: number; units?: number }>;
  /** PAY-11 - applies to every row written by this call. */
  payFrequency?: CompensationPayFrequency;
  currencyCode?: string;
  /** Catalog item of `lifecycle_reason:compensation_change`. */
  changeReasonCatalogItemId?: string | null;
  changeReasonNote?: string | null;
  salaryGradeId?: string | null;
};

/** The employee's current (as-of-today) compensation: one entry per
 * component they have an open effective-dated row for. */
export type EmployeeCompensationView = {
  employeeId: string;
  asOfDate: string;
  components: CompensationView[];
  /** Sum of every `earning`-type component's amount. */
  totalEarnings: number;
  /** Sum of every `deduction`-type component's amount (a positive
   * number — the amount subtracted, not already negated). */
  totalDeductions: number;
  /** `totalEarnings - totalDeductions` — kept for back-compat with
   * callers from before Phase P3's deduction components existed, when
   * this was simply the sum of every (then earnings-only) component. */
  totalMonthly: number;
};

/**
 * Payroll Enterprise Gap Analysis Phase P3 — the SAP IT0045 equivalent:
 * a loan or salary advance issued to an employee, recovered via a fixed
 * per-period installment until paid off. Core-Employee-owned (same
 * `employee.manage.all`/`employee.view` gate every other sub-entity
 * uses); Payroll only ever reads it, exactly like recurring compensation.
 */
export type EmployeeLoanType = "loan" | "salary_advance";
/** PAY-13: `pending_approval` waits for the workflow engine, `on_hold` pauses recovery, `rejected` was refused. */
export type EmployeeLoanStatus = "pending_approval" | "active" | "on_hold" | "closed" | "cancelled" | "rejected";
export type EmployeeLoanApprovalStatus = "not_required" | "pending" | "approved" | "rejected";

export type EmployeeLoanView = {
  id: string;
  companyId: string;
  employeeId: string;
  loanType: EmployeeLoanType;
  reason: string | null;
  principalAmount: number;
  installmentAmount: number;
  outstandingBalance: number;
  status: EmployeeLoanStatus;
  issuedDate: string;
  createdByUserAccountId: string;
  createdAt: string;
  updatedAt: string;
  // PAY-13
  loanTypeId: string | null;
  loanTypeName: string | null;
  deductionStartDate: string | null;
  installmentsCount: number | null;
  guarantorEmployeeId: string | null;
  approvalStatus: EmployeeLoanApprovalStatus;
  /** Early settlement through payroll: the next regular run recovers the whole balance. */
  settlementRequested: boolean;
  holdReason: string | null;
  closedReason: string | null;
  /** True when a repayment schedule exists; false for a loan created before schedules (fixed instalment). */
  hasSchedule: boolean;
};

export type CreateEmployeeLoanRequest = {
  employeeId: string;
  loanType: EmployeeLoanType;
  reason?: string;
  principalAmount: number;
  /** Either the instalment or the number of instalments (the instalment is then worked out). */
  installmentAmount?: number;
  installmentsCount?: number;
  issuedDate: string;
  /** First instalment due date; defaults to the issue date. */
  deductionStartDate?: string;
  loanTypeId?: string;
  guarantorEmployeeId?: string;
};

export type CancelEmployeeLoanRequest = {
  reason?: string;
};

/** PAY-13: a catalogue entry with the tenant's own policy limits (null = no limit). */
export type LoanTypeView = {
  id: string;
  code: string;
  name: string;
  kind: EmployeeLoanType;
  maxInstallmentPercent: number | null;
  maxPrincipalMultiple: number | null;
  maxInstallments: number | null;
  requiresGuarantor: boolean;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
};

export type UpsertLoanTypeRequest = {
  code?: string;
  name?: string;
  kind?: EmployeeLoanType;
  maxInstallmentPercent?: number | null;
  maxPrincipalMultiple?: number | null;
  maxInstallments?: number | null;
  requiresGuarantor?: boolean;
  description?: string | null;
  isActive?: boolean;
  sortOrder?: number;
};

export type LoanScheduleStatus = "scheduled" | "held" | "skipped" | "paid" | "settled" | "cancelled";

export type LoanScheduleRowView = {
  id: string;
  loanId: string;
  installmentNo: number;
  dueDate: string;
  amount: number;
  status: LoanScheduleStatus;
  paidAmount: number;
  paidRunId: string | null;
  paidAt: string | null;
  note: string | null;
};

export type HoldEmployeeLoanRequest = { reason: string };
/** `resumeFrom` moves the remaining instalments so the first falls on or after that date. */
export type ResumeEmployeeLoanRequest = { resumeFrom?: string };
export type SkipLoanInstallmentsRequest = { installmentNos: number[]; reason: string };
export type SettleEmployeeLoanRequest = {
  /** `payroll`: the next regular run recovers the balance. `cash`: record money received. `withdraw`: undo a payroll request. */
  mode: "payroll" | "cash" | "withdraw";
  amount?: number;
  receivedOn?: string;
  reference?: string;
};
export type GenerateLoanScheduleRequest = { startDate?: string };

/** One finalized payroll period's worth of installment actually
 * deducted against a loan — the ledger `EmployeeLoanView.outstandingBalance`
 * is derived from. */
export type EmployeeLoanRepaymentView = {
  id: string;
  loanId: string;
  payrollRunId: string | null;
  payslipId: string | null;
  amount: number;
  createdAt: string;
  source: "payroll" | "cash" | "adjustment";
  reference: string | null;
};

/**
 * Payroll Enterprise Gap Analysis Phase P3, Section 6 — the SAP IT0015
 * equivalent: a one-time earning or deduction tied to a specific date,
 * not a recurring component and not (yet — that's the IT0267-equivalent,
 * Phase P4) tied to a specific off-cycle run. Core-Employee-owned, same
 * reasoning as `EmployeeLoanView` above.
 */
export type AdditionalPaymentType = "earning" | "deduction";
export type AdditionalPaymentStatus = "pending" | "consumed" | "cancelled";

export type EmployeeAdditionalPaymentView = {
  id: string;
  companyId: string;
  employeeId: string;
  paymentType: AdditionalPaymentType;
  label: string;
  amount: number;
  isTaxable: boolean;
  effectiveDate: string;
  status: AdditionalPaymentStatus;
  consumedPayrollRunId: string | null;
  createdByUserAccountId: string;
  createdAt: string;
  // PAY-12
  componentId: string | null;
  reasonCatalogItemId: string | null;
  reasonNote: string | null;
  approvalStatus: PayrollAdjustmentApprovalStatus;
  workflowInstanceId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
};

/** `pending` = waiting for a workflow decision; payroll only picks up `not_required` and `approved` adjustments. */
export type PayrollAdjustmentApprovalStatus = "not_required" | "pending" | "approved" | "rejected";

export type CreateEmployeeAdditionalPaymentRequest = {
  employeeId: string;
  paymentType: AdditionalPaymentType;
  /** Optional when `componentId` is given: the component's payslip label (or name) is used. */
  label?: string;
  /** PAY-12 - the pay component this adjustment is paid under. */
  componentId?: string | null;
  /** Catalog `payroll_adjustment_reason`. */
  reasonCatalogItemId?: string | null;
  reasonNote?: string | null;
  amount: number;
  /** Defaults to true for an earning; forced false for a deduction
   * (same "never presume a tax treatment" posture every other
   * compensation type in this file takes). */
  isTaxable?: boolean;
  effectiveDate: string;
};

/**
 * Payroll Enterprise Gap Analysis Phase P4 — the SAP IT0267 equivalent:
 * `EmployeeAdditionalPaymentView`'s sibling for a one-time earning or
 * deduction tied to a SPECIFIC off-cycle payroll run (`payrollRunId`,
 * fixed at creation — unlike IT0015's date-range matching, there is no
 * ambiguity about which run consumes it). Core-Employee-owned, same
 * `employee.manage.all`/`employee.view` gate. This is how HR enters a
 * bonus amount, an arrears figure, or a final-settlement line (gratuity,
 * leave encashment — this platform does not compute either from a
 * statutory formula; HR enters the amount they've already worked out,
 * the same "don't presume a tax/statutory treatment absent an
 * accountant's say" posture this file takes everywhere else) against the
 * off-cycle run that will pay it.
 */
export type EmployeeOffCyclePaymentStatus = "pending" | "consumed" | "cancelled";

export type EmployeeOffCyclePaymentView = {
  id: string;
  companyId: string;
  employeeId: string;
  payrollRunId: string;
  paymentType: AdditionalPaymentType;
  label: string;
  amount: number;
  isTaxable: boolean;
  status: EmployeeOffCyclePaymentStatus;
  createdByUserAccountId: string;
  createdAt: string;
  // PAY-12
  componentId: string | null;
  reasonCatalogItemId: string | null;
  reasonNote: string | null;
  approvalStatus: PayrollAdjustmentApprovalStatus;
  workflowInstanceId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
};

export type CreateEmployeeOffCyclePaymentRequest = {
  employeeId: string;
  payrollRunId: string;
  paymentType: AdditionalPaymentType;
  label?: string;
  componentId?: string | null;
  reasonCatalogItemId?: string | null;
  reasonNote?: string | null;
  amount: number;
  /** Defaults to true for an earning; forced false for a deduction. */
  isTaxable?: boolean;
};

export type SocialSecurityScheme = "none" | "pessi" | "sessi";

/**
 * One EFFECTIVE-DATED generation per tenant (Phase P1 — previously a
 * single mutable row, matching what `tax_slabs` already did before
 * 0033_effective_dating_leave_tax.sql). Every rate/base here is
 * tenant-editable DATA, not a hardcoded constant — Decision #14's
 * response to real, documented uncertainty in the current EOBI wage
 * base and PESSI/SESSI wage ceilings (see
 * `claude/statutory-payroll-rates-pakistan.md`). Lazily seeded with
 * researched-but-unconfirmed defaults the first time a tenant has none,
 * the same pattern Phase 9 used for leave balances. `updateSettings()`
 * SUPERSEDES the current generation rather than mutating it in place, so
 * a payroll run can resolve the rates that were actually in force during
 * its own period instead of always reading "today's" settings.
 */
export type PayrollSettingsView = {
  companyId: string;
  eobiEmployeeRatePercent: number;
  eobiEmployerRatePercent: number;
  eobiWageBase: number;
  socialSecurityScheme: SocialSecurityScheme;
  socialSecurityEmployerRatePercent: number;
  socialSecurityWageCeiling: number | null;
  /**
   * The standard working month (in hours) used to turn a monthly
   * compensation figure into an ordinary hourly rate — most directly,
   * `OvertimeService.priceClaim()`'s overtime-amount divisor
   * (see migration 0100_overtime_standard_monthly_hours.sql's header
   * comment for why this lives here rather than on `overtime_policies`).
   * Defaults to 208 (26 days x 8 hours) for every tenant until an admin
   * configures a different value for their own working-week convention.
   */
  standardMonthlyHours: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedAt: string;
};

export type UpdatePayrollSettingsRequest = {
  eobiEmployeeRatePercent?: number;
  eobiEmployerRatePercent?: number;
  eobiWageBase?: number;
  socialSecurityScheme?: SocialSecurityScheme;
  socialSecurityEmployerRatePercent?: number;
  socialSecurityWageCeiling?: number | null;
  /** Sanity-bounded 100-300; see `PayrollSettingsView.standardMonthlyHours`. */
  standardMonthlyHours?: number;
};

// effectiveFrom/effectiveTo (0033_effective_dating_leave_tax.sql): every
// bracket row is part of exactly one dated SET — listTaxSlabs()/
// setTaxSlabs() only ever return/replace the CURRENT set
// (effectiveTo: null); a closed set only appears via the history endpoint.
export type TaxSlabView = {
  id: string;
  companyId: string;
  minAnnualIncome: number;
  /** null = the top, uncapped bracket. */
  maxAnnualIncome: number | null;
  baseTax: number;
  ratePercent: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

/** One historical (or current) tax slab SET — `GET /payroll/tax-slabs/history`,
 * ordered oldest first. All slabs in one entry share the same effectiveFrom/effectiveTo. */
export type TaxSlabSetView = {
  effectiveFrom: string;
  effectiveTo: string | null;
  slabs: TaxSlabView[];
};

/** Replaces the tenant's entire tax slab table in one call — a partial
 * edit to a progressive bracket table (e.g. deleting one row) can leave
 * income gaps or overlaps that are much harder to validate piecemeal. */
export type SetTaxSlabsRequest = {
  slabs: Array<{
    minAnnualIncome: number;
    maxAnnualIncome: number | null;
    baseTax: number;
    ratePercent: number;
  }>;
};

// --- Payroll Formula Engine (0105_payroll_formulas.sql) -----------------
// Tenant-configurable, effective-dated overrides for the three
// already-parameterized payslip calculations. No override for a key (the
// default for every tenant) means the built-in calculation, unchanged.

export type PayrollFormulaKey = "income_tax" | "eobi_employee" | "eobi_employer";

// The wire shape of FormulaExpressionEngine's grammar
// (apps/api/src/payroll/formula-expression.engine.ts) — a narrow mirror
// for API consumers, the same precedent `WorkScheduleRuleExpression`
// set for the Rules Engine. Every node has exactly one operator key.
export type PayrollFormulaExpression =
  | { const: number }
  | { var: string }
  | { add: PayrollFormulaExpression[] }
  | { subtract: PayrollFormulaExpression[] }
  | { multiply: PayrollFormulaExpression[] }
  | { divide: PayrollFormulaExpression[] }
  | { min: PayrollFormulaExpression[] }
  | { max: PayrollFormulaExpression[] }
  | { round: { value: PayrollFormulaExpression; places: number } }
  | { percentOf: { value: PayrollFormulaExpression; percent: PayrollFormulaExpression } };

export type PayrollFormulaView = {
  id: string;
  companyId: string;
  formulaKey: PayrollFormulaKey;
  expression: PayrollFormulaExpression;
  effectiveFrom: string;
  /** null = currently open (applies to every run whose periodEnd is on/after effectiveFrom). */
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Starts an override for a key that has no currently-open one. `effectiveFrom` defaults to today. */
export type CreatePayrollFormulaRequest = {
  formulaKey: PayrollFormulaKey;
  expression: PayrollFormulaExpression;
  effectiveFrom?: string;
};

/** Supersedes the (open) override with a new expression from `effectiveFrom` (default today). Same-day = edited in place. */
export type UpdatePayrollFormulaRequest = {
  expression: PayrollFormulaExpression;
  effectiveFrom?: string;
};

/** Closes the open override; runs whose periodEnd is after `effectiveTo` fall back to the built-in calculation. */
export type EndDatePayrollFormulaRequest = {
  effectiveTo: string;
};

/** One variable a formula key's expression may reference — the stable evaluation-context contract. */
export type PayrollFormulaVariableView = {
  name: string;
  description: string;
};

export type PayrollFormulaContractView = {
  formulaKey: PayrollFormulaKey;
  description: string;
  variables: PayrollFormulaVariableView[];
};

// Phase P2: pending_approval/approved are new — a run must be submitted
// and approved before it can be finalized (PayrollService.finalizeRun()'s
// own guard). A rejected run reverts to `calculated` rather than a
// terminal `rejected` state — see 0093_payroll_approval_workflow.sql's
// header comment for why this deliberately differs from
// RequisitionStatus/leave request status. `reversed` (Phase P2,
// 0094_payroll_correction_reversal_and_permission_split.sql) is the one
// genuinely terminal state: a `finalized` run that's later found to be
// wrong moves here permanently — its payslips are preserved as-is for the
// record — and a brand new `draft` run opens for the same period via
// `PayrollRunView.correctiveRunId`.
export type PayrollRunStatus =
  | "draft"
  | "pre_validated"
  | "calculating"
  | "calculated"
  | "validated"
  | "pending_approval"
  | "approved"
  | "finalized"
  | "accounting"
  | "payment_released"
  | "reconciled"
  | "closed"
  | "reopened"
  | "reversed"
  | "cancelled";

/** Statuses at or beyond finalisation: the payslips are locked and count as paid history. */
export const PAYROLL_POST_FINAL_STATUSES: readonly PayrollRunStatus[] = [
  "finalized",
  "accounting",
  "payment_released",
  "reconciled",
  "closed",
  "reopened",
];

/**
 * Payroll Enterprise Gap Analysis Phase P4 — `regular` is every run that
 * existed before this phase (unchanged default/behavior). `off_cycle` is
 * a bonus/arrears/final-settlement/other run: it skips the single-
 * active-run-per-period uniqueness check entirely (see
 * `payroll_runs_active_period_key`'s relaxed WHERE clause,
 * 0113_payroll_off_cycle_runs.sql) so it can freely coexist with a
 * regular run, or any number of other off-cycle runs, covering the exact
 * same period.
 */
export type PayrollRunType = "regular" | "off_cycle";

/** Required when `runType` is `off_cycle`, forbidden otherwise.
 * `final_settlement` additionally requires `targetEmployeeId` (a single
 * terminated employee — never a batch) and is the only reason that
 * forces income tax to a full year-to-date true-up
 * (`PayrollService.calculateOnePayslip()`'s own `isFinalSettlement`
 * option) and pays off every active loan's FULL outstanding balance
 * rather than one installment. */
export type OffCycleReason = "bonus" | "arrears" | "final_settlement" | "other";

export type PayrollRunView = {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  /** Phase P4. `regular` for every run created before this phase. */
  runType: PayrollRunType;
  /** Set iff `runType` is `off_cycle`. */
  offCycleReason: OffCycleReason | null;
  /** Set iff this off-cycle run targets exactly one employee (always set
   * for `final_settlement`; optional for a single-employee bonus/arrears
   * run; null for a batch bonus/arrears run across many employees). */
  targetEmployeeId: string | null;
  workflowInstanceId: string | null;
  createdByUserAccountId: string;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Phase P2 follow-up (kumail's own production feedback, 2026-09-28):
   * an approver deciding a `pending_approval` run needs to see what
   * they're being asked to sign off on WITHOUT first drilling into every
   * individual payslip — a live test caught that the original UI let a
   * Payroll Approver click Approve with zero numbers on screen at all.
   * `payslipCount`/`totalGrossPay`/`totalNetPay` are always present
   * (0 for a run with no payslips yet, e.g. right after `createRun()`),
   * computed fresh from `payslips` on every read — never stored on
   * `payroll_runs` itself, so they can never drift from the actual rows. */
  payslipCount: number;
  totalGrossPay: number;
  totalNetPay: number;
  /** Set when the run pays only a selection of employees; null or absent for a run that pays everyone it covers. */
  selection?: PayrollRunSelection | null;
  /** Correction/Reversal (Phase P2). All four are null until
   * `PayrollService.reverseRun()` moves this run to `reversed` — at that
   * point they're set once and never change again, and `correctiveRunId`
   * points at the brand new `draft` run opened for the same period. */
  reversedAt: string | null;
  reversedByUserAccountId: string | null;
  reversalReason: string | null;
  correctiveRunId: string | null;
  /** Payroll Areas (0101_payroll_areas.sql). `null` = a company-wide run
   * (every run created before Payroll Areas existed, and still the
   * default); otherwise only that area's employees are calculated, and a
   * caller holding only `payroll.*.scoped` can act on it iff the area is
   * inside their data scope. */
  payrollAreaId: string | null;
  /** PAY-02. A simulation never consumes inputs, never reaches approval and never blocks a period. */
  isSimulation: boolean;
  currencyCode: string;
  roundingPrecision: number;
  idempotencyKey: string | null;
  /** PAY-03 - the payroll period this run belongs to, when it was created from one. */
  payrollPeriodId: string | null;
  /** The frozen settings / tax slabs / formulas the last calculation used (PAY-02, PAY-05). */
  ruleSnapshotId: string | null;
  /** How many times this run has been calculated; each calculation has its own rule snapshot. */
  calculationSequence: number;
  calculatedAt: string | null;
  /** PAY-06 - 'async' when the last calculation ran as a background job. */
  calculationMode: "sync" | "async";
  /** Null until the run has been calculated. */
  totals: PayrollRunTotals | null;
  populationCount: number;
  calculatedCount: number;
  failedCount: number;
  warningCount: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  closedAt: string | null;
};

export type PayrollRetroStatus = "detected" | "included" | "paid" | "dismissed" | "superseded";
export type PayrollRetroSourceEvent = "compensation_change" | "leave_change" | "manual";

/** PAY-12 - one difference between what a finalised payslip paid and what it would pay with today's data. */
export type PayrollRetroResultView = {
  id: string;
  employeeId: string;
  employeeNumber: string | null;
  employeeName: string | null;
  sourceRunId: string;
  sourcePayslipId: string;
  sourceEventType: PayrollRetroSourceEvent;
  sourceEventId: string | null;
  affectedPeriodStart: string;
  affectedPeriodEnd: string;
  componentKey: string;
  componentLabel: string;
  originalAmount: number;
  recalculatedAmount: number;
  /** Positive = underpaid (arrears owed to the employee); negative = overpaid (recovery). */
  delta: number;
  isTaxable: boolean;
  status: PayrollRetroStatus;
  targetRunId: string | null;
  includedPayslipId: string | null;
  paidAt: string | null;
  dismissedReason: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type DetectPayrollRetroRequest = {
  /** Only these employees; default = the target run's population. */
  employeeIds?: string[];
  /** How far back to look for finalised periods (default 12, at most 36). */
  lookbackMonths?: number;
};
export type DetectPayrollRetroResponse = {
  detected: number;
  unchanged: number;
  superseded: number;
  results: PayrollRetroResultView[];
  /** Paid payslips that could not be recalculated (the rest were still checked). */
  failures?: Array<{ employeeId: string; periodEnd: string; message: string }>;
};
export type IncludePayrollRetroRequest = { retroResultIds?: string[] };

export type PayrollExceptionClass = "calculation" | "data" | "duplicate_payment" | "rule_change" | "system";
export type PayrollExceptionStatus = "open" | "resolved" | "waived" | "superseded";

/** PAY-06 - one employee (or the run itself) that a calculation could not handle. */
export type PayrollExceptionView = {
  id: string;
  payrollRunId: string;
  payrollPartitionId: string | null;
  employeeId: string | null;
  employeeNumber: string | null;
  employeeName: string | null;
  calculationSequence: number;
  exceptionClass: PayrollExceptionClass;
  severity: "error" | "warning";
  message: string;
  detail: Record<string, unknown>;
  status: PayrollExceptionStatus;
  retryCount: number;
  lastRetryAt: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  correlationId: string | null;
  createdAt: string;
};

export type PayrollPartitionProgressView = {
  partitionNo: number;
  state: "pending" | "running" | "completed" | "failed";
  employeeCount: number;
  calculatedCount: number;
  failedCount: number;
  attempts: number;
  lastError: string | null;
};

export type PayrollCalculationProgressView = {
  payrollRunId: string;
  status: PayrollRunStatus;
  calculationMode: "sync" | "async";
  calculationSequence: number;
  jobId: string | null;
  jobStatus: "queued" | "running" | "completed" | "failed" | "cancelled" | null;
  progressPercent: number;
  progressNote: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  populationCount: number;
  calculatedCount: number;
  failedCount: number;
  openExceptionCount: number;
  partitionCount: number;
  partitionsCompleted: number;
  startedAt: string | null;
  partitions: PayrollPartitionProgressView[];
};

export type StartPayrollCalculationResponse = { run: PayrollRunView; jobId: string };
export type RetryPayrollExceptionResponse = { resolved: boolean; message: string; exception: PayrollExceptionView };
export type ResolvePayrollExceptionRequest = { note: string };

export type PayrollRunTotals = {
  gross: number;
  net: number;
  incomeTax: number;
  employeeDeductions: number;
  employerContributions: number;
  employerCost: number;
};

export type PayrollRunEventView = {
  id: string;
  payrollRunId: string;
  fromStatus: PayrollRunStatus | null;
  toStatus: PayrollRunStatus;
  action: string;
  actorUserAccountId: string | null;
  reason: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PayrollFindingSeverity = "error" | "warning" | "info";

export type PayrollValidationFinding = {
  severity: PayrollFindingSeverity;
  code: string;
  message: string;
  employeeId?: string;
  employeeNumber?: string;
};

export type PayrollRunValidationView = {
  run: PayrollRunView;
  stage: "pre_validation" | "validation";
  passed: boolean;
  errorCount: number;
  warningCount: number;
  findings: PayrollValidationFinding[];
};

export type CancelPayrollRunRequest = { reason: string };
export type ReopenPayrollRunRequest = { reason: string };
export type ClosePayrollRunRequest = { note?: string };

export type PayrollReversalView = {
  id: string;
  payrollRunId: string;
  correctiveRunId: string | null;
  reason: string;
  requestedBy: string | null;
  authorizedBy: string | null;
  authorizationPermission: string;
  impact: Record<string, unknown>;
  createdAt: string;
};

export type PayrollRunReopenView = {
  id: string;
  payrollRunId: string;
  fromStatus: PayrollRunStatus;
  reason: string;
  requestedBy: string | null;
  authorizedBy: string | null;
  createdAt: string;
};

export type PayrollRuleSnapshotView = {
  id: string;
  payrollRunId: string;
  calculationSequence: number;
  asOfDate: string;
  engineVersion: string;
  contentHash: string;
  settingsRowId: string | null;
  taxSlabIds: string[];
  formulaIds: string[];
  settings: Record<string, unknown>;
  taxSlabs: unknown[];
  formulas: unknown[];
  createdAt: string;
};

/** Fields of a payslip an authorised preparer may override (PAY-23); net pay is recomputed. */
export type PayrollOverridableField =
  | "incomeTaxMonthly"
  | "eobiEmployeeContribution"
  | "eobiEmployerContribution"
  | "socialSecurityEmployerContribution";

export type SetPayrollOverrideRequest = {
  employeeId: string;
  field: PayrollOverridableField;
  value: number;
  reason: string;
};

export type PayrollOverrideView = {
  id: string;
  payrollRunId: string;
  payslipId: string | null;
  employeeId: string;
  field: PayrollOverridableField;
  oldValue: number | null;
  newValue: number;
  reason: string;
  status: "applied" | "withdrawn";
  overriddenBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  reappliedCount: number;
  createdAt: string;
  withdrawnAt: string | null;
};


// ---------------------------------------------------------------- Step 9B: calendars, periods, population (PAY-03, PAY-04)
export type PayrollFrequency = "monthly" | "semi_monthly" | "bi_weekly" | "weekly";
export type PayrollPeriodStatus = "open" | "locked" | "closed";

export type PayrollCalendarView = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  frequency: PayrollFrequency;
  currencyCode: string;
  payDayOffset: number;
  cutoffDaysBeforeEnd: number;
  isActive: boolean;
  periodCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreatePayrollCalendarRequest = {
  code: string;
  name: string;
  frequency?: PayrollFrequency;
  currencyCode?: string;
  payDayOffset?: number;
  cutoffDaysBeforeEnd?: number;
};

export type UpdatePayrollCalendarRequest = {
  name?: string;
  payDayOffset?: number;
  cutoffDaysBeforeEnd?: number;
  isActive?: boolean;
};

export type PayrollPeriodView = {
  id: string;
  companyId: string;
  calendarId: string;
  calendarCode: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  cutoffDate: string;
  status: PayrollPeriodStatus;
  lockedAt: string | null;
  closedAt: string | null;
  runCount: number;
};

export type GeneratePayrollPeriodsRequest = {
  /** First day to cover (a period starting on or after this date is generated). */
  fromDate: string;
  /** How many consecutive periods to generate (1-60). */
  count: number;
};

export type GeneratePayrollPeriodsResponse = {
  created: PayrollPeriodView[];
  skipped: Array<{ periodStart: string; periodEnd: string; reason: string }>;
};

export type PayrollRunPopulationView = {
  id: string;
  payrollRunId: string;
  employeeId: string;
  employeeNumber: string;
  calculationSequence: number;
  inclusionReason: "area_member" | "company_wide" | "target_employee" | "final_settlement";
  status: "included" | "calculated" | "failed" | "excluded";
  exclusionReason: string | null;
  snapshot: Record<string, unknown>;
  createdAt: string;
};


// ---------------------------------------------------------------- Step 9C: structured payslip results (PAY-05, PAY-21)
export type PayslipComponentCategory = "earning" | "employee_deduction" | "employer_contribution" | "tax" | "statutory_deduction" | "recovery" | "adjustment";
/** gross: sums to gross pay; net: with gross, sums to net pay; employer_cost: employer contributions. */
export type PayslipComponentAffects = "gross" | "net" | "employer_cost";

export type PayslipComponentView = {
  lineNo: number;
  key: string;
  label: string;
  category: PayslipComponentCategory;
  affects: PayslipComponentAffects;
  /** Signed from the employee's point of view; employer contributions are positive. */
  amount: number;
  isTaxable: boolean;
  quantity: number | null;
  unit: string | null;
  rate: number | null;
  basisAmount: number | null;
  sourceType: string;
  sourceId: string | null;
  isOverridden: boolean;
  /** How the figure was reached (brackets used, proration days, rule overrides, ...). */
  trace: Record<string, unknown>;
};

export type PayslipConsumptionView = {
  sourceType: "additional_payment" | "off_cycle_payment" | "overtime" | "loan_installment" | "unpaid_leave" | "attendance_deduction";
  sourceId: string;
  amount: number;
  quantity: number | null;
  unit: string | null;
  status: "previewed" | "consumed" | "released";
};

export type PayslipDetailView = {
  payslipId: string;
  payrollRunId: string;
  employeeId: string;
  status: "calculated" | "overridden" | "final" | "voided";
  isImmutable: boolean;
  calculationSequence: number;
  employerCost: number;
  components: PayslipComponentView[];
  /** Payroll staff only. */
  consumptions: PayslipConsumptionView[] | null;
  /** Payroll staff only: everything the payslip was calculated from, apart from the rules. */
  inputSnapshot: Record<string, unknown> | null;
  inputSnapshotHash: string | null;
};

export type PayrollYtdView = {
  employeeId: string;
  taxYear: string;
  grossPay: number;
  taxableGross: number;
  incomeTax: number;
  eobiEmployee: number;
  eobiEmployer: number;
  socialSecurityEmployer: number;
  netPay: number;
  employerCost: number;
  payslipCount: number;
  lastPeriodEnd: string | null;
};

export type CreatePayrollRunRequest = {
  /** Same key + same body returns the run already created instead of a second one. */
  idempotencyKey?: string;
  /** Calculate without ever consuming inputs; cannot be approved or finalised. */
  isSimulation?: boolean;
  /** PAY-03. Create the run for this payroll period; its dates are used. A tenant policy can require this for regular runs. */
  payrollPeriodId?: string | null;
  /** Required unless `payrollPeriodId` is given (then they must match the period). */
  periodStart?: string;
  periodEnd?: string;
  /** Omit/null for a company-wide run (requires `payroll.calculate.all`). */
  payrollAreaId?: string | null;
  /** Phase P4. Omit for a `regular` run (unchanged default behavior). */
  runType?: PayrollRunType;
  /** Required iff `runType` is `off_cycle`; forbidden otherwise. */
  offCycleReason?: OffCycleReason;
  /** Required for `final_settlement`; optional single-employee scoping
   * for `bonus`/`arrears`/`other`; forbidden for a `regular` run. */
  targetEmployeeId?: string;
  /** Pay only some of the employees: any mix of employees, payroll areas and employee groups (each narrows the run).
   * Omit or leave all three empty to pay everyone the run covers. Not allowed on a run that targets one employee. */
  selection?: PayrollRunSelectionInput;
};

/** What the person chose when creating a run (the SAP payroll driver's "Selection" block, with several values per field). */
export type PayrollRunSelectionInput = {
  employeeIds?: string[];
  payrollAreaIds?: string[];
  employeeGroupIds?: string[];
};

/** The selection a run was created with. Employee groups are expanded to their members when the run is created. */
export type PayrollRunSelection = {
  employeeIds: string[];
  payrollAreaIds: string[];
  employeeGroupIds: string[];
  /** How many employees the chosen groups held when the run was created. */
  groupMemberCount: number;
};

// --- Payroll Areas (0101_payroll_areas.sql) -----------------------------
// The SAP HCM "Payroll Area" equivalent: a named grouping of employees
// processed together in one payroll run ("Karachi Monthly", "Lahore
// Weekly"). Its scope links (same shape as `DataScopeAssignmentView`) are
// what let a `payroll.*.scoped` holder's own data_scope_assignments
// resolve to "which payroll areas can this user touch".

export type PayrollAreaScopeLinkView = {
  id: string;
  payrollAreaId: string;
  scopeType: DataScopeType;
  scopeEntityId: string;
  createdAt: string;
};

export type PayrollAreaView = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  /** How many employees currently carry this area as `employees.payroll_area_id`. */
  employeeCount: number;
  /** PAY-04 */
  frequency: PayrollFrequency;
  currencyCode: string;
  calendarId: string | null;
  jurisdiction: string | null;
  scopeLinks: PayrollAreaScopeLinkView[];
  createdAt: string;
  updatedAt: string;
};

export type CreatePayrollAreaRequest = {
  code: string;
  name: string;
  description?: string | null;
  frequency?: PayrollFrequency;
  currencyCode?: string;
  calendarId?: string | null;
  jurisdiction?: string | null;
};

export type UpdatePayrollAreaRequest = {
  name?: string;
  description?: string | null;
  isActive?: boolean;
  frequency?: PayrollFrequency;
  currencyCode?: string;
  calendarId?: string | null;
  jurisdiction?: string | null;
};

export type AddPayrollAreaScopeLinkRequest = {
  scopeType: DataScopeType;
  scopeEntityId: string;
};

/** `payrollAreaId: null` removes the employee from any payroll area. */
export type AssignEmployeePayrollAreaRequest = {
  employeeId: string;
  payrollAreaId: string | null;
};

/** `PayrollService.reverseRun()`'s request body — a reason is mandatory
 * (Section 36's "capture reason" requirement), never optional the way an
 * approval decision's `comment` is. */
export type ReversePayrollRunRequest = {
  reason: string;
};

/** One ordered entry in a payslip's `calculationBreakdown` — the direct
 * answer to this phase's own exit criterion's "every intermediate figure
 * inspectable" requirement. */
export type PayrollCalculationStep = {
  label: string;
  value: number | string;
};

export type PayslipView = {
  id: string;
  companyId: string;
  payrollRunId: string;
  /** UI Re-skin Phase 4 — the owning run's period, off the same JOIN
   * `listPayslips()`/`getPayslip()` already did for run status/scope. Not
   * sensitive (it's the period this payslip itself belongs to), and not a
   * new permission — see PayrollService's `rowToPayslip()`. */
  payrollRunPeriodStart: string;
  payrollRunPeriodEnd: string;
  /** My Paystubs — 'regular' or 'off_cycle', and when the run was finalized (the pay date shown in the list). */
  payrollRunType: PayrollRunType;
  payrollRunFinalizedAt: string | null;
  employeeId: string;
  /** Denormalized snapshot at calculation time — see 0022_payroll.sql's
   * header comment for why these don't just join to `employees` live. */
  employeeNumber: string;
  bankAccountNumber: string | null;
  daysInPeriod: number;
  paidDays: number;
  unpaidLeaveDays: number;
  grossPay: number;
  /** The employee's ACTUAL taxable earnings for this one period (sum of
   * every taxable component's prorated amount, net of the taxable share
   * of any unpaid-leave deduction) — Phase P1's addition, used to
   * accumulate a real year-to-date total across a tax year's finalized
   * runs. Not annualized. */
  taxableGrossThisPeriod: number;
  /** The ESTIMATED full tax-year taxable income this period's income tax
   * was actually calculated against (year-to-date actual + this period +
   * a projection of the remaining tax-year days at this period's rate) —
   * the cumulative average-rate withholding method, not a naive
   * `thisPeriodGross * 12`. See `PayrollService.calculateOnePayslip()`'s
   * own doc comment for the full method and its documented limits. */
  taxableAnnualIncome: number;
  incomeTaxMonthly: number;
  eobiEmployeeContribution: number;
  eobiEmployerContribution: number;
  socialSecurityEmployerContribution: number;
  netPay: number;
  calculationBreakdown: PayrollCalculationStep[];
  /** Phase P3 (0112_loans_advances_additional_payments.sql) — structured
   * preview of which loan(s) this payslip's net pay deducted an
   * installment for, written at calculate() time and read back by
   * `PayrollService.finalizeRun()` to commit the matching
   * `employee_loan_repayments` ledger row. Empty for every payslip
   * calculated before this phase, or with no active loan. */
  loanDeductions: Array<{ loanId: string; amount: number }>;
  /** Same preview/commit pattern as `loanDeductions`, for the one-time
   * Additional Payments (IT0015 equivalent) this payslip's period window
   * covered. */
  consumedAdditionalPayments: Array<{ additionalPaymentId: string; amount: number }>;
  /** Phase P4 (0113_payroll_off_cycle_runs.sql) — same preview/commit
   * pattern, for the IT0267-equivalent Additional Off-Cycle Payments
   * entered against THIS SPECIFIC payroll run (`EmployeeOffCyclePaymentView`,
   * run-id-scoped at creation, unlike the date-range-matched IT0015
   * entity above). Populated for both off-cycle payslips
   * (`PayrollService.calculateOffCyclePayslip()`) and a `final_settlement`
   * payslip (`calculateOnePayslip()`'s own `offCycleRunId` option) —
   * empty for every regular-run payslip. */
  consumedOffCyclePayments: Array<{ offCyclePaymentId: string; amount: number }>;
  /** TLM-07 - the approved overtime claims this payslip paid; they become 'paid' when the run is finalised. */
  consumedOvertime: Array<{ overtimeId: string; amount: number }>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Payroll Enterprise Gap Analysis Phase P5 (0114_payroll_disbursement_
 * settings_and_payment_batches.sql) — "Payments & accounting integration."
 *
 * `DisbursementFieldKey` — the full set of columns `generateDisbursementFile()`
 * can emit. `employeeNumber`/`bankAccountNumber`/`netPay` existed before this
 * phase (the original generic 3-column CSV); everything else is sourced from
 * `employee_payment_accounts` (Core Employee's Payment/Bank card,
 * 0086_core_employee_payment_cost_allocation.sql) — the richer, actively-
 * maintained bank record Payroll never read before this phase (it was still
 * reading the long-stale flat `employees.bank_account_number` column).
 * `bankAccountNumber` is kept as a key (not removed) for backward
 * compatibility with any tenant's existing configuration/integration — it now
 * resolves to the employee's active primary payment account's `accountNumber`
 * where one exists, falling back to the legacy flat column only when it
 * doesn't, so an existing tenant's file keeps working (and gets MORE correct)
 * without needing to reconfigure anything.
 */
export type DisbursementFieldKey =
  | "employeeNumber"
  | "employeeName"
  | "cnic"
  | "paymentMethod"
  | "bankName"
  | "accountTitle"
  | "accountNumber"
  | "iban"
  | "branchCode"
  | "bankAccountNumber"
  | "netPay";

export type PayrollDisbursementSettingsView = {
  companyId: string;
  columns: DisbursementFieldKey[];
  /** PAY-16: a second person must approve a batch before it can be released to the bank. */
  requireReleaseApproval: boolean;
  updatedAt: string;
};

export type UpdatePayrollDisbursementSettingsRequest = {
  columns?: DisbursementFieldKey[];
  requireReleaseApproval?: boolean;
};

/** PAY-16: generated -> (approved) -> released -> acknowledged | rejected; a rejected batch is reissued; any unreleased one can be voided. */
export type PayrollPaymentBatchStatus = "generated" | "approved" | "released" | "acknowledged" | "rejected" | "reissued" | "voided";
export type PayrollPaymentItemStatus = "generated" | "released" | "acknowledged" | "rejected" | "reissued" | "voided";
export type BankFileDelimiter = "comma" | "semicolon" | "pipe" | "tab";

/** PAY-16: a payment-file layout defined by the tenant. */
export type BankFileFormatView = {
  id: string;
  code: string;
  name: string;
  delimiter: BankFileDelimiter;
  includeHeader: boolean;
  columns: DisbursementFieldKey[];
  headerLabels: Record<string, string>;
  fileExtension: string;
  isDefault: boolean;
  isActive: boolean;
};

export type UpsertBankFileFormatRequest = {
  code?: string;
  name?: string;
  delimiter?: BankFileDelimiter;
  includeHeader?: boolean;
  columns?: DisbursementFieldKey[];
  headerLabels?: Record<string, string>;
  fileExtension?: string;
  isDefault?: boolean;
  isActive?: boolean;
};

/** One payment to one employee, with the account as it stood when the file was made (only the last four digits are shown). */
export type PayrollPaymentItemView = {
  id: string;
  batchId: string;
  payrollRunId: string;
  payslipId: string;
  employeeId: string;
  employeeNumber: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  bankName: string | null;
  accountTitle: string | null;
  accountLast4: string | null;
  branchCode: string | null;
  status: PayrollPaymentItemStatus;
  bankReference: string | null;
  rejectionReason: string | null;
  retryCount: number;
  reissuedToItemId: string | null;
  acknowledgedAt: string | null;
};

export type AcknowledgePaymentBatchRequest = {
  /** The bank's reference for the whole file. */
  bankReference?: string;
  /** Per-payment results; any released payment not named is acknowledged. */
  items?: Array<{ itemId: string; status: "acknowledged" | "rejected"; bankReference?: string; reason?: string }>;
};

export type ReissuePaymentItemsRequest = { itemIds?: string[]; reason?: string };

/** One row per `generateDisbursementFile()` call that actually produced a
 * file — the duplicate-payment-protection ledger. See that method's own doc
 * comment in `PayrollService` for the confirm-to-regenerate guard this
 * drives. */
export type PayrollPaymentBatchView = {
  id: string;
  companyId: string;
  payrollRunId: string;
  batchReference: string;
  rowCount: number;
  /** Employees in this run who were left OUT of the bank file (no active
   * bank_transfer payment account on file) — surfaced so HR notices and
   * pays them another way, rather than a silent gap. */
  excludedCount: number;
  totalNetPay: number;
  status: PayrollPaymentBatchStatus;
  voidedReason: string | null;
  voidedAt: string | null;
  voidedByUserAccountId: string | null;
  generatedByUserAccountId: string;
  generatedAt: string;
  // PAY-16
  formatId: string | null;
  approvedByUserAccountId: string | null;
  approvedAt: string | null;
  releasedByUserAccountId: string | null;
  releasedAt: string | null;
  acknowledgedAt: string | null;
  bankReference: string | null;
  rejectionReason: string | null;
  reissuedFromBatchId: string | null;
};

/** `PayrollService.generateDisbursementFile()`'s response — the CSV plus
 * enough metadata for the caller (frontend) to show what just happened
 * without a second round-trip, and the batch history for this run so a
 * second click is an informed choice, not a guess. */
export type GenerateDisbursementFileResponse = {
  csv: string;
  batch: PayrollPaymentBatchView;
  /** Employees in this run with no usable bank_transfer payment account —
   * same employeeNumber/name shape as everywhere else this platform
   * surfaces a per-employee skip reason (`PayrollCalculationError`). */
  excluded: Array<{ employeeNumber: string; employeeName: string; reason: string }>;
};

/** Section 20 (Accounting & Costing Administration): "cost-center mapping;
 * ... organization-based costing; employee allocation; split allocation
 * where supported" — wired into Payroll via a READ-ONLY report over the
 * EXISTING `employee_cost_allocations` table (Core Employee Phase 8,
 * 0086_core_employee_payment_cost_allocation.sql), not a new costing
 * table or a GL/journal engine (that remains Phase P6). An employee with no
 * active cost allocation at all falls into the `costCenterId: null`
 * "Unallocated" bucket; an employee split across several cost centers
 * contributes a proportional share (by `allocationPercentage`) of their
 * gross/net pay to each one they're allocated to. */
export type PayrollCostCenterBreakdownRow = {
  costCenterId: string | null;
  costCenterCode: string | null;
  /** "Unallocated" for the `costCenterId: null` bucket. */
  costCenterName: string;
  employeeCount: number;
  totalGrossPay: number;
  totalNetPay: number;
};

export type PayrollCostCenterBreakdownView = {
  payrollRunId: string;
  rows: PayrollCostCenterBreakdownRow[];
};

/** `PayrollService.previewDisbursementFile()`'s response — same
 * rowCount/excluded/totalNetPay shape `generateDisbursementFile()` would
 * produce, plus the existing active batch (if any) so the frontend can
 * show the "already generated" warning and the excluded list BEFORE the
 * caller commits to a real (batch-writing) download. */
export type PreviewDisbursementFileResponse = {
  rowCount: number;
  excludedCount: number;
  excluded: Array<{ employeeNumber: string; employeeName: string; reason: string }>;
  totalNetPay: number;
  existingBatch: PayrollPaymentBatchView | null;
};

/** One per-employee failure from `calculateRun()` — collected rather
 * than thrown on the first bad row, the same "real error report, never
 * silent partial failure" discipline `ImportExportService.parseAndValidate()`
 * established for Conversions. */
export type PayrollCalculationError = {
  employeeId: string;
  message: string;
};

export type CalculatePayrollRunResponse = {
  run: PayrollRunView;
  payslipCount: number;
  errors: PayrollCalculationError[];
};

// --- Onboarding & Offboarding (0035_onboarding_offboarding.sql) --------
// Part 2's gap matrix row #21 ("Onboarding & Offboarding") flagged High —
// "real customer-facing gap". Onboarding is gated on the existing
// `recruitment` module_catalog entry (its own seeded name is literally
// "Recruitment & Onboarding" — see 0006_module_entitlement.sql), and
// Offboarding is gated on the existing `exit` module_catalog entry
// ("Exit & Offboarding") — both were pure placeholder rows with zero
// backend behind them since Phase 5; this increment is their first real
// implementation, not a new sellable module.
//
// Both sides share one checklist shape: a company configures a list of
// item TEMPLATES (title/category/who's responsible), and each real
// onboarding/offboarding instance clones the currently-active templates
// into its own item rows at creation time — so editing the template list
// later never rewrites history for an in-flight checklist. `responsibleRole`
// reuses the exact self/team/all RBAC scope vocabulary every other module
// in this codebase already uses, rather than inventing a parallel one:
// "self" = the employee completes it themselves, "team" = their manager,
// "all" = HR. Deliberately NOT routed through the Workflow Engine for a
// multi-step approval chain (unlike Leave/Recruitment) — same reasoning
// Attendance Corrections used for its own single-decider action: a
// checklist item has exactly one responsible party, not a chain of
// approvers. A real Workflow-Engine-routed clearance chain (e.g. IT then
// Finance then HR sign-off before an offboarding can finalize) is a
// deliberate, named follow-on for if/when real demand asks for it.

export type ChecklistCategory = "it" | "hr" | "finance" | "facilities" | "general";
export type ChecklistResponsibleRole = "self" | "team" | "all";
export type ChecklistItemStatus = "pending" | "completed" | "skipped";

/** LIF-09: who an onboarding item applies to. Empty / omitted lists mean "everyone". */
export type OnboardingItemApplicability = {
  employmentTypes?: string[];
  orgUnitIds?: string[];
  locationIds?: string[];
};
export type OnboardingAssigneeRule = "none" | "employee" | "manager";

export type OnboardingItemTemplateView = {
  id: string;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  isActive: boolean;
  applicability: OnboardingItemApplicability;
  assigneeRule: OnboardingAssigneeRule;
  dueOffsetDays: number | null;
};

export type CreateOnboardingItemTemplateRequest = {
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder?: number;
  applicability?: OnboardingItemApplicability;
  assigneeRule?: OnboardingAssigneeRule;
  dueOffsetDays?: number | null;
};

export type UpdateOnboardingItemTemplateRequest = Partial<CreateOnboardingItemTemplateRequest> & {
  isActive?: boolean;
};

export type OnboardingChecklistItemView = {
  id: string;
  templateItemId: string | null;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  status: ChecklistItemStatus;
  notes: string | null;
  completedAt: string | null;
  assignedToUserAccountId: string | null;
  assignedAt: string | null;
  dueDate: string | null;
  isOverdue: boolean;
  workflowTaskId: string | null;
};

/** LIF-09: an item on someone's to-do list, with enough context to act on it. */
export type MyOnboardingItemView = OnboardingChecklistItemView & {
  onboardingId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
};

export type AssignOnboardingItemRequest = {
  assignedToUserAccountId: string | null;
  dueDate?: string | null;
};

export type EmployeeOnboardingView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  status: "in_progress" | "completed";
  startedAt: string;
  completedAt: string | null;
  items: OnboardingChecklistItemView[];
};

export type UpdateChecklistItemRequest = {
  status: ChecklistItemStatus;
  notes?: string;
};

export type OffboardingReason = "resignation" | "termination" | "retirement" | "end_of_contract" | "other";

export type OffboardingItemTemplateView = {
  id: string;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  isActive: boolean;
};

export type CreateOffboardingItemTemplateRequest = {
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder?: number;
};

export type UpdateOffboardingItemTemplateRequest = Partial<CreateOffboardingItemTemplateRequest> & {
  isActive?: boolean;
};

export type OffboardingChecklistItemView = {
  id: string;
  templateItemId: string | null;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  status: ChecklistItemStatus;
  notes: string | null;
  completedAt: string | null;
};

export type EmployeeOffboardingView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  reason: OffboardingReason;
  lastWorkingDay: string;
  notes: string | null;
  status: "in_progress" | "completed";
  startedAt: string;
  completedAt: string | null;
  items: OffboardingChecklistItemView[];
  /** LIF-05 */
  reasonCode: string | null;
  noticePeriodDays: number | null;
  noticeStartDate: string | null;
  rehireEligibility: OffboardingRehireEligibility | null;
  rehireEligibilityNote: string | null;
  exitInterviewStatus: OffboardingExitInterviewStatus;
  exitInterviewCompletedAt: string | null;
  exitInterviewNotes: string | null;
  /** The lifecycle termination event this offboarding produced (set at completion). */
  terminationEventId: string | null;
};

export type OffboardingRehireEligibility = "eligible" | "conditional" | "not_eligible";
export type OffboardingExitInterviewStatus = "not_required" | "pending" | "completed" | "declined";

export type InitiateOffboardingRequest = {
  reason: OffboardingReason;
  lastWorkingDay: string;
  notes?: string;
  reasonCode?: string;
  noticePeriodDays?: number;
  noticeStartDate?: string;
  exitInterviewRequired?: boolean;
};

export type UpdateOffboardingExitRequest = {
  rehireEligibility?: OffboardingRehireEligibility;
  rehireEligibilityNote?: string;
  exitInterviewStatus?: OffboardingExitInterviewStatus;
  exitInterviewNotes?: string;
  noticePeriodDays?: number;
  noticeStartDate?: string;
};

// --- Overtime & On-Duty, first increment (2026-09-18) -------------------
// See 0038_overtime.sql. A per-company OvertimePolicyView is effective-
// dated via the shared EffectiveDatingEngine (single open row, same shape
// as TaxSlabView); an OvertimeRecordView snapshots its scheduled/actual/
// overtime minutes and the rate that applied at submission time, so a
// later policy or schedule change never rewrites an already-decided
// claim's meaning. Decided via the same plain RBAC self/team/all shape
// AttendanceCorrectionRequestView already uses, not the Workflow Engine.

export type OvertimeDayType = "weekday" | "rest_day" | "holiday";

export type OvertimeClaimStatus = "pending" | "approved" | "rejected" | "returned" | "cancelled" | "paid";

export type OvertimePolicyView = {
  id: string;
  companyId: string;
  dailyThresholdMinutes: number;
  roundingMinutes: number;
  weekdayRateMultiplier: number;
  restDayRateMultiplier: number;
  holidayRateMultiplier: number;
  effectiveFrom: string;
  /** TLM-07 - claimable minutes per day / per calendar month (null = no cap). */
  maxDailyMinutes: number | null;
  maxMonthlyMinutes: number | null;
  /** A claim needs a prior authorisation for the day. */
  requiresPreApproval: boolean;
  /** An approved claim may be taken as compensatory leave instead of pay. */
  compOffAllowed: boolean;
  /** Overtime minutes that earn one day of compensatory leave. */
  compOffMinutesPerDay: number;
};

export type SetOvertimePolicyRequest = {
  dailyThresholdMinutes?: number;
  roundingMinutes?: number;
  weekdayRateMultiplier?: number;
  restDayRateMultiplier?: number;
  holidayRateMultiplier?: number;
  maxDailyMinutes?: number | null;
  maxMonthlyMinutes?: number | null;
  requiresPreApproval?: boolean;
  compOffAllowed?: boolean;
  compOffMinutesPerDay?: number;
};

export type OvertimeRecordView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  attendanceRecordId: string | null;
  workDate: string;
  scheduledMinutes: number;
  actualMinutes: number;
  overtimeMinutes: number;
  dayType: OvertimeDayType;
  rateMultiplier: number;
  reason: string | null;
  status: OvertimeClaimStatus;
  isOnBehalf: boolean;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
  payoutMode: OvertimePayoutMode;
  /** Minutes removed from the claim by a daily / monthly / authorisation cap. */
  cappedMinutes: number;
  /** The payroll run that paid this claim (null until paid; comp-off claims are never paid by payroll). */
  consumedPayrollRunId: string | null;
  compOffDays: number | null;
};

export type SubmitOvertimeClaimRequest = {
  employeeId: string;
  workDate: string;
  reason?: string;
  /** "comp_off" takes the time back as compensatory leave; needs the policy to allow it. */
  payoutMode?: OvertimePayoutMode;
};

export type DecideOvertimeClaimRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- On-Duty, first increment (2026-09-18) -------------------------------
// See 0040_on_duty.sql. Distinct from Overtime (claiming extra hours after
// the fact): an On-Duty request authorizes, ahead of time, being away from
// the ordinary schedule/location for official work (a field visit, client
// site, training, business travel) over a date RANGE, not a single day's
// clock-in/out comparison. Decided via the same plain RBAC self/team/all
// shape AttendanceCorrectionRequestView/OvertimeRecordView already use.

export type OnDutyRequestStatus = "pending" | "approved" | "rejected" | "returned" | "cancelled";

export type OnDutyRequestView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  location: string | null;
  locationId: string | null;
  locationName: string | null;
  reason: string | null;
  status: OnDutyRequestStatus;
  isOnBehalf: boolean;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type SubmitOnDutyRequestRequest = {
  employeeId: string;
  startDate: string;
  endDate: string;
  location?: string;
  /** TLM-11 - a configured location; `location` stays as a free-text note. */
  locationId?: string;
  reason?: string;
};

// --- Phase 2 gap-fill item #5: data subject request queue --------------
// See 0057_data_subject_requests.sql. Routed through the generic
// WorkflowService multi-step approval engine (like leave_requests),
// deliberately NOT the single-decider pattern
// AttendanceCorrectionRequestView/OnDutyRequestView use — a privacy
// request plausibly needs a real review chain (HR, then a compliance
// officer), which is exactly what the workflow engine is for.
// "Fulfilled" is a distinct, explicit step from "approved": approval
// decides whether the request is legitimate, fulfillment records that
// someone actually carried it out (exported the data, corrected the
// record, or completed the deletion) and how.
export type DataSubjectRequestType = "access" | "correction" | "deletion";
export type DataSubjectRequestStatus = "pending" | "approved" | "rejected" | "fulfilled";

export type DataSubjectRequestView = {
  id: string;
  companyId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  requestType: DataSubjectRequestType;
  description: string;
  status: DataSubjectRequestStatus;
  submittedByUserAccountId: string;
  isOnBehalf: boolean;
  workflowInstanceId: string | null;
  decisionComment: string | null;
  fulfilledByUserAccountId: string | null;
  fulfilledAt: string | null;
  fulfillmentNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitDataSubjectRequestRequest = {
  employeeId: string;
  requestType: DataSubjectRequestType;
  description: string;
};

export type DecideDataSubjectRequestRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

export type FulfillDataSubjectRequestRequest = {
  fulfillmentNote: string;
};

export type DecideOnDutyRequestRequest = {
  decision: "approved" | "rejected";
  comment?: string;
};

// --- Phase 3 item #8: Security Policy (advanced) — Security Posture Score -
// Entirely computed, read-only, and derived from data this codebase
// already collects (MFA enrollment, SSO configuration, IP allow/denylist,
// concurrent-session limits, admin lockouts, lockout policy) — no new
// table. See SecurityPostureService for the point-weighting rationale
// behind each signal; `pointsPossible` across `signals` always sums to
// `maxScore`, and `score` is just the sum of each signal's `pointsEarned`.
// This is deliberately NOT a security rating service or a benchmark
// against other tenants — it's a checklist that tells a Platform Admin
// which of a small number of concrete, actionable things this tenant
// hasn't turned on yet.
export type SecurityPostureSignalKey =
  | "admin_mfa_coverage"
  | "sso_configured"
  | "ip_allow_or_denylist"
  | "concurrent_session_limit"
  | "no_active_admin_lockouts"
  | "lockout_policy_not_permissive";

export type SecurityPostureSignal = {
  key: SecurityPostureSignalKey;
  label: string;
  passed: boolean;
  pointsEarned: number;
  pointsPossible: number;
  detail: string;
};

export type SecurityPostureScore = {
  companyId: string;
  score: number;
  maxScore: number;
  signals: SecurityPostureSignal[];
  computedAt: string;
};

// --- Organization Management, Phase 1: canonical Org Unit hierarchy ---
// See claude/organization-management-4000-gap-analysis-and-roadmap.md's
// "Phase 1 — Foundation" row and 0065_organization_units.sql's own header
// comment for the full design writeup. `OrgUnitView` is the CURRENT
// (denormalized-cache) state the API actually returns for hierarchy
// reads; `OrgUnitVersionView` is one entry of its effective-dated history
// (`GET /organization/units/:id/history`), the same split
// `LeavePolicyView`/`LeavePolicyVersionView` already established.

/** A free but validated set (CHECK-enforced in 0065) — never a fixed
 * depth/level. Depth comes only from how many `parentId` hops a tenant
 * actually creates. */
export type OrgUnitType = "department" | "division" | "business_unit" | "function";

export type OrgUnitStatus = "active" | "archived";

export type OrgUnitView = {
  id: string;
  companyId: string;
  parentId: string | null;
  unitType: OrgUnitType;
  code: string | null;
  name: string;
  status: OrgUnitStatus;
  /** "Head of Department" — the one Position (within THIS org unit) whose
   * occupant is this unit's head, mirroring the "Chief position" concept
   * enterprise HR systems' org-chart views already surface (kumail's own
   * request). `null` means no head is currently designated — a normal,
   * unremarkable state for a brand-new unit, not an error. Set/cleared via
   * the dedicated `POST /organization/units/:id/head-position` action
   * (`OrgUnitsService.setHeadPosition()`), not a plain field on
   * `UpdateOrgUnitRequest` below, since it needs its own validation (the
   * position must belong to this exact org unit) the same way reparenting
   * needed its own `move()` action. See `ORG_STRUCTURE_RELATIONSHIP_CODES`
   * below — this is reference code `ST-060`. */
  headPositionId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `GET /organization/units/tree` — the whole company's hierarchy,
 * nested. Built server-side (OrgUnitsService.getTree()) off the same
 * recursive-CTE primitive `getDescendants()` uses, the same "server
 * decides scope/shape, client just renders it" split
 * `EmployeesService.orgChart()` already established for the manager
 * self-reference. */
export type OrgUnitTreeNode = OrgUnitView & {
  children: OrgUnitTreeNode[];
};

export type CreateOrgUnitRequest = {
  name: string;
  unitType: OrgUnitType;
  code?: string;
  parentId?: string;
  /** Defaults to today (server date) when omitted, same as every other
   * EffectiveDatingEngine consumer's `effectiveFrom`. */
  effectiveFrom?: string;
};

/** Renames/retypes/recodes a unit in place — reparenting is a distinct
 * action (`POST /organization/units/:id/move`) since it's the one edit
 * that needs the cycle guard, not a plain field patch. */
export type UpdateOrgUnitRequest = {
  name?: string;
  unitType?: OrgUnitType;
  code?: string;
  effectiveFrom?: string;
};

export type MoveOrgUnitRequest = {
  /** `null` moves the unit to become a root. */
  parentId: string | null;
  effectiveFrom?: string;
};

/** `POST /organization/units/:id/head-position` — `positionId: null` clears
 * the head (a real, required value here, same "null is a value, omission
 * is a validation error" posture `MoveOrgUnitRequest.parentId` already
 * takes); a non-null value must be a Position that belongs to this exact
 * org unit — validated server-side, not merely by this type. */
export type SetOrgUnitHeadPositionRequest = {
  positionId: string | null;
  effectiveFrom?: string;
};

export type OrgUnitVersionView = {
  id: string;
  orgUnitId: string;
  parentId: string | null;
  unitType: OrgUnitType;
  code: string | null;
  name: string;
  status: OrgUnitStatus;
  headPositionId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

// --- Organization Management, Phase 2: Job + Position Architecture ----
// See the Master Engineering Instruction doc's Section 9 (Position
// Management) + Section 10 (Job Architecture), and
// 0068_job_position_architecture.sql's own header comment for the full
// design writeup. `JobView`/`PositionView` are the CURRENT
// (denormalized-cache) state the API returns for reads; `JobVersionView`/
// `PositionVersionView` are one entry of each entity's effective-dated
// history — the exact same split `OrgUnitView`/`OrgUnitVersionView`
// established above, applied a second time.

/** A validated-but-open set (CHECK-enforced in 0068) — not a rigid,
 * hardcoded taxonomy; a dedicated Job Family master is a future gap-fill
 * item, not built in this phase. */
export type JobFamily =
  | "engineering"
  | "sales"
  | "marketing"
  | "finance"
  | "hr"
  | "operations"
  | "legal"
  | "customer_support"
  | "product"
  | "administration"
  | "executive"
  | "other";

export type JobStatus = "active" | "archived";

export type JobView = {
  id: string;
  companyId: string;
  jobCode: string | null;
  title: string;
  /** Free grade/band label (e.g. "L4", "Band 3") — tenants' banding
   * schemes vary too widely to normalize into a table this phase. */
  jobLevel: string | null;
  jobFamily: JobFamily | null;
  description: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateJobRequest = {
  title: string;
  jobCode?: string;
  jobFamily?: JobFamily;
  jobLevel?: string;
  description?: string;
  /** Defaults to today (server date) when omitted, same as every other
   * EffectiveDatingEngine consumer's `effectiveFrom`. */
  effectiveFrom?: string;
};

export type UpdateJobRequest = {
  title?: string;
  jobCode?: string;
  jobFamily?: JobFamily;
  jobLevel?: string;
  description?: string;
  effectiveFrom?: string;
};

export type JobVersionView = {
  id: string;
  jobId: string;
  jobCode: string | null;
  title: string;
  jobFamily: JobFamily | null;
  jobLevel: string | null;
  description: string | null;
  status: JobStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

/** `vacant` (zero occupants — a first-class, valid state, not an edge
 * case, per the master instruction) / `filled` (an employee currently
 * occupies it — set ONLY by PositionsService.assignEmployee(), never by a
 * plain field patch) / `frozen` (temporarily not fillable) / `abolished`
 * (permanently retired — a soft-delete state, the row is never removed). */
export type PositionStatus = "vacant" | "filled" | "frozen" | "abolished" | "pending_approval" | "rejected";

/** ORG-02: one employee's slot in a (possibly multi-incumbent) position. */
export type PositionIncumbentView = {
  id: string;
  positionId: string;
  employeeId: string;
  employeeName: string | null;
  fte: number;
  status: "active" | "ended";
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type PositionBudgetView = {
  id: string;
  positionId: string;
  fiscalYear: number;
  plannedHeadcount: number;
  budgetAmount: number | null;
  currency: string;
  notes: string | null;
  updatedAt: string;
};

export type UpsertPositionBudgetRequest = {
  plannedHeadcount: number;
  budgetAmount?: number | null;
  currency?: string;
  notes?: string;
};

export type PositionRelationshipType = "reports_to" | "dotted_line";

export type PositionRelationshipView = {
  id: string;
  positionId: string;
  relatedPositionId: string;
  relatedPositionTitle: string | null;
  relationshipType: PositionRelationshipType;
  status: "active" | "ended";
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type CreatePositionRelationshipRequest = {
  relatedPositionId: string;
  relationshipType: PositionRelationshipType;
  effectiveFrom?: string;
};

export type PositionPlanningSummaryRow = {
  positionId: string;
  positionTitle: string;
  orgUnitId: string;
  status: PositionStatus;
  fiscalYear: number;
  approvedHeadcount: number;
  plannedHeadcount: number | null;
  filledFte: number;
  openCapacityFte: number;
  openRequisitionHeadcount: number;
  budgetAmount: number | null;
  overPlanned: boolean;
};

export type PositionView = {
  id: string;
  companyId: string;
  orgUnitId: string;
  jobId: string | null;
  /** Organization Management Phase 4 additions
   * (0073_locations_and_financial_centers.sql) — nullable, additive. A
   * position can carry a financial-dimension assignment alongside its
   * structural one (org unit) and its work-definition one (job). */
  costCenterId: string | null;
  profitCenterId: string | null;
  positionCode: string | null;
  positionTitle: string;
  headcountFte: number;
  status: PositionStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreatePositionRequest = {
  orgUnitId: string;
  jobId?: string;
  costCenterId?: string;
  profitCenterId?: string;
  /** Defaults to the linked job's current title when omitted and a
   * `jobId` is given; required when no `jobId` is given. Independently
   * editable afterward either way — a position's title does not stay
   * mechanically pinned to its job's title. */
  positionTitle?: string;
  positionCode?: string;
  headcountFte?: number;
  effectiveFrom?: string;
};

/** Renames/retitles/recodes/reassigns-job/adjusts-headcount in place —
 * status transitions (freeze/unfreeze/abolish/reactivate,
 * assign/unassign) are their own dedicated actions below, not a plain
 * field patch, the same "the one edit that needs guarding gets its own
 * endpoint" split `MoveOrgUnitRequest` established for org units. */
export type UpdatePositionRequest = {
  orgUnitId?: string;
  jobId?: string | null;
  /** `null` clears the link; omitted leaves it unchanged — the same
   * three-way "set / clear / leave alone" distinction `jobId` above
   * already established. */
  costCenterId?: string | null;
  profitCenterId?: string | null;
  positionTitle?: string;
  positionCode?: string;
  headcountFte?: number;
  effectiveFrom?: string;
};

export type AssignPositionRequest = {
  employeeId: string;
  effectiveFrom?: string;
};

export type PositionVersionView = {
  id: string;
  positionId: string;
  orgUnitId: string;
  jobId: string | null;
  costCenterId: string | null;
  profitCenterId: string | null;
  positionCode: string | null;
  positionTitle: string;
  headcountFte: number;
  status: PositionStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

// --- Organization Management, Phase 3: Employee Organizational
// Assignment + Reporting Relationships -----------------------------
// See the Master Engineering Instruction doc's Section 11 (Employee
// Organizational Assignment) + Section 12 (Reporting Relationships), and
// 0071_employee_org_assignments_and_relationships.sql's own header comment
// for the full design writeup. `EmployeeOrgAssignmentView`/
// `OrgRelationshipView` are the CURRENT (denormalized-cache) state the API
// returns for reads; `EmployeeOrgAssignmentVersionView`/
// `OrgRelationshipVersionView` are one entry of each entity's
// effective-dated history — the same split `OrgUnitView`/`JobView`/
// `PositionView` already established, applied a third time.

/** `primary` — the one canonical assignment every employee should have at
 * most one open of at a time (DB-enforced). The other five may coexist,
 * any number at once, alongside a `primary` assignment or each other. */
export type AssignmentType = "primary" | "secondary" | "concurrent" | "temporary" | "acting" | "secondment";

export type AssignmentStatus = "active" | "ended";

export type EmployeeOrgAssignmentView = {
  id: string;
  companyId: string;
  employeeId: string;
  assignmentType: AssignmentType;
  orgUnitId: string;
  positionId: string | null;
  /** Phase 5 (Location) placeholder — no canonical Location entity exists
   * yet, so this is an opaque, unvalidated id for now. See this phase's
   * migration header comment. */
  locationId: string | null;
  status: AssignmentStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeOrgAssignmentRequest = {
  employeeId: string;
  assignmentType: AssignmentType;
  orgUnitId: string;
  positionId?: string;
  locationId?: string;
  /** Defaults to today (server date) when omitted, same as every other
   * EffectiveDatingEngine consumer's `effectiveFrom`. */
  effectiveFrom?: string;
};

/** Moves this assignment to a different org unit/position/location in
 * place — `assignmentType` is immutable once created (create a new
 * assignment slot instead of retyping an existing one) and `status` is a
 * dedicated action (`POST .../:id/end`), not a plain field patch, the same
 * "the one edit that needs its own endpoint" split `MoveOrgUnitRequest`/
 * `AssignPositionRequest` already established. */
export type UpdateEmployeeOrgAssignmentRequest = {
  orgUnitId?: string;
  /** `null` clears the position link; omitted leaves it unchanged. */
  positionId?: string | null;
  /** `null` clears the location link; omitted leaves it unchanged. */
  locationId?: string | null;
  effectiveFrom?: string;
};

export type EmployeeOrgAssignmentVersionView = {
  id: string;
  employeeOrgAssignmentId: string;
  employeeId: string;
  assignmentType: AssignmentType;
  orgUnitId: string;
  positionId: string | null;
  locationId: string | null;
  status: AssignmentStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

/** `direct` — the one canonical "solid-line manager" relationship every
 * employee should have at most one open of at a time (DB-enforced),
 * synced point-in-time onto `employees.managerId` on every write (see
 * `EmployeeView.managerId`'s own doc comment). The other four may coexist,
 * any number at once, alongside a `direct` relationship or each other.
 * `secondment` (0103_org_relationship_secondment_type.sql) is the host-side
 * manager of a secondment (`EmployeeLifecycleService.second()`), which
 * until then had to reuse `temporary`. */
export type OrgRelationshipType = "direct" | "dotted_line" | "matrix" | "temporary" | "acting" | "secondment";

export type OrgRelationshipStatus = "active" | "ended";

/**
 * Organization Management — relationship reference codes (kumail's own
 * request: "there should be relationship codes like SAP standards ... but
 * unique, don't copy same from SAP"). Enterprise HR systems label every
 * organizational relationship with a short, stable code so it can be
 * referenced unambiguously in exports, support conversations, and
 * integration mappings, rather than only by a longer display label that
 * could be reworded later. This is AIHXM's OWN numbering — deliberately
 * NOT SAP's single-letter-direction + three-digit Infotype 1001 scheme
 * (A012/B012, A008/B008, ...): no `A`/`B` direction letters (this product
 * doesn't model a relationship as a bidirectional pair of rows the way
 * SAP's own HRP1001 table does — one row, one code, read from whichever
 * side makes sense in context), a `ST-`/`RL-` category prefix instead of a
 * bare number, and independent, gap-left numbering per category so a
 * future addition never forces renumbering an existing code.
 *
 * `ST-` (Structure) codes describe how the fixed master-data objects
 * relate to each other — Position to Org Unit/Job/Cost Center/Profit
 * Center, Employee to Position (the "holder" relationship), Org Unit to
 * Position (the "head of department" relationship, `head_position_id` on
 * `org_units`), and Org Unit to Cost Center (an org unit's own budget
 * dimension, `cost_centers.org_unit_id` — see `ST-070` below). Every one
 * of these already exists as a plain foreign key (`positions.org_unit_id`,
 * `employees.position_id`, `org_units.head_position_id`,
 * `cost_centers.org_unit_id`, ...); this table adds no new column or
 * behavior of its own, it only gives each existing link a reference code
 * for display.
 *
 * `org_unit_cost_center` (`ST-070`) is deliberately the ONLY structure
 * code read from the "child" side rather than the "parent" side of its
 * own foreign key: `cost_centers.org_unit_id` already points FROM the
 * cost center TO the org unit it belongs to (0073_locations_and_financial_centers.sql,
 * Phase 4 — a cost center is "optionally linked to an org unit", the same
 * shape Job/Location already use), so kumail's "org unit's own cost
 * center" request is this existing relationship, surfaced in the
 * Organization workspace, NOT a second, competing pointer added to
 * `org_units` itself — that would let a cost center's own org unit and an
 * org unit's own cost center disagree with each other, which a single
 * foreign key can't do. One org unit can have zero, one, or several cost
 * centers tagged to it (unlike Head of Department's strictly-one-or-none
 * `head_position_id`), so this is a filter over the existing
 * `cost_centers` list, not a field on `OrgUnitView` — see
 * `OrgUnitDetailPage.tsx`'s Overview tab. No monetary "budget" figure
 * exists anywhere in Cost Center today (`CostCenterView` is
 * code/name/orgUnitId/status only, the same flat-catalog shape as Job) —
 * an actual planned-vs-actual budget amount would mean integrating with
 * Payroll's cost data, which is its own, separately-scoped feature, not a
 * field this pass adds.
 *
 * `RL-` (Reporting Line) codes cover the six `OrgRelationshipType`
 * values `OrgRelationshipsService` already models. Numbered in tens
 * (100, 110, 120, ...) rather than consecutively so a sixth type (the
 * master engineering instruction's own "functional manager"/"delegate"/
 * "supervisor"/"project manager"/"HR relationship" — deferred, not built
 * yet) can be inserted with a code that sorts in a sensible place without
 * touching any code already in use.
 *
 * Purely a reference/display label — carries no authorization or
 * validation behavior of its own.
 */
export const ORG_STRUCTURE_RELATIONSHIP_CODES = {
  position_org_unit: { code: "ST-010", label: "Position — Org Unit" },
  position_job: { code: "ST-020", label: "Position — Job" },
  position_cost_center: { code: "ST-030", label: "Position — Cost Center" },
  position_profit_center: { code: "ST-040", label: "Position — Profit Center" },
  employee_position_holder: { code: "ST-050", label: "Employee — Position (Holder)" },
  org_unit_head_position: { code: "ST-060", label: "Org Unit — Position (Head of Department)" },
  org_unit_cost_center: { code: "ST-070", label: "Org Unit — Cost Center" },
} as const;

export type OrgStructureRelationshipKey = keyof typeof ORG_STRUCTURE_RELATIONSHIP_CODES;

export const ORG_REPORTING_RELATIONSHIP_CODES: Record<OrgRelationshipType, { code: string; label: string }> = {
  direct: { code: "RL-100", label: "Direct Manager" },
  dotted_line: { code: "RL-110", label: "Dotted-Line Manager" },
  matrix: { code: "RL-120", label: "Matrix Manager" },
  temporary: { code: "RL-130", label: "Temporary Manager" },
  acting: { code: "RL-140", label: "Acting Manager" },
  secondment: { code: "RL-150", label: "Secondment Host Manager" },
};

export type OrgRelationshipView = {
  id: string;
  companyId: string;
  /** The report. */
  employeeId: string;
  /** The manager (or dotted-line/matrix/temporary/acting/secondment counterpart). */
  managerEmployeeId: string;
  relationshipType: OrgRelationshipType;
  status: OrgRelationshipStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateOrgRelationshipRequest = {
  employeeId: string;
  managerEmployeeId: string;
  relationshipType: OrgRelationshipType;
  effectiveFrom?: string;
};

/** Reassigns the manager/counterpart side of this relationship in place —
 * `relationshipType`/`employeeId` are immutable once created (create a new
 * relationship instead of retyping an existing one); `status` is a
 * dedicated action (`POST .../:id/end`), not a plain field patch. */
export type UpdateOrgRelationshipRequest = {
  managerEmployeeId?: string;
  effectiveFrom?: string;
};

export type OrgRelationshipVersionView = {
  id: string;
  orgRelationshipId: string;
  employeeId: string;
  managerEmployeeId: string;
  relationshipType: OrgRelationshipType;
  status: OrgRelationshipStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

// --- Organization Management, Phase 4: Locations & Cost/Profit Centers ---
// See the Master Engineering Instruction doc's Section 14 (Location
// Management), and 0073_locations_and_financial_centers.sql's own header
// comment for the full design writeup. `LocationView`/`CostCenterView`/
// `ProfitCenterView` are the CURRENT (denormalized-cache) state the API
// returns for reads; their `*VersionView` counterparts are one entry of
// each entity's effective-dated history — the same split `OrgUnitView`/
// `JobView`/`PositionView` already established, applied a fourth/fifth/
// sixth time.

/** A validated-but-open set, never a fixed number of hierarchy levels —
 * exactly `OrgUnitType`'s own posture. A single-site tenant might give
 * every location `locationType: 'site'` with no parent at all; a
 * multi-country enterprise nests all five. */
export type LocationType = "country" | "region" | "city" | "site" | "building";

export type LocationStatus = "active" | "archived";

export type LocationView = {
  id: string;
  companyId: string;
  parentId: string | null;
  locationType: LocationType;
  code: string | null;
  name: string;
  address: string | null;
  status: LocationStatus;
  /** PAY-28: the province / jurisdiction for provincial social security (inherited by sites below it). */
  statutoryJurisdiction: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Server-built (LocationsService.getTree()), the same shape
 * `OrgUnitTreeNode` already established for the org unit hierarchy. */
export type LocationTreeNode = LocationView & {
  children: LocationTreeNode[];
};

export type CreateLocationRequest = {
  parentId?: string;
  locationType: LocationType;
  code?: string;
  name: string;
  address?: string;
  effectiveFrom?: string;
};

export type UpdateLocationRequest = {
  locationType?: LocationType;
  code?: string;
  name?: string;
  address?: string;
  effectiveFrom?: string;
};

/** The one edit that needs the cycle guard — kept as its own dedicated
 * action, exactly `MoveOrgUnitRequest`'s own split from `UpdateOrgUnitRequest`. */
export type MoveLocationRequest = {
  /** `null` moves the location to become a root. */
  parentId: string | null;
  effectiveFrom?: string;
};

export type LocationVersionView = {
  id: string;
  locationId: string;
  parentId: string | null;
  locationType: LocationType;
  code: string | null;
  name: string;
  address: string | null;
  status: LocationStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

export type CostCenterStatus = "active" | "archived";

export type CostCenterView = {
  id: string;
  companyId: string;
  code: string | null;
  name: string;
  orgUnitId: string | null;
  status: CostCenterStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateCostCenterRequest = {
  code?: string;
  name: string;
  orgUnitId?: string;
  effectiveFrom?: string;
};

export type UpdateCostCenterRequest = {
  code?: string;
  name?: string;
  /** `null` clears the org unit link; omitted leaves it unchanged. */
  orgUnitId?: string | null;
  effectiveFrom?: string;
};

export type CostCenterVersionView = {
  id: string;
  costCenterId: string;
  code: string | null;
  name: string;
  orgUnitId: string | null;
  status: CostCenterStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

/** Structurally identical to CostCenter — a distinct entity (own table,
 * own type), not a `type` discriminator on one shared shape, matching
 * 0073's own header comment on why the two are separate tables. */
export type ProfitCenterStatus = "active" | "archived";

export type ProfitCenterView = {
  id: string;
  companyId: string;
  code: string | null;
  name: string;
  orgUnitId: string | null;
  status: ProfitCenterStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateProfitCenterRequest = {
  code?: string;
  name: string;
  orgUnitId?: string;
  effectiveFrom?: string;
};

export type UpdateProfitCenterRequest = {
  code?: string;
  name?: string;
  orgUnitId?: string | null;
  effectiveFrom?: string;
};

export type ProfitCenterVersionView = {
  id: string;
  profitCenterId: string;
  code: string | null;
  name: string;
  orgUnitId: string | null;
  status: ProfitCenterStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

// -----------------------------------------------------------------------
// Organization Management, Phase 5 — Reorganization workflow & data
// quality. See 0076_reorganization_changes.sql's own header comment for
// the full design writeup (scope, validation approach, why no stable-
// identity+version split this time).
// -----------------------------------------------------------------------

export type OrgChangeStatus =
  | "draft"
  | "validated"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "published"
  | "failed";

export type OrgChangeItemAction =
  | "move"
  | "rename"
  | "retype"
  | "archive"
  | "activate"
  // ORG-07: a reorganization can also batch positions, locations, cost / profit centers and assignments.
  | "position_freeze"
  | "position_unfreeze"
  | "position_abolish"
  | "position_reactivate"
  | "position_rename"
  | "position_move"
  | "location_rename"
  | "location_archive"
  | "location_activate"
  | "cost_center_rename"
  | "cost_center_archive"
  | "cost_center_activate"
  | "profit_center_rename"
  | "profit_center_archive"
  | "profit_center_activate"
  | "assignment_transfer";

/** What an item targets. `org_unit` items use `orgUnitId`; every other type uses `entityId`
 * (for `assignment` the entity is the EMPLOYEE whose primary assignment moves). */
export type OrgChangeEntityType = "org_unit" | "position" | "location" | "cost_center" | "profit_center" | "assignment";

/**
 * Cross-module integration audit Item 7 (2026-10-01) — what an `archive`
 * item does about FILLED positions still inside the unit it archives
 * (0098_org_change_item_position_cascade.sql). `require_vacant` (default):
 * a blocking validation error, re-checked at execution. `auto_unassign`:
 * execution vacates those positions (never abolishes them) and ends every
 * open assignment slot pointing at the unit, in the same transaction,
 * audited as `source: org_change:<id>`. No effect on other actions.
 */
export type OrgChangeCascadeAction = "require_vacant" | "auto_unassign";

export type OrgChangeItemView = {
  id: string;
  orgChangeId: string;
  sequence: number;
  /** Null for non-org-unit items. */
  orgUnitId: string | null;
  entityType: OrgChangeEntityType;
  entityId: string | null;
  /** Action-specific extras, e.g. `{ orgUnitId }` for position_move / assignment_transfer. */
  payload: Record<string, unknown>;
  action: OrgChangeItemAction;
  newParentId: string | null;
  newName: string | null;
  newUnitType: string | null;
  cascadeAction: OrgChangeCascadeAction;
  appliedAt: string | null;
  createdAt: string;
};

export type OrgChangeImpactSummary = {
  affectedOrgUnitCount: number;
  affectedPositionCount: number;
  affectedEmployeeCount: number;
  /**
   * Organization Management Phase 10 (Unified Integration & Synchronization
   * Requirements, Section 18) — the two additive counts that section asks
   * for beyond the original three above. "Affected data scope rules" is
   * Section 18's third ask; deliberately not represented here since no
   * assignment-based Data Scope capability exists yet for a reorganization
   * to affect (see Phase 11's own scope) — adding a field for a capability
   * that doesn't exist would just always read 0, which is worse than
   * omitting it and documenting why.
   */
  affectedReportingRelationshipCount: number;
  affectedFinancialCenterCount: number;
  /**
   * Cross-module integration audit Item 7 (2026-10-01) — FILLED positions
   * sitting directly in a unit this change ARCHIVES: either blocking
   * (`require_vacant` items) or about to be vacated (`auto_unassign`).
   * Optional so impact summaries stored before this field existed still
   * type-check.
   */
  filledPositionsInArchivedUnitsCount?: number;
  warnings: string[];
};

export type OrgChangeView = {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  status: OrgChangeStatus;
  effectiveDate: string;
  createdByUserAccountId: string;
  workflowInstanceId: string | null;
  validationErrors: string[] | null;
  validationWarnings: string[] | null;
  impactSummary: OrgChangeImpactSummary | null;
  failureReason: string | null;
  validatedAt: string | null;
  executedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrgChangeItemView[];
};

export type CreateOrgChangeItemRequest = {
  /** Required for org-unit items (the default entityType). */
  orgUnitId?: string;
  entityType?: OrgChangeEntityType;
  /** Required for every non-org-unit item. */
  entityId?: string;
  payload?: Record<string, unknown>;
  action: OrgChangeItemAction;
  newParentId?: string;
  newName?: string;
  newUnitType?: string;
  /** Defaults to `require_vacant` — see OrgChangeCascadeAction. */
  cascadeAction?: OrgChangeCascadeAction;
};

export type CreateOrgChangeRequest = {
  title: string;
  description?: string;
  effectiveDate: string;
  items: CreateOrgChangeItemRequest[];
};

export type OrgChangeValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

// -----------------------------------------------------------------------
// Organization Management, Phase 6 — Events, integration contract, and
// core reporting. `OrganizationCommandCenterSummary` backs the scoped
// Command Center panel on the portal home page (see
// organization-command-center.service.ts's own header comment); the
// `org.unit.changed`/`org.position.changed`/`org.assignment.changed`
// domain events themselves are plain `WebhookEvent` rows (already typed)
// with an `{ eventVersion: 1, changeType, ... }` payload shape documented
// in each firing service's own `publishChanged()` — not given their own
// named types here since nothing in this codebase consumes a webhook
// payload's shape at the type level (the receiving end is always an
// external tenant integration).
// -----------------------------------------------------------------------

export type OrganizationCommandCenterRecentChange = {
  id: string;
  title: string;
  status: OrgChangeStatus;
  effectiveDate: string;
  updatedAt: string;
};

export type OrganizationCommandCenterSummary = {
  generatedAt: string;
  totalOrgUnits: number;
  totalPositions: number;
  vacantPositions: number;
  filledPositions: number;
  frozenPositions: number;
  abolishedPositions: number;
  activeAssignments: number;
  reorganizationsInFlight: number;
  recentReorganizations: OrganizationCommandCenterRecentChange[];
  totalLocations: number;
  totalCostCenters: number;
  totalProfitCenters: number;
  dataQualityIssues: number;
  integrityWarnings: OrganizationIntegrityWarning[];
};

// -----------------------------------------------------------------------
// Organization Management, Phase 8 (Unified Integration & Synchronization
// Requirements, Section 25 — "Organization Integrity Dashboard"). Each
// warning is a real, computed count against data that already exists —
// see `organization-command-center.service.ts`'s own header comment for
// exactly what each code checks and why. `dataQualityIssues` on the
// summary above is the sum of every warning's `count`, matching Section
// 25's own mockup ("Data Quality Issues  12").
// -----------------------------------------------------------------------

export type OrganizationIntegrityWarningCode =
  | "employees_without_primary_assignment"
  | "positions_without_org_unit"
  | "employees_without_reporting_line"
  | "invalid_expired_locations"
  | "conflicting_assignments"
  | "orphaned_organizational_references"
  | "legacy_records_not_mapped";

export type OrganizationIntegrityWarning = {
  code: OrganizationIntegrityWarningCode;
  label: string;
  count: number;
};


// --- Step 3: configuration versions (CFG-02), rule registry (CFG-14) ----

export type ConfigurationVersionStatus = "draft" | "validated" | "published" | "retired";

export type ConfigurationVersionView = {
  id: string;
  companyId: string;
  domain: string;
  versionNo: number;
  status: ConfigurationVersionStatus;
  snapshot: Record<string, unknown>;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  changeReason: string | null;
  changeRequestId: string | null;
  createdAt: string;
  publishedAt: string | null;
};

export type CreateConfigurationVersionRequest = {
  domain: string;
  /** Omit to capture the domain's current state. */
  snapshot?: Record<string, unknown>;
  changeReason?: string;
};

export type RuleType = "validation" | "default" | "visibility" | "editability" | "applicability" | "eligibility" | "calculation";

export type RuleDefinitionView = {
  id: string;
  companyId: string;
  ruleKey: string;
  ruleType: RuleType;
  name: string;
  description: string | null;
  targetObject: string | null;
  targetField: string | null;
  ownerModule: string | null;
  isActive: boolean;
};

export type RuleVersionView = {
  id: string;
  ruleDefinitionId: string;
  versionNo: number;
  expression: Record<string, unknown>;
  message: string | null;
  status: "draft" | "published" | "retired";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  changeReason: string | null;
};

export type CreateRuleDefinitionRequest = {
  ruleKey: string;
  ruleType: RuleType;
  name: string;
  description?: string;
  targetObject?: string;
  targetField?: string;
  ownerModule?: string;
};

export type CreateRuleVersionRequest = {
  expression: Record<string, unknown>;
  message?: string;
  changeReason?: string;
};

export type RuleEvaluationResult = {
  ruleKey: string;
  versionNo: number;
  result: boolean;
  message: string | null;
  asOf: string;
};

// ---------------------------------------------------------------------------
// Step 4 (Gap Register EMP-01..06): canonical person, employment periods,
// effective-dated history and as-of reads.
// ---------------------------------------------------------------------------

export type PersonNationalIdType = "cnic" | "nicop" | "passport" | "b_form" | "other";

export type PersonView = {
  id: string;
  companyId: string;
  fullName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  preferredName: string | null;
  title: string | null;
  gender: string | null;
  nationality: string | null;
  secondNationality: string | null;
  language: string | null;
  maritalStatus: string | null;
  maritalStatusDate: string | null;
  placeOfBirth: string | null;
  nationalIdType: PersonNationalIdType;
  passportExpiry: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sensitive - present only for callers who may see sensitive identity data. */
  cnic?: string | null;
  dateOfBirth?: string | null;
  passportNumber?: string | null;
  ntn?: string | null;
};

export type UpdatePersonRequest = {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  preferredName?: string | null;
  title?: string | null;
  gender?: string | null;
  nationality?: string | null;
  secondNationality?: string | null;
  language?: string | null;
  maritalStatus?: string | null;
  maritalStatusDate?: string | null;
  placeOfBirth?: string | null;
  nationalIdType?: PersonNationalIdType;
  passportNumber?: string | null;
  passportExpiry?: string | null;
  ntn?: string | null;
  /** When the change takes effect (history window); defaults to today. */
  effectiveDate?: string;
  reason?: string;
};

/**
 * "My Personal Data" (Employee Self Service): the caller's own person record plus its dated history.
 * CNIC and date of birth are deliberately not part of it - those stay on the field-rule-filtered employee record.
 */
export type MyPersonalDataView = {
  employeeId: string;
  /** Null when the employee row is not linked to a person record yet. */
  person: PersonView | null;
  /** Oldest first; the last slice is the current one. */
  history: PersonVersionView[];
};

export type PersonVersionView = {
  id: string;
  personId: string;
  validFrom: string;
  validTo: string | null;
  fullName: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  preferredName: string | null;
  title: string | null;
  gender: string | null;
  nationality: string | null;
  secondNationality: string | null;
  language: string | null;
  maritalStatus: string | null;
  maritalStatusDate: string | null;
  placeOfBirth: string | null;
  nationalIdType: string | null;
  passportExpiry: string | null;
  recordedAt: string;
};

export type EmploymentView = {
  id: string;
  personId: string;
  employeeId: string | null;
  periodNumber: number;
  startDate: string;
  endDate: string | null;
  status: "active" | "ended";
  employeeNumber: string | null;
  rehireOfEmploymentId: string | null;
};

export type PersonDuplicateCandidateView = {
  personId: string;
  fullName: string;
  matchedOn: "cnic" | "date_of_birth_and_name";
  employeeNumbers: string[];
  hasActiveEmployment: boolean;
};

export type EmployeeAsOfView = {
  employeeId: string;
  asOf: string;
  personId: string;
  employmentId: string | null;
  periodNumber: number | null;
  employeeNumber: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
  gender: string | null;
  maritalStatus: string | null;
  nationality: string | null;
  orgUnitId: string | null;
  positionId: string | null;
  jobId: string | null;
  locationId: string | null;
  managerId: string | null;
  employeeSubgroupId: string | null;
  payrollAreaId: string | null;
  department: string | null;
  designation: string | null;
  salaryBand: string | null;
  employmentType: string | null;
  employmentStatus: string | null;
  statusReason: string | null;
  dateOfJoining: string | null;
  terminationDate: string | null;
};


// ---------------------------------------------------------------------------------------------------------------
// Step 9F - tax years, tax profiles, exemptions, credits and employee tax profiles (PAY-09, PAY-10)
// ---------------------------------------------------------------------------------------------------------------

export type TaxPublicationStatus = "draft" | "published" | "retired";

export type TaxYearView = {
  id: string;
  label: string;
  jurisdiction: string;
  startDate: string;
  endDate: string;
  status: TaxPublicationStatus;
  sourceReference: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  notes: string | null;
  profileCount: number;
  createdAt: string;
};
export type CreateTaxYearRequest = { label: string; jurisdiction?: string; startDate: string; endDate: string; notes?: string };
export type UpdateTaxYearRequest = { label?: string; startDate?: string; endDate?: string; notes?: string | null };
export type PublishTaxRecordRequest = { sourceReference: string };

export type TaxRoundingMode = "none" | "nearest" | "up" | "down";
export type TaxProfileSlabInput = { minAnnualIncome: number; maxAnnualIncome: number | null; baseTax: number; ratePercent: number };
export type TaxProfileSlabView = TaxProfileSlabInput & { id: string };
export type TaxExemptionType = "fixed_amount" | "percentage_of_income";
export type TaxCreditType = "fixed_amount" | "percentage_of_amount";

export type TaxExemptionView = {
  id: string;
  taxProfileId: string;
  code: string;
  name: string;
  exemptionType: TaxExemptionType;
  annualCap: number | null;
  ratePercent: number | null;
  requiresEvidence: boolean;
  sourceReference: string | null;
};
export type TaxCreditView = {
  id: string;
  taxProfileId: string;
  code: string;
  name: string;
  creditType: TaxCreditType;
  annualCap: number | null;
  ratePercent: number | null;
  requiresEvidence: boolean;
  sourceReference: string | null;
};
export type TaxExemptionInput = { code: string; name: string; exemptionType: TaxExemptionType; annualCap?: number | null; ratePercent?: number | null; requiresEvidence?: boolean; sourceReference?: string | null };
export type TaxCreditInput = { code: string; name: string; creditType: TaxCreditType; annualCap?: number | null; ratePercent?: number | null; requiresEvidence?: boolean; sourceReference?: string | null };

export type TaxProfileView = {
  id: string;
  taxYearId: string;
  taxYearLabel: string;
  code: string;
  name: string;
  description: string | null;
  roundingMode: TaxRoundingMode;
  roundingIncrement: number;
  surchargeThreshold: number | null;
  surchargeRatePercent: number | null;
  status: TaxPublicationStatus;
  sourceReference: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  slabs: TaxProfileSlabView[];
  exemptions: TaxExemptionView[];
  credits: TaxCreditView[];
  employeeCount: number;
  createdAt: string;
};
export type CreateTaxProfileRequest = {
  taxYearId: string;
  code: string;
  name: string;
  description?: string;
  roundingMode?: TaxRoundingMode;
  roundingIncrement?: number;
  surchargeThreshold?: number | null;
  surchargeRatePercent?: number | null;
};
export type UpdateTaxProfileRequest = Partial<Omit<CreateTaxProfileRequest, "taxYearId" | "code">>;

export type TaxFilerStatus = "filer" | "non_filer" | "late_filer" | "not_applicable";
export type TaxResidency = "resident" | "non_resident";
export type TaxClaimInput = { amount: number; evidenceRef?: string | null };
export type EmployeeTaxProfileView = {
  id: string;
  employeeId: string;
  taxProfileId: string | null;
  taxProfileCode: string | null;
  taxProfileName: string | null;
  filerStatus: TaxFilerStatus;
  taxResidency: TaxResidency;
  provincialScheme: "none" | "pessi" | "sessi" | "bessi" | "other" | null;
  claimedExemptions: Array<TaxClaimInput & { exemptionId: string }>;
  claimedCredits: Array<TaxClaimInput & { creditId: string }>;
  previousEmployerIncome: number;
  previousEmployerTax: number;
  previousEmployerTaxYear: number | null;
  notes: string | null;
  changeReasonNote: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};
export type SetEmployeeTaxProfileRequest = {
  effectiveFrom: string;
  taxProfileId?: string | null;
  filerStatus?: TaxFilerStatus;
  taxResidency?: TaxResidency;
  provincialScheme?: "none" | "pessi" | "sessi" | "bessi" | "other" | null;
  claimedExemptions?: Array<TaxClaimInput & { exemptionId: string }>;
  claimedCredits?: Array<TaxClaimInput & { creditId: string }>;
  previousEmployerIncome?: number;
  previousEmployerTax?: number;
  previousEmployerTaxYear?: number | null;
  notes?: string | null;
  changeReasonNote?: string | null;
};


// ---------------------------------------------------------------- PAY-18 reconciliations
export type PayrollReconciliationKind = "calculation" | "payroll" | "payment" | "bank" | "accounting" | "costing" | "tax" | "reversal";
export type PayrollReconciliationStatus = "matched" | "variance" | "pending" | "resolved";

export type PayrollReconciliationView = {
  id: string;
  payrollRunId: string;
  kind: PayrollReconciliationKind;
  sequence: number;
  status: PayrollReconciliationStatus;
  expectedAmount: number;
  actualAmount: number;
  variance: number;
  /** What was compared and, for a variance, the rows that differ. */
  detail: Record<string, unknown>;
  runBy: string | null;
  runAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

export type RunPayrollReconciliationRequest = { kinds?: PayrollReconciliationKind[] };
export type ResolvePayrollReconciliationRequest = { note: string };

// ---------------------------------------------------------------- PAY-14 final settlement / PAY-15 scheme ledgers
export type PayrollSchemeType = "provident_fund" | "gratuity" | "other";

/** Every figure is the tenant's own: nothing here has a shipped default. */
export type PayrollSchemeParameters = {
  /** provident_fund: the payslip component whose deductions are the employee's contribution (posted to the ledger when a run is finalised). */
  employeeComponentKey?: string | null;
  /** provident_fund: the payslip component that carries the employer's contribution. */
  employerComponentKey?: string | null;
  /** provident_fund: below this many months of service the employer's share is not paid out on separation. */
  employerVestingMonths?: number | null;
  /** gratuity: days of pay per year of service. */
  daysPerYearOfService?: number | null;
  /** gratuity: no gratuity is due before this many months of service. */
  minimumServiceMonths?: number | null;
  /** gratuity: monthly salary / this = one day's pay. */
  dailyRateDivisor?: number | null;
  /** gratuity: count completed years only, or pro-rata months. */
  serviceRounding?: "complete_years" | "pro_rata" | null;
  /** gratuity: whether the payment is taxable in the final payroll run. */
  isTaxable?: boolean | null;
};

export type PayrollSchemeDefinitionView = {
  id: string;
  code: string;
  name: string;
  schemeType: PayrollSchemeType;
  countryCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  parameters: PayrollSchemeParameters;
  /** False while a gratuity scheme still lacks figures the tenant has to supply. */
  isComplete: boolean;
  missingParameters: string[];
};

export type UpsertPayrollSchemeRequest = {
  code: string;
  name?: string;
  schemeType?: PayrollSchemeType;
  countryCode?: string;
  effectiveFrom: string;
  isActive?: boolean;
  parameters?: PayrollSchemeParameters;
};

export type EmployeeSchemeAccountView = {
  id: string;
  employeeId: string;
  schemeCode: string;
  status: "active" | "closed";
  openedOn: string;
  closedOn: string | null;
  balance: number;
};

export type SchemeLedgerEntryType = "opening_balance" | "employee_contribution" | "employer_contribution" | "withdrawal" | "payout" | "adjustment" | "reversal";

export type SchemeLedgerEntryView = {
  id: string;
  accountId: string;
  entryType: SchemeLedgerEntryType;
  amount: number;
  entryDate: string;
  payrollRunId: string | null;
  settlementId: string | null;
  reversesEntryId: string | null;
  note: string | null;
  createdAt: string;
};

export type PostSchemeLedgerEntryRequest = {
  entryType: "opening_balance" | "withdrawal" | "adjustment";
  /** Positive for an opening balance or withdrawal (a withdrawal is stored negative); signed for an adjustment. */
  amount: number;
  entryDate?: string;
  note?: string;
};

export type PayrollSettlementSettingsView = {
  dailyRateDivisor: number | null;
  /** Which monthly figure one day's pay (leave encashment, notice recovery) is taken from; the tenant chooses. */
  dailyRateBase: "basic_salary" | "gross_earnings" | null;
  leaveEncashmentEnabled: boolean;
  leaveEncashmentTaxable: boolean;
  noticeRecoveryEnabled: boolean;
  updatedAt: string | null;
};
export type UpdatePayrollSettlementSettingsRequest = Partial<Omit<PayrollSettlementSettingsView, "updatedAt">>;

export type FinalSettlementStatus = "open" | "calculated" | "approved" | "finalized" | "cancelled" | "reversed";
export type FinalSettlementLineKind = "salary_due" | "leave_encashment" | "gratuity" | "provident_fund" | "notice_recovery" | "loan_outstanding" | "tax_finalization" | "other_deductions";
export type FinalSettlementSettleVia = "payslip" | "scheme_ledger" | "run_result" | "info";

export type FinalSettlementLineView = {
  id: string;
  lineNo: number;
  kind: FinalSettlementLineKind;
  label: string;
  /** Signed: money to the employee is positive, money recovered from them negative. */
  amount: number;
  settleVia: FinalSettlementSettleVia;
  isTaxable: boolean | null;
  additionalPaymentId: string | null;
  schemeCode: string | null;
  basis: Record<string, unknown>;
  warning: string | null;
};

export type FinalSettlementView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  terminationEventId: string;
  lastWorkingDay: string;
  status: FinalSettlementStatus;
  payrollRunId: string | null;
  calculationSequence: number;
  calculatedBy: string | null;
  calculatedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  finalizedAt: string | null;
  isImmutable: boolean;
  cancelReason: string | null;
  result: Record<string, unknown> | null;
  lines: FinalSettlementLineView[];
};


// ---------------------------------------------------------------- Step 10D (PAY-17, 20, 22, 25, 26, 27)

// ---- PAY-27 payroll domain events (versioned payloads published through the outbox)
export type PayrollEventType =
  | "payroll.run.state_changed"
  | "payroll.run.finalized"
  | "payroll.employee.calculated"
  | "payroll.payment.status_changed"
  | "payroll.posting.status_changed";

export type PayrollRunStateChangedPayloadV1 = {
  runId: string;
  runType: string;
  payrollAreaId: string | null;
  periodStart: string;
  periodEnd: string;
  from: string | null;
  to: string;
  action: string;
  calculationSequence: number;
};
export type PayrollRunFinalizedPayloadV1 = {
  runId: string;
  runType: string;
  payrollAreaId: string | null;
  periodStart: string;
  periodEnd: string;
  currencyCode: string;
  payslipCount: number;
  /** Aggregate for the whole run (never an individual's pay - SEC-13 keeps salary-like figures out of events). */
  totalPayable: number;
  totalIncomeTax: number;
  totalEmployerCost: number;
  finalizedAt: string | null;
};
export type PayrollEmployeeCalculatedPayloadV1 = {
  runId: string;
  payslipId: string;
  employeeId: string;
  employeeNumber: string;
  calculationSequence: number;
};
export type PayrollPaymentStatusChangedPayloadV1 = {
  runId: string;
  batchId: string;
  batchReference: string;
  from: string | null;
  to: string;
  rowCount: number;
  /** Aggregate for the batch. */
  totalPayable: number;
};
export type PayrollPostingStatusChangedPayloadV1 = {
  runId: string;
  journalId: string;
  journalNumber: string | null;
  journalKind: "run" | "reversal";
  from: string | null;
  to: string;
  totalDebit: number;
  totalCredit: number;
};

export type PayrollEventCatalogEntry = {
  eventType: PayrollEventType;
  schemaVersion: number;
  aggregateType: string;
  description: string;
  fields: string[];
};

/** What a subscriber can rely on: event types, the schema version they carry, and the payload fields of that version. */
export const PAYROLL_EVENT_CATALOG: readonly PayrollEventCatalogEntry[] = [
  { eventType: "payroll.run.state_changed", schemaVersion: 1, aggregateType: "payroll_run", description: "A payroll run moved to a new state.", fields: ["runId", "runType", "payrollAreaId", "periodStart", "periodEnd", "from", "to", "action", "calculationSequence"] },
  { eventType: "payroll.run.finalized", schemaVersion: 1, aggregateType: "payroll_run", description: "A payroll run was finalised; its payslips are now settled.", fields: ["runId", "runType", "payrollAreaId", "periodStart", "periodEnd", "currencyCode", "payslipCount", "totalPayable", "totalIncomeTax", "totalEmployerCost", "finalizedAt"] },
  { eventType: "payroll.employee.calculated", schemaVersion: 1, aggregateType: "payroll_run", description: "One employee's payslip was calculated (published only while a subscription listens for it). Carries identifiers only: an individual's pay never travels in an event (SEC-13); the subscriber reads the payslip through the API.", fields: ["runId", "payslipId", "employeeId", "employeeNumber", "calculationSequence"] },
  { eventType: "payroll.payment.status_changed", schemaVersion: 1, aggregateType: "payroll_payment_batch", description: "A payment batch moved to a new state (generated, approved, released, acknowledged, rejected, voided).", fields: ["runId", "batchId", "batchReference", "from", "to", "rowCount", "totalPayable"] },
  { eventType: "payroll.posting.status_changed", schemaVersion: 1, aggregateType: "payroll_journal", description: "A payroll journal was generated, posted, reversed or discarded.", fields: ["runId", "journalId", "journalNumber", "journalKind", "from", "to", "totalDebit", "totalCredit"] },
];

// ---- PAY-17 accounting and costing
export type PayrollGlMatchType = "component_key" | "category" | "special";
export type PayrollGlMappingView = {
  id: string;
  matchType: PayrollGlMatchType;
  matchValue: string;
  debitAccountCode: string | null;
  creditAccountCode: string | null;
  description: string | null;
  isActive: boolean;
};
export type UpsertPayrollGlMappingRequest = {
  matchType: PayrollGlMatchType;
  matchValue: string;
  debitAccountCode?: string | null;
  creditAccountCode?: string | null;
  description?: string | null;
  isActive?: boolean;
};
export type PayrollJournalPurpose = "payroll_run" | "final_settlement" | "reversal";
export type PayrollJournalTypeView = {
  id: string;
  code: string;
  name: string;
  purpose: PayrollJournalPurpose;
  numberPrefix: string;
  nextNumber: number;
  isActive: boolean;
};
export type UpdatePayrollJournalTypeRequest = { name?: string; numberPrefix?: string; isActive?: boolean };
export type PayrollJournalStatus = "draft" | "posted" | "reversed" | "discarded";
export type PayrollJournalLineKind = "expense" | "employer_expense" | "liability" | "employer_liability" | "net_pay";
export type PayrollJournalLineView = {
  lineNo: number;
  accountCode: string;
  debit: number;
  credit: number;
  lineKind: PayrollJournalLineKind;
  componentKey: string | null;
  description: string | null;
  costCenterId: string | null;
  costCenterCode: string | null;
  profitCenterId: string | null;
  profitCenterCode: string | null;
};
export type PayrollJournalView = {
  id: string;
  payrollRunId: string;
  journalKind: "run" | "reversal";
  journalTypeCode: string;
  journalNumber: string | null;
  status: PayrollJournalStatus;
  reversesJournalId: string | null;
  postingDate: string;
  currencyCode: string;
  totalDebit: number;
  totalCredit: number;
  lineCount: number;
  postingReference: string | null;
  notes: string | null;
  generatedAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  lines?: PayrollJournalLineView[];
};
export type PayrollAccountingPreviewView = {
  payrollRunId: string;
  unmappedKeys: Array<{ key: string; category: string; affects: string; label: string }>;
  missingSpecial: string[];
  unallocatedEmployees: number;
  totalDebit: number;
  totalCredit: number;
  ready: boolean;
};
export type GeneratePayrollJournalRequest = { postingDate?: string; notes?: string };
export type PostPayrollJournalRequest = { postingReference?: string };
export type PayrollCostingRowView = {
  payslipId: string;
  employeeId: string;
  employeeNumber: string;
  costCenterId: string | null;
  costCenterCode: string | null;
  profitCenterId: string | null;
  profitCenterCode: string | null;
  allocationPercentage: number;
  allocationSource: "allocation" | "position" | "unallocated";
  grossCost: number;
  employerCost: number;
  totalCost: number;
  status: "draft" | "final" | "superseded";
};
export type PayrollCostingSummaryView = {
  payrollRunId: string;
  rows: PayrollCostingRowView[];
  byCostCenter: Array<{ costCenterId: string | null; costCenterCode: string | null; profitCenterId: string | null; grossCost: number; employerCost: number; totalCost: number; employees: number }>;
  totalCost: number;
};

// ---- PAY-20 documents
export type PayrollDocumentType = "payslip" | "tax_certificate" | "salary_certificate";
export type GeneratedDocumentView = {
  id: string;
  documentType: PayrollDocumentType;
  employeeId: string;
  employeeNumber: string | null;
  employeeName: string | null;
  payrollRunId: string | null;
  payslipId: string | null;
  taxYear: number | null;
  templateKey: string | null;
  templateSource: "built_in" | "custom";
  title: string;
  status: "issued" | "superseded" | "revoked";
  publishedAt: string | null;
  generatedAt: string;
  contentHash: string;
  revokeReason: string | null;
  content?: string;
};
export type PayrollDocumentSettingsView = {
  requirePublication: boolean;
  templateChoices: Array<{ documentType: PayrollDocumentType; templateKey: string | null }>;
  availableTemplates: Array<{ key: string; name: string }>;
};
export type UpdatePayrollDocumentSettingsRequest = {
  requirePublication?: boolean;
  /** templateKey null returns the type to its built-in body. */
  templateChoices?: Array<{ documentType: PayrollDocumentType; templateKey: string | null }>;
};
export type PayrollDocumentPlaceholderView = { documentType: PayrollDocumentType; placeholders: Array<{ key: string; description: string }> };
export type GenerateTaxCertificateRequest = { employeeId: string; taxYear: number };
export type GenerateSalaryCertificateRequest = { employeeId: string; addressedTo?: string; purpose?: string };

// ---- PAY-22 benefits
export type BenefitType = "health_insurance" | "life_insurance" | "pension" | "allowance" | "loan_scheme" | "other";
export type BenefitContributionMode = "fixed" | "percentage";
export type BenefitPlanView = {
  id: string;
  code: string;
  name: string;
  benefitType: BenefitType;
  description: string | null;
  employeeComponentId: string | null;
  employeeComponentKey: string | null;
  employerComponentKey: string | null;
  employeeContributionMode: BenefitContributionMode;
  employeeContributionValue: number | null;
  employerContributionMode: BenefitContributionMode;
  employerContributionValue: number | null;
  minServiceMonths: number | null;
  employmentTypes: string[] | null;
  payrollAreaId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "inactive";
  enrolledCount: number;
};
export type UpsertBenefitPlanRequest = {
  id?: string;
  code: string;
  name: string;
  benefitType?: BenefitType;
  description?: string | null;
  employeeComponentId?: string | null;
  employerComponentKey?: string | null;
  employeeContributionMode?: BenefitContributionMode;
  employeeContributionValue?: number | null;
  employerContributionMode?: BenefitContributionMode;
  employerContributionValue?: number | null;
  minServiceMonths?: number | null;
  employmentTypes?: string[] | null;
  payrollAreaId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  status?: "active" | "inactive";
};
export type BenefitEnrolmentView = {
  id: string;
  planId: string;
  planCode: string;
  planName: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  status: "enrolled" | "waived" | "ended";
  coverageLevel: string | null;
  employeeContributionOverride: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  endReason: string | null;
};
export type EnrolBenefitRequest = {
  planId: string;
  employeeId: string;
  effectiveFrom: string;
  coverageLevel?: string | null;
  employeeContributionOverride?: number | null;
  /** Records a deliberate decline instead of an enrolment. */
  waive?: boolean;
};
export type EndBenefitEnrolmentRequest = { effectiveTo: string; reason: string };
export type BenefitEligibilityView = { eligible: boolean; reasons: string[]; serviceMonths: number };
export type BenefitContributionView = {
  id: string;
  planId: string;
  enrolmentId: string;
  employeeId: string;
  employeeNumber: string;
  payrollRunId: string;
  periodEnd: string;
  employeeAmount: number;
  employerAmount: number;
  status: "accrued" | "reversed";
};

// ---- PAY-25 dashboard
export type PayrollDashboardRunView = {
  runId: string;
  runType: string;
  payrollAreaId: string | null;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  calculationMode: string;
  populationCount: number;
  calculatedCount: number;
  failedCount: number;
  openExceptions: number;
  partitions: { total: number; byState: Record<string, number> };
  progressPercent: number;
  throughputPerMinute: number | null;
  estimatedSecondsRemaining: number | null;
  jobStatus: string | null;
  paymentStatus: string | null;
  postingStatus: string | null;
  totalGross: number | null;
  totalNet: number | null;
  totalEmployerCost: number | null;
};
export type PayrollDashboardView = {
  generatedAt: string;
  runsByStatus: Record<string, number>;
  active: PayrollDashboardRunView[];
  recent: PayrollDashboardRunView[];
  attention: Array<{ runId: string; kind: string; message: string }>;
};

// ---- PAY-26 bulk payroll inputs
export type PayrollInputImportType = "payroll_components" | "payroll_payments";
export type PayrollInputBatchView = {
  id: string;
  importType: PayrollInputImportType;
  status: string;
  fileName: string | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  importedRows: number;
  failedRows: number;
  checkpointRow: number;
  allowPartial: boolean;
  backgroundJobId: string | null;
  createdAt: string;
  executedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};
export type PayrollInputRowView = {
  rowNumber: number;
  status: "valid" | "invalid" | "imported" | "failed";
  payload: Record<string, unknown>;
  errors: Array<{ field?: string; message: string }>;
  employeeId: string | null;
};
export type DryRunPayrollInputRequest = { importType: PayrollInputImportType; csv: string; fileName?: string; allowPartial?: boolean };
export type PayrollInputTemplateView = { importType: PayrollInputImportType; columns: Array<{ name: string; required: boolean; description: string }>; example: string };


/**
 * `GET /organization/structure` — the "Staff assignments (structure)" tree-table: org units, their positions and
 * the people holding them, one nested tree with the same columns as an enterprise HR structure view
 * (name, code, object id, relationship text, chief, valid from, valid to). Built server-side from the same
 * data-scoped lists the other organization screens use, so a caller only ever sees what they may see.
 */
export type OrgStructureNodeKind = "unit" | "position" | "holder";

export type OrgStructureNode = {
  /** Unique within the response ("unit:<id>", "position:<id>", "holder:<positionId>:<employeeId>"). */
  key: string;
  kind: OrgStructureNodeKind;
  /** The entity's own id (org unit, position or employee). */
  id: string;
  /** Short object id with a type letter, e.g. "O 3A9F01C2" (unit), "S ..." (position), "P ..." (person). */
  objectId: string;
  /** Unit code, position code or employee number. */
  code: string | null;
  /** Unit name, position title or the holder's name. */
  name: string;
  /** "Is line supervisor of" (unit under unit), "Incorporates" (position in unit), "Holder" (person in position); empty for a root unit. */
  relationshipText: string;
  /** Units only: whoever holds the unit's head position. */
  chiefName: string | null;
  /** ISO date (YYYY-MM-DD). */
  validFrom: string | null;
  /** ISO date, or null for "Unlimited". */
  validTo: string | null;
  /** unit: active/archived; position: vacant/filled/frozen/abolished; holder: null. */
  status: string | null;
  /** Positions only: this position is the head ("chief") position of its unit. */
  isChief: boolean;
  /** Holders only. */
  fte: number | null;
  /** Units only: department / division / business_unit / function. */
  unitType?: OrgUnitType;
  /** Units only: the parent unit, or null for a root. */
  parentId?: string | null;
  /** Positions only: the unit that owns the position. Holders: the unit of the position they hold. */
  orgUnitId?: string;
  /** Positions only: the position the holder sits in is `id` of the parent row; this is its cost center link. */
  costCenterId?: string | null;
  /** Units only: vacant positions directly in this unit. */
  vacantCount?: number;
  /** Holders only: the position they hold (the parent row's `id`). */
  positionId?: string;
  children: OrgStructureNode[];
};

export type OrgStructureView = {
  /** Server date the response was built on. */
  asOf: string;
  roots: OrgStructureNode[];
  /** false when the caller may not see employee records, so holders are left out. */
  peopleVisible: boolean;
};

// --- Starter setup (first-day defaults for a new company) ----------------

export type StarterSetupItemState = "ready" | "missing" | "unavailable" | "attention";

export type StarterSetupItem = {
  /** Stable id: `workflow:leave_request`, `holidays`, `leave_policy`, `shift`, `payroll_approver`. */
  key: string;
  group: "approvals" | "calendar" | "leave" | "attendance" | "payroll";
  label: string;
  /** One plain sentence about what is there or what the setup would add. */
  detail: string;
  state: StarterSetupItemState;
};

export type StarterSetupStatus = {
  items: StarterSetupItem[];
  /** True when applying the setup would add something. */
  canApply: boolean;
  /** Items the setup cannot do for the company and HR must decide (for example: nobody holds Payroll Approver). */
  needsAttention: number;
};

export type StarterSetupResult = {
  created: string[];
  skipped: string[];
  status: StarterSetupStatus;
};

// Employee numbering policy and ledger (Configuration Center > Employee numbering)
export type EmployeeNumberGenerationTiming = "hire" | "draft" | "save" | "approval";
export type EmployeeNumberPolicyView = {
  companyId: string;
  generationTiming: EmployeeNumberGenerationTiming;
  uniquenessScope: "company";
  resetPolicy: "never" | "yearly";
  allowManual: boolean;
  manualPattern: string;
  updatedAt: string | null;
};
export type EmployeeNumberLedgerView = {
  id: string;
  employeeNumber: string;
  state: "reserved" | "issued" | "void";
  seriesKey: string;
  sequenceNo: number | null;
  source: "generated" | "manual" | "imported" | "backfill";
  hireProcessId: string | null;
  employeeId: string | null;
  reservedAt: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
};
export type UpdateEmployeeNumberPolicyRequest = Partial<Pick<EmployeeNumberPolicyView, "generationTiming" | "resetPolicy" | "allowManual" | "manualPattern">>;
export * from "./payslip-design";
