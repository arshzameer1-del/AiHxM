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

export type FieldAccess = "view" | "edit" | "hidden";

export type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
};

export type Permission = {
  id: string;
  key: string;
  description: string | null;
};

export type UserRoleAssignment = {
  id: string;
  userAccountId: string;
  companyId: string;
  roleId: string;
  roleKey: string;
  createdAt: string;
};

export type AssignRoleRequest = {
  userAccountId: string;
  companyId: string;
  roleKey: string;
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

export type ApproverType = "role" | "specific_user" | "manager_of_submitter";

export type EscalationApproverType = "role" | "specific_user";

export type WorkflowApproverConfig = {
  approverType: ApproverType;
  roleId?: string;
  userAccountId?: string;
  escalationApproverType?: EscalationApproverType;
  escalationRoleId?: string;
  escalationUserAccountId?: string;
};

export type WorkflowFieldCondition = { field: string; equals: unknown };

export type WorkflowStepConfig = {
  stepOrder: number;
  name: string;
  condition?: WorkflowFieldCondition | null;
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
};

export type CreateWorkflowTemplateRequest = {
  key: string;
  name: string;
  objectKey: string;
  steps: WorkflowStepConfig[];
};

export type WorkflowInstanceStatus = "in_progress" | "approved" | "rejected" | "cancelled";
export type WorkflowStepStatus = "pending" | "skipped" | "approved" | "rejected";
export type WorkflowApprovalStatus = "pending" | "escalated" | "approved" | "rejected";

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
  decision: "approved" | "rejected" | null;
  comment: string | null;
};

export type WorkflowStepInstanceView = {
  id: string;
  stepOrder: number;
  name: string;
  status: WorkflowStepStatus;
  approvals: WorkflowStepApprovalView[];
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
};

