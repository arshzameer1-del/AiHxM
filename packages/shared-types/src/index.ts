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
// The nine modules from the prototype. Real per-tenant licensing tables
// (module_catalog / package_tier / tenant_module_entitlement) land in
// Phase 5; until then, CompanyConfig.enabledModules is just an array of
// these keys, set directly from the Platform Admin panel.
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
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type PackageTier = "starter" | "growth" | "professional" | "enterprise";

export type CompanyStatus = "trial" | "active" | "suspended" | "churned";

// --- Employee Number format (plan doc Section 5) -------------------------
export type EmployeeNumberFormat = {
  prefix: string;
  padding: number;
  startingSequence: number;
  preserveImportedNumbers: boolean;
};

export type CompanyBranding = {
  logoUrl?: string;
  primaryColor?: string;
};

export type Company = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  packageTier: PackageTier;
  createdAt: string;
  updatedAt: string;
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

export type ImpersonateResponse = {
  token: string;
  expiresIn: string;
  companyId: string;
  note: string;
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

export type SessionResult = {
  status: "ok";
  token: string;
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
};

/**
 * Platform Admin profile row (platform_admins table). Distinct from
 * CompanyAdmin — no companyId, and creation always bundles a login in one
 * step (see PlatformAdminsService) rather than a separate "add profile,
 * then create login" flow, since a Platform Admin with no login is never
 * a useful intermediate state the way a freshly-imported CompanyAdmin is.
 */
export type PlatformAdmin = {
  id: string;
  fullName: string;
  email: string;
  status: CompanyAdminStatus;
  createdAt: string;
};

export type CreatePlatformAdminRequest = {
  fullName: string;
  email: string;
  initialPassword: string;
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
