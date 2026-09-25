import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import * as jwt from "jsonwebtoken";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { normalizeEmail } from "../auth/email.util";
import { hashPassword } from "../auth/password";
import { SessionSecurityService } from "../auth/session-security.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type {
  Company,
  CompanyAdmin,
  CompanyAdminStatus,
  CompanyBranding,
  CompanyConfig,
  CompanyDashboardRow,
  CompanyDetail,
  CompanyListFilters,
  CompanyStatus,
  BrandingAssetSlot,
  CreateCompanyRequest,
  DeletionImpactPreview,
  DomainAvailabilityResult,
  EmployeeNumberFormat,
  ImpersonateResponse,
  ModuleKey,
  PackageTier,
} from "@aihxm/shared-types";

// Tenant Management gap-fill Phase 1 item #5 — a deletion request for a
// tenant with at least this many active employees needs a SECOND,
// different Platform Admin's approval before the grace-period purge
// clock starts (see requestDeletion/approveDeletion below). Deliberately
// a plain module constant, same convention as AuthService's
// MAX_FAILED_ATTEMPTS/LOCKOUT_MINUTES — not meant to be tenant-configurable,
// just a single easy-to-find place to change it.
const SECOND_APPROVAL_EMPLOYEE_THRESHOLD = 25;

/**
 * Deterministic placeholder only — see CompanyDashboardRow's doc comment
 * in shared-types. There is no billing system in Phase 2; this exists so
 * the Dashboard screen the plan doc describes ("all companies, MRR,
 * status") isn't blank. Replace with a real figure once billing exists.
 */