export type ApprovalDecisionRequest = {
  decision: "approved" | "rejected";
  comment?: string;
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

export type EmploymentStatus = "active" | "on_leave" | "terminated";

// Phase 8 addition (plan doc Section 12's own canonical example names both
// "location" and "employment type" as attributes a tenant would group
// employees by) — a real employee attribute, not scaffolding invented only
// to make Employee Groups have something to condition on.
export type EmploymentType = "permanent" | "contract" | "probation" | "intern";

export type EmployeeView = {
  id: string;
  companyId: string;
  userAccountId: string | null;
  employeeNumber: string;
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
export type TenantRoleKey = "hr_admin" | "line_manager" | "employee_self_service" | "system_admin";

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

export type OrgChartNode = {
  id: string;
  employeeNumber: string;
  fullName: string;
  designation: string | null;
  department: string | null;
  directReports: OrgChartNode[];
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

export type JobHistoryEventType = "hire" | "promotion" | "transfer" | "salary_change" | "termination" | "rehire" | "other";

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
};

export type RecordJobHistoryRequest = {
  eventType: JobHistoryEventType;
  effectiveDate: string;
  department?: string;
  designation?: string;
  salaryBand?: string;
  notes?: string;
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
export type EmployeeGroupConditionField = "department" | "location" | "designation" | "employmentType" | "employmentStatus";

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
export type PolicyType = "leave";

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
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
};

export type EmployeeGroupPolicyAssignmentView = {
  id: string;
  groupId: string;
  policyType: PolicyType;
  policyId: string;
  createdAt: string;
};

export type AssignGroupPolicyRequest = {
  policyType: PolicyType;
  policyId: string;
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
export type LeaveType = "annual" | "casual" | "sick" | "unpaid";

export type LeaveBalanceView = {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  year: number;
  entitledDays: number;
  usedDays: number;
  remainingDays: number;
};

export type LeaveRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

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
  createdAt: string;
  updatedAt: string;
};

export type SubmitLeaveRequestRequest = {
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
};

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
export type AttendanceCorrectionStatus = "pending" | "approved" | "rejected";

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
};

export type CreateHolidayRequest = {
  name: string;
  holidayDate: string;
  isOptional?: boolean;
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

export type RequisitionStatus = "draft" | "pending_approval" | "approved" | "rejected" | "closed";

export type JobRequisitionView = {
  id: string;
  companyId: string;
  title: string;
  department: string | null;
  headcount: number;
  salaryBand: string | null;
  justification: string | null;
  hiringManagerId: string | null;
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
};

export type CandidateView = {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
};

export type CreateCandidateRequest = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
};

/** The Kanban board's own column set. Forward-only in this phase — see
 * KNOWN_ISSUES.md — `rejected` is reachable from any non-terminal stage,
 * but there is no "move a candidate backward" path yet. */
export type ApplicationStage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";

export type ApplicationView = {
  id: string;
  companyId: string;
  requisitionId: string;
  candidateId: string;
  stage: ApplicationStage;
  createdAt: string;
  updatedAt: string;
};

export type CreateApplicationRequest = {
  requisitionId: string;
  candidateId: string;
};

export type MoveApplicationStageRequest = {
  stage: ApplicationStage;
};

export type OfferStatus = "pending" | "accepted" | "declined" | "rescinded";

export type OfferView = {
  id: string;
  companyId: string;
  applicationId: string;
  salary: number;
  startDate: string;
  status: OfferStatus;
  extendedByUserAccountId: string;
  /** Set once `decideOffer()` records the candidate's decision — an
   * `accepted` offer's `hiredEmployeeId` then points at the real
   * Employee record it created. */
  hiredEmployeeId: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type ExtendOfferRequest = {
  applicationId: string;
  salary: number;
  startDate: string;
};

export type DecideOfferRequest = {
  decision: "accepted" | "declined";
};

export type DecideOfferResponse = {
  offer: OfferView;
  /** Present only when `decision: "accepted"` — the real Employee
   * record `decideOffer()` created via `EmployeesService.create()`,
   * complete with a freshly assigned Employee Number. */
  employee: EmployeeView | null;
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

export type GoalStatus = "active" | "completed";

export type GoalView = {
  id: string;
  companyId: string;
  reviewCycleId: string;
  employeeId: string;
  parentGoalId: string | null;
  title: string;
  description: string | null;
  weight: number | null;
  status: GoalStatus;
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
};

export type UpdateGoalRequest = {
  title?: string;
  description?: string;
  weight?: number;
  status?: GoalStatus;
};

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

export type CompensationView = {
  id: string;
  companyId: string;
  employeeId: string;
  monthlySalary: number;
  effectiveFrom: string;
  /** null = this is the employee's current rate. */
  effectiveTo: string | null;
  createdByUserAccountId: string;
  createdAt: string;
};

export type SetCompensationRequest = {
  employeeId: string;
  monthlySalary: number;
  effectiveFrom: string;
};

export type SocialSecurityScheme = "none" | "pessi" | "sessi";

/**
 * One row per tenant. Every rate/base here is tenant-editable DATA, not a
 * hardcoded constant — Decision #14's response to real, documented
 * uncertainty in the current EOBI wage base and PESSI/SESSI wage
 * ceilings (see `claude/statutory-payroll-rates-pakistan.md`). Lazily
 * seeded with researched-but-unconfirmed defaults the first time a
 * tenant has none, the same pattern Phase 9 used for leave balances.
 */
export type PayrollSettingsView = {
  companyId: string;
  eobiEmployeeRatePercent: number;
  eobiEmployerRatePercent: number;
  eobiWageBase: number;
  socialSecurityScheme: SocialSecurityScheme;
  socialSecurityEmployerRatePercent: number;
  socialSecurityWageCeiling: number | null;
  updatedAt: string;
};

export type UpdatePayrollSettingsRequest = {
  eobiEmployeeRatePercent?: number;
  eobiEmployerRatePercent?: number;
  eobiWageBase?: number;
  socialSecurityScheme?: SocialSecurityScheme;
  socialSecurityEmployerRatePercent?: number;
  socialSecurityWageCeiling?: number | null;
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

export type PayrollRunStatus = "draft" | "calculated" | "finalized";

export type PayrollRunView = {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  createdByUserAccountId: string;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePayrollRunRequest = {
  periodStart: string;
  periodEnd: string;
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
  employeeId: string;
  /** Denormalized snapshot at calculation time — see 0022_payroll.sql's
   * header comment for why these don't just join to `employees` live. */
  employeeNumber: string;
  bankAccountNumber: string | null;
  daysInPeriod: number;
  paidDays: number;
  unpaidLeaveDays: number;
  grossPay: number;
  taxableAnnualIncome: number;
  incomeTaxMonthly: number;
  eobiEmployeeContribution: number;
  eobiEmployerContribution: number;
  socialSecurityEmployerContribution: number;
  netPay: number;
  calculationBreakdown: PayrollCalculationStep[];
  createdAt: string;
  updatedAt: string;
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

export type OnboardingItemTemplateView = {
  id: string;
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder: number;
  isActive: boolean;
};

export type CreateOnboardingItemTemplateRequest = {
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
  sortOrder?: number;
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
};

export type InitiateOffboardingRequest = {
  reason: OffboardingReason;
  lastWorkingDay: string;
  notes?: string;
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

export type OvertimeClaimStatus = "pending" | "approved" | "rejected";

export type OvertimePolicyView = {
  id: string;
  companyId: string;
  dailyThresholdMinutes: number;
  roundingMinutes: number;
  weekdayRateMultiplier: number;
  restDayRateMultiplier: number;
  holidayRateMultiplier: number;
  effectiveFrom: string;
};

export type SetOvertimePolicyRequest = {
  dailyThresholdMinutes?: number;
  roundingMinutes?: number;
  weekdayRateMultiplier?: number;
  restDayRateMultiplier?: number;
  holidayRateMultiplier?: number;
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
};

export type SubmitOvertimeClaimRequest = {
  employeeId: string;
  workDate: string;
  reason?: string;
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

export type OnDutyRequestStatus = "pending" | "approved" | "rejected";

export type OnDutyRequestView = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  location: string | null;
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

export type OrgUnitVersionView = {
  id: string;
  orgUnitId: string;
  parentId: string | null;
  unitType: OrgUnitType;
  code: string | null;
  name: string;
  status: OrgUnitStatus;
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
export type PositionStatus = "vacant" | "filled" | "frozen" | "abolished";

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
 * any number at once, alongside a `direct` relationship or each other. */
export type OrgRelationshipType = "direct" | "dotted_line" | "matrix" | "temporary" | "acting";

export type OrgRelationshipStatus = "active" | "ended";

export type OrgRelationshipView = {
  id: string;
  companyId: string;
  /** The report. */
  employeeId: string;
  /** The manager (or dotted-line/matrix/temporary/acting counterpart). */
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

export type OrgChangeItemAction = "move" | "rename" | "retype" | "archive" | "activate";

export type OrgChangeItemView = {
  id: string;
  orgChangeId: string;
  sequence: number;
  orgUnitId: string;
  action: OrgChangeItemAction;
  newParentId: string | null;
  newName: string | null;
  newUnitType: string | null;
  appliedAt: string | null;
  createdAt: string;
};

export type OrgChangeImpactSummary = {
  affectedOrgUnitCount: number;
  affectedPositionCount: number;
  affectedEmployeeCount: number;
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
  orgUnitId: string;
  action: OrgChangeItemAction;
  newParentId?: string;
  newName?: string;
  newUnitType?: string;
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
};