function mockMrrFor(companyId: string): number {
  const hash = createHash("sha1").update(companyId).digest();
  const base = hash.readUInt16BE(0); // 0..65535
  return 50_000 + (base % 450_000); // PKR 50,000–500,000 / month, stable per company
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isoOrNull(value: any): string | null {
  if (!value) return null;
  return value.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCompany(row: any): Company {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    packageTier: row.package_tier,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
    legalName: row.legal_name ?? null,
    companyCode: row.company_code ?? null,
    registrationNumber: row.registration_number ?? null,
    industry: row.industry ?? null,
    country: row.country,
    timezone: row.timezone,
    currency: row.currency,
    fiscalYearStartMonth: row.fiscal_year_start_month,
    customDomain: row.custom_domain ?? null,
    seatsPurchased: row.seats_purchased,
    storageQuotaMb: row.storage_quota_mb,
    statusReason: row.status_reason ?? null,
    statusChangedAt: isoOrNull(row.status_changed_at),
    deletionRequestedAt: isoOrNull(row.deletion_requested_at),
    deletionReason: row.deletion_reason ?? null,
    deletionPurgeAt: isoOrNull(row.deletion_purge_at),
    deletionApprovalRequired: row.deletion_approval_required ?? false,
    deletionGraceDays: row.deletion_grace_days ?? null,
    deletionApprovedBy: row.deletion_approved_by ?? null,
    deletionApprovedAt: isoOrNull(row.deletion_approved_at),
    // Only ever present when the query that produced `row` deliberately
    // joined for it (getDetail()'s own company query) — every other
    // caller reads back `undefined` here, which the `Company` type marks
    // optional for exactly that reason.
    deletionRequestedByEmail: row.deletion_requested_by_email ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToConfig(row: any): CompanyConfig {
  const branding = row.branding ?? {};
  return {
    companyId: row.company_id,
    branding: {
      primaryColor: branding.primaryColor ?? undefined,
      secondaryColor: branding.secondaryColor ?? undefined,
      hasLogo: Boolean(branding.logoStoragePath),
      hasFavicon: Boolean(branding.faviconStoragePath),
      hasLoginBackground: Boolean(branding.loginBackgroundStoragePath),
      logoAlignment: branding.logoAlignment ?? "left",
      logoHeightPx: branding.logoHeightPx ?? 32,
      logoBackgroundColor: branding.logoBackgroundColor ?? undefined,
      loginBackgroundPositionX: branding.loginBackgroundPositionX ?? "center",
      loginBackgroundPositionY: branding.loginBackgroundPositionY ?? "center",
      loginCardWidthPx: branding.loginCardWidthPx ?? 384,
      loginCardPosition: branding.loginCardPosition ?? "center",
      loginCardBackgroundColor: branding.loginCardBackgroundColor ?? "#FFFFFF",
      loginCardOpacity: branding.loginCardOpacity ?? 100,
    },
    enabledModules: row.enabled_modules ?? [],
    employeeNumberFormat: row.employee_number_format,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoOrNull(value: any): string | null {
  if (!value) return null;
  return value.toISOString ? value.toISOString() : value;
}

/**
 * Tenant Management gap-fill Phase 1 item #8's threshold: a login created
 * or reset more than this many days ago that has STILL never been used to
 * sign in is worth flagging as "expired" rather than merely "pending" — a
 * business-recency judgment call, distinct from RESET_TOKEN_TTL_MINUTES in
 * auth.service.ts (a short-lived cryptographic link expiry, not this).
 */
const LOGIN_PENDING_EXPIRY_DAYS = 7;

type AdminAccountInfo = {
  failedLoginAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  credentialIssuedAt: string | null;
  accountStatus: "active" | "locked" | null;
};

function computeLoginStatus(
  hasLogin: boolean,
  lastLoginAt: string | null,
  credentialIssuedAt: string | null,
  accountStatus: "active" | "locked" | null
): CompanyAdmin["loginStatus"] {
  if (!hasLogin) return "no_login";
  if (lastLoginAt) return "active";
  if (accountStatus === "locked") return "revoked";
  const issuedMs = credentialIssuedAt ? new Date(credentialIssuedAt).getTime() : Date.now();
  const ageDays = (Date.now() - issuedMs) / (1000 * 60 * 60 * 24);
  return ageDays > LOGIN_PENDING_EXPIRY_DAYS ? "expired" : "pending";
}

/**
 * `info` is only needed when `row` itself (a plain `company_admins` row,
 * from an INSERT/UPDATE ... RETURNING *) doesn't already carry the
 * `user_accounts` columns this needs — i.e. everywhere except `getDetail`'s
 * own LEFT JOIN query, which selects them directly onto the row (aliased
 * as `login_created_at`/`login_account_status` to avoid colliding with
 * company_admins' OWN `created_at`/`status` columns from `ca.*`). Every
 * call site that mutates `user_accounts` state itself (resetAdminPassword,
 * resetAdminMfa, unlockAdminAccount, revokeAdminLogin) already knows the
 * new values without a re-query and passes them here explicitly;
 * setAdminStatus doesn't touch any of this at all, so it re-reads the
 * current value via getAccountInfo() so its response doesn't silently
 * report stale lockout/login-lifecycle state.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAdmin(row: any, info?: Partial<AdminAccountInfo>): CompanyAdmin {
  const hasLogin = Boolean(row.user_account_id);
  const failedLoginAttempts = info?.failedLoginAttempts ?? row.failed_login_attempts ?? 0;
  const lockedUntil = info?.lockedUntil !== undefined ? info.lockedUntil : toIsoOrNull(row.locked_until);
  const lastLoginAt = info?.lastLoginAt !== undefined ? info.lastLoginAt : toIsoOrNull(row.last_login_at);
  const credentialIssuedAt =
    info?.credentialIssuedAt !== undefined ? info.credentialIssuedAt : toIsoOrNull(row.credential_issued_at);
  const accountStatus: "active" | "locked" | null =
    info?.accountStatus !== undefined ? info.accountStatus : row.login_account_status ?? null;

  return {
    id: row.id,
    companyId: row.company_id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    hasLogin,
    // Not a secret — a foreign key, not a credential — and TM-017's Force
    // Logout action needs it to target the right user's sessions from the
    // Tenant Users / Admins screen.
    userAccountId: row.user_account_id ?? null,
    loginId: row.login_id ?? null,
    failedLoginAttempts,
    lockedUntil,
    lastAccessReviewedAt: toIsoOrNull(row.last_access_reviewed_at),
    lastAccessReviewedBy: row.last_access_reviewed_by ?? null,
    lastLoginAt,
    loginStatus: computeLoginStatus(hasLogin, lastLoginAt, credentialIssuedAt, accountStatus),
  };
}

/**
 * A company's slug is now also a URL PATH SEGMENT in the frontend's own
 * router (aihxm.com/<slug>/login — see LoginPage.tsx/App.tsx, the
 * path-based replacement for the subdomain approach Netlify's plan
 * couldn't support), sitting in the exact same router as every other
 * top-level route. A company slug matching one of those literal routes
 * would make /login, /signup, /app, etc. themselves ambiguous — react-
 * router would have to guess whether "/login" means the reserved login
 * page or a company literally named "login". CreateCompanyDto's slug
 * format check (lowercase/hyphen only) doesn't catch this since "login"
 * is itself a perfectly valid slug shape; this is a distinct, explicit
 * blocklist checked before the normal uniqueness check.
 */
const RESERVED_SLUGS = new Set([
  "login",
  "signup",
  "app",
  "companies",
  "audit-log",
  "platform-admins",
  "platform-branding",
  "api",
  "www",
  "admin",
  "platform",
  "public",
  "assets",
  "static",
]);

@Injectable()
export class CompaniesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly sessionSecurity: SessionSecurityService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  /**
   * TM-008 — Domain step's "Check Availability" action. A plain read, no
   * reservation/hold semantics (this codebase has no draft-tenant
   * concept — see TM-012's own doc comment on why the wizard submits
   * everything transactionally in one `create()` call instead), so a
   * slug/domain can still be taken by someone else between this check
   * and the final submit; `create()`'s own uniqueness check is what
   * actually enforces it, this is only for fast UI feedback.
   */
  async checkAvailability(
    claims: RequestClaims,
    input: { slug: string; customDomain?: string }
  ): Promise<DomainAvailabilityResult> {
    return this.db.withClaims(claims, async (client) => {
      const slugResult = await client.query("SELECT 1 FROM companies WHERE slug = $1", [input.slug]);
      let customDomainAvailable: boolean | null = null;
      if (input.customDomain) {
        const domainResult = await client.query("SELECT 1 FROM companies WHERE custom_domain = $1", [
          input.customDomain,
        ]);
        customDomainAvailable = (domainResult.rowCount ?? 0) === 0;
      }
      return {
        slug: input.slug,
        // Reported the same as "already taken" — the wizard's UI doesn't
        // need a third state, and the real reason (reserved by the
        // frontend's own router, not a database row) doesn't change what
        // the admin needs to do: pick a different slug.
        slugAvailable: !RESERVED_SLUGS.has(input.slug) && (slugResult.rowCount ?? 0) === 0,
        customDomain: input.customDomain ?? null,
        customDomainAvailable,
      };
    });
  }

  async create(claims: RequestClaims, input: CreateCompanyRequest): Promise<CompanyDetail> {
    return this.db.withClaims(claims, async (client) => {
      if (RESERVED_SLUGS.has(input.slug)) {
        throw new ConflictException(`slug "${input.slug}" is reserved and can't be used for a company`);
      }
      const existing = await client.query("SELECT 1 FROM companies WHERE slug = $1", [input.slug]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`slug "${input.slug}" is already in use`);
      }
      if (input.customDomain) {
        const domainTaken = await client.query("SELECT 1 FROM companies WHERE custom_domain = $1", [
          input.customDomain,
        ]);
        if ((domainTaken.rowCount ?? 0) > 0) {
          throw new ConflictException(`domain "${input.customDomain}" is already in use`);
        }
      }

      const packageTier = input.packageTier ?? "starter";
      // TM-006/007/008: every wizard-collected profile/localization/domain
      // field is optional here, falling back to the same defaults
      // migration 0042 gives the columns themselves ('PK'/'Asia/Karachi'/
      // 'PKR'/July) when the caller (e.g. a minimal test fixture) omits
      // them — the same shape updateProfile() uses, so "create with full
      // wizard details" and "create minimal, fill in profile later" both
      // go through one INSERT/UPDATE pattern rather than two divergent
      // code paths.
      const companyResult = await client.query(
        `INSERT INTO companies (
           name, slug, package_tier, legal_name, company_code, registration_number, industry,
           country, timezone, currency, fiscal_year_start_month, custom_domain, seats_purchased
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          input.name,
          input.slug,
          packageTier,
          input.legalName ?? null,
          input.companyCode ?? null,
          input.registrationNumber ?? null,
          input.industry ?? null,
          input.country ?? "PK",
          input.timezone ?? "Asia/Karachi",
          input.currency ?? "PKR",
          input.fiscalYearStartMonth ?? 7,
          input.customDomain ?? null,
          input.seatsPurchased ?? 0,
        ]
      );
      const company = rowToCompany(companyResult.rows[0]);

      const employeeNumberFormat: EmployeeNumberFormat = {
        prefix: input.employeeNumberFormat?.prefix ?? "EMP",
        padding: input.employeeNumberFormat?.padding ?? 4,
        startingSequence: input.employeeNumberFormat?.startingSequence ?? 1,
        preserveImportedNumbers: input.employeeNumberFormat?.preserveImportedNumbers ?? true,
      };

      // Phase 5: seed real tenant_module_entitlement rows — the package
      // tier's defaults, unless the caller explicitly listed modules (this
      // request field predates Phase 5; it now backs real entitlement
      // rows instead of only the cached jsonb column below).
      const enabledModules = await this.entitlements.seedForNewCompany(
        client,
        company.id,
        packageTier,
        input.enabledModules
      );

      const configResult = await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, $2::jsonb, $3::jsonb) RETURNING *`,
        [company.id, JSON.stringify(enabledModules), JSON.stringify(employeeNumberFormat)]
      );
      const config = rowToConfig(configResult.rows[0]);

      let admins: CompanyAdmin[] = [];
      if (input.initialAdmin) {
        const adminResult = await client.query(
          `INSERT INTO company_admins (company_id, full_name, email) VALUES ($1, $2, $3) RETURNING *`,
          [company.id, input.initialAdmin.fullName, normalizeEmail(input.initialAdmin.email)]
        );
        admins = [rowToAdmin(adminResult.rows[0])];
      }

      await this.audit.record(client, claims, {
        companyId: company.id,
        action: "company.created",
        target: company.slug,
        metadata: { packageTier: company.packageTier, enabledModules },
      });

      return { company, config, admins };
    });
  }

  /**
   * TM-002/TM-003 (Tenant Directory search + filters). `search` matches
   * company/legal name, slug, custom domain, or any admin's email — the
   * spec's own wording ("Search by company, tenant ID, domain, admin
   * email"); "tenant ID" is this platform's `companies.id`/`slug`, there
   * being no separate tenant-id concept. Filters are OR-within-field,
   * AND-across-fields, matching the spec's "valid filter combinations"
   * note and how every other multi-select filter in this codebase behaves
   * (e.g. EmployeeListPage). All inputs are parameterized — never string-
   * interpolated into the query — despite `search` being free text.
   */
  async list(claims: RequestClaims, filters: CompanyListFilters = {}): Promise<CompanyDashboardRow[]> {
    return this.db.withClaims(claims, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters.search && filters.search.trim().length > 0) {
        params.push(`%${filters.search.trim()}%`);
        const p = `$${params.length}`;
        conditions.push(
          `(c.name ILIKE ${p} OR c.legal_name ILIKE ${p} OR c.slug ILIKE ${p} OR c.custom_domain ILIKE ${p} OR EXISTS (
             SELECT 1 FROM company_admins ca2 WHERE ca2.company_id = c.id AND ca2.email ILIKE ${p}
           ))`
        );
      }
      if (filters.status && filters.status.length > 0) {
        params.push(filters.status);
        conditions.push(`c.status = ANY($${params.length}::text[])`);
      }
      if (filters.packageTier && filters.packageTier.length > 0) {
        params.push(filters.packageTier);
        conditions.push(`c.package_tier = ANY($${params.length}::text[])`);
      }
      if (filters.country && filters.country.length > 0) {
        params.push(filters.country);
        conditions.push(`c.country = ANY($${params.length}::text[])`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await client.query(
        `SELECT c.*, COUNT(ca.id)::int AS admin_count
         FROM companies c
         LEFT JOIN company_admins ca ON ca.company_id = c.id
         ${where}
         GROUP BY c.id
         ORDER BY c.created_at DESC`,
        params
      );
      return result.rows.map((row) => ({
        ...rowToCompany(row),
        mockMrrUsd: mockMrrFor(row.id),
        adminCount: row.admin_count,
      }));
    });
  }

  async getDetail(claims: RequestClaims, companyId: string): Promise<CompanyDetail> {
    return this.db.withClaims(claims, async (client) => {
      // Phase 1 item #5 — resolves deletion_requested_by (a user_accounts
      // id stored as plain text, same as claims.sub) to that admin's
      // email, purely so the Danger Zone can tell a DIFFERENT Platform
      // Admin who asked and hide the Approve action from the requester
      // themselves. The cast is safe against non-UUID values (test
      // fixture subs, or no request at all) — it just joins to nothing.
      const companyResult = await client.query(
        `SELECT c.*, ua.email AS deletion_requested_by_email
         FROM companies c
         LEFT JOIN user_accounts ua ON ua.id::text = c.deletion_requested_by
         WHERE c.id = $1`,
        [companyId]
      );
      if (companyResult.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const configResult = await client.query(
        "SELECT * FROM company_config WHERE company_id = $1",
        [companyId]
      );
      // LEFT JOIN user_accounts for failed_login_attempts/locked_until
      // (Phase 1 item #3) and last_login_at/login_created_at/
      // login_account_status (Phase 1 item #8) — the latter two are
      // ALIASED because company_admins already has its own, DIFFERENT
      // `created_at`/`status` columns picked up by `ca.*`; an admin with no
      // login yet naturally comes back NULL on all of these (rowToAdmin's
      // defaults handle that).
      const adminsResult = await client.query(
        `SELECT ca.*, ua.failed_login_attempts, ua.locked_until, ua.last_login_at,
                ua.credential_issued_at, ua.status AS login_account_status
         FROM company_admins ca
         LEFT JOIN user_accounts ua ON ua.id = ca.user_account_id
         WHERE ca.company_id = $1
         ORDER BY ca.created_at ASC`,
        [companyId]
      );

      const config = rowToConfig(configResult.rows[0]);
      // enabled_modules on company_config is a cache (0006's header
      // comment) — tenant_module_entitlement is the real licensing source
      // of truth EntitlementsService.isModuleEnabled() gates on, so always
      // answer from there, never from the cache alone.
      config.enabledModules = await this.entitlements.getEnabledModuleKeys(client, companyId);

      return {
        company: rowToCompany(companyResult.rows[0]),
        config,
        admins: adminsResult.rows.map((row) => rowToAdmin(row)),
      };
    });
  }

  /**
   * TM-005 (Suspend) and TM-030 (Tenant Lock) both route through here — a
   * `reason` is REQUIRED for either transition (spec: "Reason required" /
   * "Reason + confirmation + elevated permission"), and the cache
   * `SessionSecurityService.companyAccessStatus()` reads is invalidated in
   * the same call so an already-logged-in session is blocked on its very
   * next request, not after up to 15 seconds. Without that invalidation
   * this whole feature would "work" in the database while looking broken
   * to whoever just got locked out and is still refreshing the page.
   */
  async updateCompany(
    claims: RequestClaims,
    companyId: string,
    patch: { status?: CompanyStatus; packageTier?: PackageTier; reason?: string }
  ): Promise<Company> {
    if (patch.status && (patch.status === "suspended" || patch.status === "locked") && !patch.reason?.trim()) {
      throw new BadRequestException(`A reason is required to set a company's status to "${patch.status}".`);
    }

    const company = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE companies SET
           status = COALESCE($2, status),
           package_tier = COALESCE($3, package_tier),
           status_reason = CASE WHEN $2::text IS NOT NULL THEN $4 ELSE status_reason END,
           status_changed_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE status_changed_at END,
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, patch.status ?? null, patch.packageTier ?? null, patch.reason ?? null]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: patch.status ? `company.status.${patch.status}` : "company.updated",
        target: companyId,
        metadata: patch,
      });

      return rowToCompany(result.rows[0]);
    });

    if (patch.status) {
      await this.sessionSecurity.invalidateCompanyStatusCache(companyId);
    }
    return company;
  }

  /**
   * TM-014 — Tenant Profile's "Company Information" section. Every field
   * here already existed on `companies` (migration 0042) and was
   * readable via `rowToCompany`; this is the write path the frontend
   * profile form was missing. "Audit old/new values" (spec's own
   * Validation/Rules) is why this reads the row BEFORE updating it,
   * rather than only logging the new values `updateCompany` above does —
   * a profile edit is lower-risk than a status change but still worth a
   * real diff in the audit trail.
   */
  async updateProfile(
    claims: RequestClaims,
    companyId: string,
    patch: {
      legalName?: string | null;
      companyCode?: string | null;
      registrationNumber?: string | null;
      industry?: string | null;
      country?: string;
      timezone?: string;
      currency?: string;
      fiscalYearStartMonth?: number;
      customDomain?: string | null;
    }
  ): Promise<Company> {
    return this.db.withClaims(claims, async (client) => {
      const before = await client.query("SELECT * FROM companies WHERE id = $1", [companyId]);
      if (before.rowCount === 0) throw new NotFoundException("Company not found");
      const previous = rowToCompany(before.rows[0]);

      let result;
      try {
        result = await client.query(
          `UPDATE companies SET
             legal_name = COALESCE($2, legal_name),
             company_code = COALESCE($3, company_code),
             registration_number = COALESCE($4, registration_number),
             industry = COALESCE($5, industry),
             country = COALESCE($6, country),
             timezone = COALESCE($7, timezone),
             currency = COALESCE($8, currency),
             fiscal_year_start_month = COALESCE($9, fiscal_year_start_month),
             custom_domain = COALESCE($10, custom_domain),
             updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [
            companyId,
            patch.legalName ?? null,
            patch.companyCode ?? null,
            patch.registrationNumber ?? null,
            patch.industry ?? null,
            patch.country ?? null,
            patch.timezone ?? null,
            patch.currency ?? null,
            patch.fiscalYearStartMonth ?? null,
            patch.customDomain ?? null,
          ]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException("That company code or custom domain is already in use.");
        }
        throw err;
      }

      const company = rowToCompany(result.rows[0]);

      const changedFields = Object.keys(patch).filter(
        (key) => (previous as unknown as Record<string, unknown>)[key] !== (company as unknown as Record<string, unknown>)[key]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.profile.updated",
        target: companyId,
        metadata: {
          changedFields,
          before: Object.fromEntries(changedFields.map((k) => [k, (previous as unknown as Record<string, unknown>)[k]])),
          after: Object.fromEntries(changedFields.map((k) => [k, (company as unknown as Record<string, unknown>)[k]])),
        },
      });

      return company;
    });
  }

  /**
   * Tenant Management gap-fill Phase 1 item #5 — shown before a Platform
   * Admin ever submits a deletion request, so "what will this actually
   * affect" isn't a guess made after the fact. Every figure here is a
   * real query against this tenant's own rows, same posture as
   * `UsageService.getSummary()` (its `employeeCount`/`storageUsedMb`
   * queries are deliberately mirrored here rather than imported —
   * `CompaniesModule` doesn't otherwise depend on the tenant-management
   * module, and these two queries are cheap enough that duplicating them
   * beats introducing that coupling for a read this small).
   * `requiresSecondApproval` mirrors exactly what `requestDeletion()`
   * below will decide, so the preview and the real gate can never
   * disagree.
   */
  async getDeletionImpact(claims: RequestClaims, companyId: string): Promise<DeletionImpactPreview> {
    return this.db.withClaims(claims, async (client) => {
      const companyResult = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyResult.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const employeeCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'",
        [companyId]
      );
      const adminCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM company_admins WHERE company_id = $1",
        [companyId]
      );
      const activeIntegrationsCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM tenant_integrations WHERE company_id = $1 AND enabled = true",
        [companyId]
      );
      const storageRow = await client.query(
        "SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM employee_documents WHERE company_id = $1",
        [companyId]
      );
      const storageUsedMb = Number(storageRow.rows[0].bytes) / (1024 * 1024);

      const employees = employeeCount.rows[0].n as number;
      return {
        companyId,
        employeeCount: employees,
        adminCount: adminCount.rows[0].n,
        activeIntegrationsCount: activeIntegrationsCount.rows[0].n,
        storageUsedMb: Math.round(storageUsedMb * 100) / 100,
        requiresSecondApproval: employees >= SECOND_APPROVAL_EMPLOYEE_THRESHOLD,
        secondApprovalThresholdEmployees: SECOND_APPROVAL_EMPLOYEE_THRESHOLD,
      };
    });
  }

  /**
   * TM-038 Danger Zone: request deletion with a grace period rather than
   * ever hard-deleting on a single API call — "Never immediate hard
   * delete" per the spec's own guidance. `TenantLifecycleSweep` (a new
   * cron job, see tenant-lifecycle.sweep.ts) is what actually archives a
   * company once `deletion_purge_at` passes; this only starts the clock
   * and immediately blocks access the same way Lock/Suspend do (a company
   * pending deletion has no business staying reachable in the meantime).
   *
   * Phase 1 item #5 — above `SECOND_APPROVAL_EMPLOYEE_THRESHOLD` active
   * employees, the lock still happens immediately (unchanged), but
   * `deletion_purge_at` is deliberately left NULL: the grace-period clock
   * doesn't start until a DIFFERENT Platform Admin calls
   * `approveDeletion()` below. `graceDays` is stashed in
   * `deletion_grace_days` so approving doesn't need to ask for it again.
   */
  async requestDeletion(
    claims: RequestClaims,
    companyId: string,
    input: { reason: string; graceDays?: number }
  ): Promise<Company> {
    if (!input.reason?.trim()) {
      throw new BadRequestException("A reason is required to request deletion of a company.");
    }
    const graceDays = input.graceDays ?? 14;

    const impact = await this.getDeletionImpact(claims, companyId);
    const requiresSecondApproval = impact.requiresSecondApproval;

    const company = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE companies SET
           status = 'locked',
           status_reason = $2,
           status_changed_at = now(),
           deletion_requested_at = now(),
           deletion_reason = $2,
           deletion_purge_at = CASE WHEN $5 THEN NULL ELSE now() + ($3::text || ' days')::interval END,
           deletion_requested_by = $4,
           deletion_approval_required = $5,
           deletion_grace_days = $3::integer,
           deletion_approved_by = NULL,
           deletion_approved_at = NULL,
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, input.reason, graceDays, claims.sub, requiresSecondApproval]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "company.deletion_requested",
        target: companyId,
        metadata: {
          reason: input.reason,
          graceDays,
          requiresSecondApproval,
          employeeCount: impact.employeeCount,
        },
      });

      return rowToCompany(result.rows[0]);
    });

    await this.sessionSecurity.invalidateCompanyStatusCache(companyId);
    return company;
  }

  /**
   * Phase 1 item #5's second half — the ONLY way `deletion_purge_at` ever
   * gets set for a request `requestDeletion()` flagged as needing a
   * second approval. Self-approval is rejected outright: the whole point
   * is a second, independent pair of eyes, so the admin who filed the
   * request (`deletion_requested_by`) can't also be the one who clears it.
   */
  async approveDeletion(claims: RequestClaims, companyId: string): Promise<Company> {
    const company = await this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        `SELECT deletion_requested_at, deletion_requested_by, deletion_approval_required,
                deletion_approved_at, deletion_grace_days
         FROM companies WHERE id = $1`,
        [companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const row = existing.rows[0];
      if (!row.deletion_requested_at) {
        throw new BadRequestException("This tenant has no pending deletion request.");
      }
      if (!row.deletion_approval_required) {
        throw new BadRequestException("This deletion request does not require a second approval.");
      }
      if (row.deletion_approved_at) {
        throw new BadRequestException("This deletion request has already been approved.");
      }
      if (row.deletion_requested_by === claims.sub) {
        throw new ForbiddenException(
          "A different Platform Admin must approve this deletion request — the admin who requested it can't also approve it."
        );
      }

      const result = await client.query(
        `UPDATE companies SET
           deletion_purge_at = now() + (deletion_grace_days || ' days')::interval,
           deletion_approved_by = $2,
           deletion_approved_at = now(),
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.deletion_approved",
        target: companyId,
        metadata: { requestedBy: row.deletion_requested_by },
      });

      return rowToCompany(result.rows[0]);
    });

    return company;
  }

  /** Cancels a pending deletion request — restores to `active`, same as any other reactivation. */
  async cancelDeletion(claims: RequestClaims, companyId: string): Promise<Company> {
    const company = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE companies SET
           status = 'active',
           status_reason = 'Deletion request cancelled',
           status_changed_at = now(),
           deletion_requested_at = NULL,
           deletion_reason = NULL,
           deletion_purge_at = NULL,
           deletion_requested_by = NULL,
           deletion_approval_required = false,
           deletion_grace_days = NULL,
           deletion_approved_by = NULL,
           deletion_approved_at = NULL,
           updated_at = now()
         WHERE id = $1 AND deletion_requested_at IS NOT NULL
         RETURNING *`,
        [companyId]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Company not found, or has no pending deletion request");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "company.deletion_cancelled",
        target: companyId,
        metadata: {},
      });

      return rowToCompany(result.rows[0]);
    });

    await this.sessionSecurity.invalidateCompanyStatusCache(companyId);
    return company;
  }

  /** TM-021 — Module catalog with dependency + enabled status. */
  async listModules(claims: RequestClaims, companyId: string) {
    return this.entitlements.listCatalogForCompany(claims, companyId);
  }

  async updateConfig(
    claims: RequestClaims,
    companyId: string,
    patch: {
      branding?: {
        primaryColor?: string;
        secondaryColor?: string;
        logoAlignment?: CompanyBranding["logoAlignment"];
        logoHeightPx?: number;
        logoBackgroundColor?: string;
        loginBackgroundPositionX?: CompanyBranding["loginBackgroundPositionX"];
        loginBackgroundPositionY?: CompanyBranding["loginBackgroundPositionY"];
        loginCardWidthPx?: number;
        loginCardPosition?: CompanyBranding["loginCardPosition"];
        loginCardBackgroundColor?: string;
        loginCardOpacity?: number;
      };
      enabledModules?: ModuleKey[];
      employeeNumberFormat?: Partial<EmployeeNumberFormat>;
    }
  ): Promise<CompanyConfig> {
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query(
        "SELECT * FROM company_config WHERE company_id = $1",
        [companyId]
      );
      if (current.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const existing = rowToConfig(current.rows[0]);
      // Merge against the RAW branding jsonb (which also holds the
      // internal `*StoragePath` keys set by uploadBrandingAsset), never
      // against `existing.branding` — that's the derived hasLogo/
      // hasFavicon view rowToConfig() computes for the API response, and
      // writing THAT back would silently discard the actual storage
      // paths of any previously-uploaded logo/favicon/login background.
      const rawBranding = current.rows[0].branding ?? {};
      const nextBranding = { ...rawBranding, ...(patch.branding ?? {}) };
      const nextFormat: EmployeeNumberFormat = {
        ...existing.employeeNumberFormat,
        ...(patch.employeeNumberFormat ?? {}),
      };

      // Phase 5: a module toggle here writes real tenant_module_entitlement
      // rows — the actual gate EntitlementsService.isModuleEnabled() reads
      // — not just this cached jsonb column. If the caller didn't touch
      // modules this request, re-read the canonical set anyway rather than
      // trust a possibly-stale cache.
      const nextModules = patch.enabledModules
        ? await this.entitlements.setEnabledModules(client, companyId, patch.enabledModules)
        : await this.entitlements.getEnabledModuleKeys(client, companyId);

      const result = await client.query(
        `UPDATE company_config SET
           branding = $2::jsonb,
           enabled_modules = $3::jsonb,
           employee_number_format = $4::jsonb,
           updated_at = now()
         WHERE company_id = $1
         RETURNING *`,
        [companyId, JSON.stringify(nextBranding), JSON.stringify(nextModules), JSON.stringify(nextFormat)]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.config.updated",
        target: companyId,
        metadata: patch,
      });

      return rowToConfig(result.rows[0]);
    });
  }

  private static readonly BRANDING_STORAGE_KEY: Record<BrandingAssetSlot, string> = {
    logo: "logoStoragePath",
    favicon: "faviconStoragePath",
    "login-background": "loginBackgroundStoragePath",
  };
  private static readonly BRANDING_MIME_KEY: Record<BrandingAssetSlot, string> = {
    logo: "logoMimeType",
    favicon: "faviconMimeType",
    "login-background": "loginBackgroundMimeType",
  };

  /**
   * TM-015 — real file uploads for branding, same FileStorageService
   * every other document upload in this codebase goes through (employee
   * document vault, tenant backups/exports) — never a raw pasted-in URL,
   * which is why `BrandingInputDto` no longer has a `logoUrl` field.
   */
  async uploadBrandingAsset(
    claims: RequestClaims,
    companyId: string,
    slot: BrandingAssetSlot,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number }
  ): Promise<CompanyConfig> {
    const MAX_BRANDING_ASSET_BYTES = 5 * 1024 * 1024;
    if (file.size > MAX_BRANDING_ASSET_BYTES) {
      throw new BadRequestException(`File exceeds the ${MAX_BRANDING_ASSET_BYTES / (1024 * 1024)}MB limit`);
    }
    if (!file.mimetype.startsWith("image/")) {
      throw new BadRequestException("Branding assets must be an image file");
    }

    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM company_config WHERE company_id = $1", [companyId]);
      if (current.rowCount === 0) throw new NotFoundException("Company not found");

      const stored = await this.fileStorage.save(companyId, "branding", `${slot}-${file.originalname}`, file.buffer);
      const rawBranding = current.rows[0].branding ?? {};
      const nextBranding = {
        ...rawBranding,
        [CompaniesService.BRANDING_STORAGE_KEY[slot]]: stored.storagePath,
        [CompaniesService.BRANDING_MIME_KEY[slot]]: file.mimetype,
      };

      const result = await client.query(
        `UPDATE company_config SET branding = $2::jsonb, updated_at = now() WHERE company_id = $1 RETURNING *`,
        [companyId, JSON.stringify(nextBranding)]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.branding.updated",
        target: slot,
        metadata: { slot, sizeBytes: stored.sizeBytes },
      });

      return rowToConfig(result.rows[0]);
    });
  }

  async downloadBrandingAsset(
    claims: RequestClaims,
    companyId: string,
    slot: BrandingAssetSlot
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT branding FROM company_config WHERE company_id = $1", [companyId]);
      if (current.rowCount === 0) throw new NotFoundException("Company not found");
      const branding = current.rows[0].branding ?? {};
      const storagePath = branding[CompaniesService.BRANDING_STORAGE_KEY[slot]];
      if (!storagePath) throw new NotFoundException(`No ${slot} has been uploaded for this tenant`);
      const mimeType = branding[CompaniesService.BRANDING_MIME_KEY[slot]] ?? "application/octet-stream";
      const buffer = await this.fileStorage.read(storagePath);
      return { buffer, mimeType };
    });
  }

  async addAdmin(
    claims: RequestClaims,
    companyId: string,
    input: { fullName: string; email: string }
  ): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const companyExists = await client.query("SELECT 1 FROM companies WHERE id = $1", [companyId]);
      if (companyExists.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const email = normalizeEmail(input.email);
      const existingAdmin = await client.query(
        "SELECT 1 FROM company_admins WHERE company_id = $1 AND email = $2",
        [companyId, email]
      );
      if ((existingAdmin.rowCount ?? 0) > 0) {
        throw new ConflictException(`${input.email} is already an admin on this company`);
      }

      const result = await client.query(
        `INSERT INTO company_admins (company_id, full_name, email) VALUES ($1, $2, $3) RETURNING *`,
        [companyId, input.fullName, email]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.created",
        target: input.email,
        metadata: {},
      });

      return rowToAdmin(result.rows[0]);
    });
  }

  async setAdminStatus(
    claims: RequestClaims,
    companyId: string,
    adminId: string,
    status: CompanyAdminStatus
  ): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE company_admins SET status = $3 WHERE id = $2 AND company_id = $1 RETURNING *`,
        [companyId, adminId, status]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Admin not found");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: status === "locked" ? "company.admin.locked" : "company.admin.unlocked",
        target: result.rows[0].email,
        metadata: {},
      });

      // Doesn't touch user_accounts at all (this is the manual admin-level
      // status field, a different concept from the automatic
      // failed-login lockout below) — re-read so the response doesn't
      // silently report "not locked" for an admin who actually still is.
      const accountInfo = await this.getAccountInfo(client, result.rows[0].user_account_id);
      return rowToAdmin(result.rows[0], accountInfo);
    });
  }

  /**
   * Tenant Management gap-fill batch 1, Phase 1 item #3's shared read —
   * every mutation below that doesn't itself already know the resulting
   * lockout/login-lifecycle state re-reads it here so its response stays
   * accurate. Null userAccountId (no login yet) trivially means "not
   * locked, no login." Broadened by Phase 1 item #8 to also carry
   * `lastLoginAt`/`loginCreatedAt`/`accountStatus` — the login-lifecycle
   * fields `rowToAdmin`'s `computeLoginStatus` needs — since they come from
   * the exact same `user_accounts` row this was already reading; hence the
   * rename from the original getLockoutInfo.
   */
  private async getAccountInfo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    userAccountId: string | null
  ): Promise<AdminAccountInfo> {
    if (!userAccountId) {
      return {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        credentialIssuedAt: null,
        accountStatus: null,
      };
    }
    const result = await client.query(
      "SELECT failed_login_attempts, locked_until, last_login_at, credential_issued_at, status FROM user_accounts WHERE id = $1",
      [userAccountId]
    );
    const row = result.rows[0];
    return {
      failedLoginAttempts: row?.failed_login_attempts ?? 0,
      lockedUntil: toIsoOrNull(row?.locked_until),
      lastLoginAt: toIsoOrNull(row?.last_login_at),
      credentialIssuedAt: toIsoOrNull(row?.credential_issued_at),
      accountStatus: row?.status ?? null,
    };
  }

  /**
   * Gives an existing Company Super Admin their first real login (Phase
   * 3). Runs entirely under the calling Platform Admin's own claims — the
   * INSERT into user_accounts, the UPDATE linking it, and the audit entry
   * all commit in one transaction, the same pattern as every other admin
   * mutation in this service.
   *
   * Also grants BOTH `hr_admin` AND `system_admin` in the same transaction
   * — a real gap found during the Supabase/Render test-deploy pass, fixed
   * in two stages:
   *
   * Stage 1 granted `hr_admin` alone, matching the public self-signup path
   * (`SignupService.signup()`). That closed "no role assigned, nothing
   * works" but left a narrower gap: `hr_admin` (0011_employee_seed.sql) is
   * deliberately scoped to employee HR data only — it holds no
   * `workflow_template.manage.all`/`role_assignment.manage.all`/
   * `user_account.manage.all` permissions. `system_admin`
   * (0024_system_admin.sql) is the complementary role that holds exactly
   * those: configuring approval workflows and managing OTHER users'
   * logins/roles within the tenant. This admin is the company's Company
   * Super Admin — the person Platform Admin hands the tenant off to — and
   * without `system_admin` too, they could manage employee records but
   * couldn't invite a colleague, assign that colleague a role, or touch a
   * workflow, i.e. they were not actually "the admin" of their own tenant.
   * Granting both keeps the two roles themselves separate and additive
   * (no hardcoded "admin = full access" special case — see
   * AIHXM-Foundational-Administration-Architecture.md's non-negotiable
   * rule #2); this bootstrap login is simply the one case where both are
   * warranted at once; a Company Super Admin can still un-assign either
   * from any OTHER user's login the ordinary way.
   *
   * There is no self-service way for a stuck admin to fix this
   * afterward (a tenant's own "Roles & Access" screen only manages
   * `employees`, not `company_admins`, and there is no frontend for
   * Platform Admin's own `POST /platform/role-assignments`). A login
   * with no role is not a "less-provisioned" admin, it's a completely
   * unusable one — this makes "create a login" always mean "give them a
   * working account," matching what an admin creating this account would
   * actually expect. Accounts created before this fix shipped need
   * `npm run grant-role` once per missing role (see `grant-role.ts`)
   * since this method refuses to run twice for the same admin (the
   * "already has a login" check above).
   *
   * `loginId` (migration 0048) is what lets this admin actually sign in
   * through their own company's tenant-path login
   * (aihxm.com/<slug>/login) — without it they still get a working
   * account, just one only reachable via the shared, email-based /login.
   * Optional and settable only here (once), since it's meant to be a
   * short-lived hand-off value a Platform Admin picks and tells the admin
   * directly, the same moment as the initial password.
   */
  async createAdminLogin(
    claims: RequestClaims,
    companyId: string,
    adminId: string,
    initialPassword: string,
    loginId?: string
  ): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM company_admins WHERE id = $1 AND company_id = $2",
        [adminId, companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Admin not found for this company");
      }
      if (existing.rows[0].user_account_id) {
        throw new ConflictException("This admin already has a login");
      }

      // normalizeEmail() here is defense in depth: migration
      // 0044_normalize_emails.sql backfills company_admins.email to
      // lowercase, but this covers any row written between that backfill
      // and this deploy, or a source that bypasses addAdmin() entirely.
      const passwordHash = await hashPassword(initialPassword);
      let userAccountId: string;
      try {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
          [normalizeEmail(existing.rows[0].email), passwordHash]
        );
        userAccountId = account.rows[0].id as string;
      } catch (err) {
        // user_accounts.email is globally UNIQUE (Section 5) — this admin's
        // email is already attached to a login somewhere else (another
        // company's admin or employee, or this same admin re-added under a
        // second company). Same friendly-409 posture as
        // EmployeesService.createLogin()'s own email collision, which this
        // path had been missing until now (it only guarded the login_id
        // update below, not this insert).
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(
            `A login already exists for ${existing.rows[0].email} — it may belong to another company or employee record.`
          );
        }
        throw err;
      }

      const normalizedLoginId = loginId?.trim() || null;
      let updated;
      try {
        updated = await client.query(
          "UPDATE company_admins SET user_account_id = $1, login_id = $2 WHERE id = $3 RETURNING *",
          [userAccountId, normalizedLoginId, adminId]
        );
      } catch (err) {
        // company_admins_company_id_login_id_ci_key (migration 0048) — a
        // friendly 409 instead of a raw constraint-violation 500, same
        // posture as EmployeesService.createLogin()'s own email collision.
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`Login ID "${normalizedLoginId}" is already used by another admin on this company`);
        }
        throw err;
      }

      const bootstrapRoles = await client.query<{ key: string; id: string }>(
        "SELECT key, id FROM roles WHERE key IN ('hr_admin', 'system_admin')"
      );
      if (bootstrapRoles.rowCount !== 2) {
        // Fails loudly rather than silently granting a partial set — a
        // migration ordering problem should surface immediately, not as
        // a mysteriously under-provisioned admin discovered later.
        throw new Error(
          `Expected roles 'hr_admin' and 'system_admin' to both exist; found: ${bootstrapRoles.rows.map((r) => r.key).join(", ") || "none"}`
        );
      }
      for (const role of bootstrapRoles.rows) {
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.id]
        );
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.login_created",
        target: existing.rows[0].email,
        metadata: { rolesGranted: ["hr_admin", "system_admin"], loginId: normalizedLoginId },
      });

      // Just created this login (INSERT above) — known values, no re-query
      // needed. Freshly created always means "pending": never signed in
      // yet, active status, credential just issued (matches the column's
      // own DEFAULT now()).
      return rowToAdmin(updated.rows[0], {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        credentialIssuedAt: new Date().toISOString(),
        accountStatus: "active",
      });
    });
  }

  /**
   * The other half of "Create login" (above): a Platform Admin picks a new
   * password for an admin who already has a login but forgot it — the
   * account-recovery gap that surfaced once real Company Admin logins
   * existed with no self-service reset path that reaches a Platform Admin
   * (the tenant-scoped `/auth/password-reset/*` flow needs a working
   * inbox and SMTP configured, neither of which every pilot company has
   * yet). Overwriting `password_hash` directly (never reading the old one
   * back) and clearing `failed_login_attempts`/`locked_until` mirrors
   * AuthService.confirmPasswordReset()'s own self-service path exactly —
   * this is the same operation with a Platform Admin's authority standing
   * in for the emailed token.
   */
  async resetAdminPassword(
    claims: RequestClaims,
    companyId: string,
    adminId: string,
    newPassword: string
  ): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM company_admins WHERE id = $1 AND company_id = $2",
        [adminId, companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Admin not found for this company");
      }
      const userAccountId = existing.rows[0].user_account_id as string | null;
      if (!userAccountId) {
        throw new BadRequestException("This admin has no login yet — use Create login instead");
      }

      const passwordHash = await hashPassword(newPassword);
      await client.query(
        `UPDATE user_accounts SET
           password_hash = $2,
           failed_login_attempts = 0,
           locked_until = NULL,
           -- Tenant Management gap-fill Phase 1 item #8 — a freshly
           -- reissued credential hasn't been used yet, even if an earlier
           -- one was (so the Admins tab shows "pending" again, not stale
           -- "active"), and this is also the "Resend" action for a
           -- previously-revoked pending login, so it un-revokes too.
           last_login_at = NULL,
           credential_issued_at = now(),
           status = 'active',
           updated_at = now()
         WHERE id = $1`,
        [userAccountId, passwordHash]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.password_reset",
        target: existing.rows[0].email,
        metadata: {},
      });

      // Already know the result — just set all of these fields above.
      return rowToAdmin(existing.rows[0], {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        credentialIssuedAt: new Date().toISOString(),
        accountStatus: "active",
      });
    });
  }

  /**
   * Tenant Management gap-fill batch 1, Phase 1 item #2 — the counterpart
   * to resetAdminPassword() directly above, for when an admin is locked
   * out of MFA specifically (lost/wiped authenticator device, AND the
   * recovery codes from mfa-recovery-codes.util.ts are also gone or
   * exhausted) rather than locked out on password. Same shape as
   * resetAdminPassword(): find the admin, require an existing login,
   * mutate user_accounts under the Platform Admin's own claims, audit,
   * return the (unchanged) admin row.
   *
   * Clears `mfa_enabled`/`mfa_secret_encrypted` so the account's next
   * login goes through `authenticate()`'s `!account.mfa_enabled` branch
   * again (auth.service.ts) — i.e. forces a brand-new enrollment, exactly
   * like a first-ever login. Also deletes any outstanding
   * `mfa_recovery_codes` rows: the old codes were only ever valid for the
   * old (now-revoked) secret's enrollment, and leaving them live would let
   * a stale code sign in without ever proving the person re-enrolled.
   */
  async resetAdminMfa(claims: RequestClaims, companyId: string, adminId: string): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM company_admins WHERE id = $1 AND company_id = $2",
        [adminId, companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Admin not found for this company");
      }
      const userAccountId = existing.rows[0].user_account_id as string | null;
      if (!userAccountId) {
        throw new BadRequestException("This admin has no login yet — use Create login instead");
      }

      await client.query(
        `UPDATE user_accounts SET
           mfa_enabled = false,
           mfa_secret_encrypted = NULL,
           updated_at = now()
         WHERE id = $1`,
        [userAccountId]
      );
      await client.query("DELETE FROM mfa_recovery_codes WHERE user_account_id = $1", [userAccountId]);

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.mfa_reset",
        target: existing.rows[0].email,
        metadata: {},
      });

      // MFA reset doesn't touch the password-lockout or login-lifecycle
      // fields — re-read so the response doesn't silently report stale
      // state for an admin who's ALSO currently password-locked (or
      // pending/expired/revoked).
      const accountInfo = await this.getAccountInfo(client, userAccountId);
      return rowToAdmin(existing.rows[0], accountInfo);
    });
  }

  /**
   * Tenant Management gap-fill batch 1, Phase 1 item #3 — the much more
   * common counterpart to resetAdminPassword/resetAdminMfa above: an admin
   * who mistyped their password a few too many times
   * (`AuthService.MAX_FAILED_ATTEMPTS = 5`) and just needs a fresh start,
   * not a credential reset. Clears ONLY the lockout counters, leaving the
   * password and MFA enrollment untouched — same fields
   * `AuthService.resetFailedAttempts()` clears on a genuinely successful
   * login, just triggered by a Platform Admin instead of waiting out
   * `LOCKOUT_MINUTES` or resetting the password as a workaround.
   */
  async unlockAdminAccount(claims: RequestClaims, companyId: string, adminId: string): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM company_admins WHERE id = $1 AND company_id = $2",
        [adminId, companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Admin not found for this company");
      }
      const userAccountId = existing.rows[0].user_account_id as string | null;
      if (!userAccountId) {
        throw new BadRequestException("This admin has no login yet — use Create login instead");
      }

      await client.query(
        "UPDATE user_accounts SET failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
        [userAccountId]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.lockout_cleared",
        target: existing.rows[0].email,
        metadata: {},
      });

      // Only the two lockout counters were touched above — last_login_at/
      // credential_issued_at/status are untouched, so re-read rather than
      // assume, the same reasoning as resetAdminMfa just above.
      const accountInfo = await this.getAccountInfo(client, userAccountId);
      return rowToAdmin(existing.rows[0], accountInfo);
    });
  }

  /**
   * Tenant Management gap-fill Phase 1 item #8 — the "Revoke" half of
   * login/invitation lifecycle visibility. Rescinds a login BEFORE it's
   * ever been used — the credential handed over turns out to be wrong, or
   * shouldn't have been issued at all. Deliberately refuses once the admin
   * has actually signed in even once: at that point it's an established
   * login, and the existing Lock/Unlock action (setAdminStatus, a
   * different field — company_admins.status, not user_accounts.status) is
   * the right tool, not this one. Reuses `user_accounts.status = 'locked'`
   * — the exact same column/value AuthService.authenticate() already
   * checks and blocks on — rather than inventing a new blocking mechanism;
   * resetAdminPassword() ("Resend") is what un-revokes it again.
   */
  async revokeAdminLogin(claims: RequestClaims, companyId: string, adminId: string): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM company_admins WHERE id = $1 AND company_id = $2",
        [adminId, companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Admin not found for this company");
      }
      const userAccountId = existing.rows[0].user_account_id as string | null;
      if (!userAccountId) {
        throw new BadRequestException("This admin has no login to revoke yet.");
      }

      const before = await this.getAccountInfo(client, userAccountId);
      if (before.lastLoginAt) {
        throw new BadRequestException(
          "This admin has already signed in — use Lock instead of Revoke for an established login."
        );
      }

      await client.query("UPDATE user_accounts SET status = 'locked', updated_at = now() WHERE id = $1", [
        userAccountId,
      ]);

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.login_revoked",
        target: existing.rows[0].email,
        metadata: {},
      });

      const accountInfo = await this.getAccountInfo(client, userAccountId);
      return rowToAdmin(existing.rows[0], accountInfo);
    });
  }

  /**
   * Tenant Management gap-fill Phase 1 item #7 — periodic access-review
   * attestation. Purely a record-keeping stamp: unlike Reset password/MFA
   * or Unlock, it doesn't touch the admin's access itself, so it works for
   * an admin with no login yet too (there's still an access GRANT to
   * attest to — the company_admins row — even before a login exists).
   */
  async markAdminAccessReviewed(claims: RequestClaims, companyId: string, adminId: string): Promise<CompanyAdmin> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        "SELECT * FROM company_admins WHERE id = $1 AND company_id = $2",
        [adminId, companyId]
      );
      if (existing.rowCount === 0) {
        throw new NotFoundException("Admin not found for this company");
      }

      const result = await client.query(
        `UPDATE company_admins
         SET last_access_reviewed_at = now(), last_access_reviewed_by = $3
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [adminId, companyId, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.access_reviewed",
        target: existing.rows[0].email,
        metadata: {},
      });

      const accountInfo = await this.getAccountInfo(client, existing.rows[0].user_account_id);
      return rowToAdmin(result.rows[0], accountInfo);
    });
  }

  /**
   * TM-038's grace-period purge, run on a cron sweep
   * (CompaniesLifecycleScheduler, companies.module.ts) — mirrors
   * WorkflowService.escalateOverdue()'s own shape (a plain, idempotent,
   * directly-testable sweep) rather than inventing a new job-scheduling
   * pattern. "Purge" here means archiving the company row, never a real
   * DROP/DELETE of its data — RLS-isolated tenant data for an archived
   * company simply becomes unreachable through the normal API (every
   * guard already treats `archived` the same as `locked`/`suspended`),
   * which is the same "never immediate hard delete" principle the spec
   * itself asks for, just carried one step further than "locked."
   */
  async purgeExpiredDeletions(claims: RequestClaims): Promise<number> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE companies SET
           status = 'archived',
           status_reason = 'Deletion grace period elapsed',
           status_changed_at = now(),
           updated_at = now()
         WHERE deletion_purge_at IS NOT NULL AND deletion_purge_at <= now() AND status != 'archived'
         RETURNING id`
      );
      for (const row of result.rows) {
        await this.audit.record(client, claims, {
          companyId: row.id,
          action: "company.archived",
          target: row.id,
          metadata: { reason: "deletion_grace_period_elapsed" },
        });
        await this.sessionSecurity.invalidateCompanyStatusCache(row.id);
      }
      return result.rowCount ?? 0;
    });
  }

  /**
   * "Login As" scoped impersonation (plan doc Section 3), hardened per
   * Tenant Management gap-fill Phase 1 item #4. The original version of
   * this method signed a synthetic, non-UUID `sub`
   * (`"${claims.sub}:login-as"`) that was never a real login identity —
   * it would crash the instant it touched any RLS policy using the
   * standard `NULLIF(app.jwt()->>'sub','')::uuid` cast (a plain `OR`
   * before that cast doesn't reliably short-circuit in Postgres), had no
   * `jti` so it could never be individually force-ended, and the
   * frontend never actually applied the returned token as a session —
   * between the three, the feature had never once been used as a real
   * "Login As", only as a proof that a JWT could be signed.
   *
   * This version resolves a REAL, already-active admin login for the
   * target company and issues a session shaped exactly like
   * `AuthService.issueSessionToken()`'s normal login tokens — same `sub`
   * shape, same real `user_sessions` row and `jti` — so it's a genuinely
   * usable, individually revocable session (via the existing
   * `POST /platform/sessions/:id/revoke`) rather than a special case
   * RLS or SessionGuard have to carve out. `reason` is required and
   * audited, matching every other high-risk Tenant Management action
   * (Suspend, Force Logout, deletion request).
   */
  async impersonate(claims: RequestClaims, companyId: string, reason: string): Promise<ImpersonateResponse> {
    return this.db.withClaims(claims, async (client) => {
      const companyResult = await client.query("SELECT id, name FROM companies WHERE id = $1", [companyId]);
      if (companyResult.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const company = companyResult.rows[0];

      // The impersonation session's real identity: the longest-standing
      // active admin login on this tenant. There's no "which admin"
      // picker in the UI (plan doc Section 3 doesn't call for one), and
      // any active admin's RLS-scoped view of their own company is
      // identical either way — the choice only matters for the audit
      // trail, where it's recorded below.
      const adminResult = await client.query(
        `SELECT user_account_id, email FROM company_admins
         WHERE company_id = $1 AND status = 'active' AND user_account_id IS NOT NULL
         ORDER BY created_at ASC
         LIMIT 1`,
        [companyId]
      );
      if (adminResult.rowCount === 0) {
        throw new BadRequestException(
          "This tenant has no active admin with a login yet — there's no session to impersonate."
        );
      }
      const { user_account_id: userAccountId, email: adminEmail } = adminResult.rows[0];

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error("JWT_SECRET is not set");
      }

      // Same shape as AuthService.issueSessionToken()'s real login
      // sessions — a real user_sessions row is what gives this a `jti`,
      // making it show up in the Security tab's session list and be
      // individually revocable via the existing "End session"/revoke
      // endpoint, instead of only ever expiring on its own after 30
      // minutes.
      const sessionResult = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO user_sessions (user_account_id, company_id, is_platform_admin, device_label, expires_at)
         VALUES ($1, $2, false, $3, now() + interval '30 minutes')
         RETURNING id, expires_at`,
        [userAccountId, companyId, "Platform Admin impersonation session"]
      );
      const sessionId = sessionResult.rows[0].id;
      const expiresAt = sessionResult.rows[0].expires_at.toISOString();

      const token = jwt.sign(
        { sub: userAccountId, is_platform_admin: false, company_id: companyId, jti: sessionId },
        secret,
        { expiresIn: "30m" }
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.impersonate",
        target: companyId,
        metadata: { reason, impersonatedAdminId: userAccountId, impersonatedAdminEmail: adminEmail },
      });

      return {
        token,
        sessionId,
        expiresAt,
        companyId,
        companyName: company.name,
        impersonatedAdminEmail: adminEmail,
      };
    });
  }
}
