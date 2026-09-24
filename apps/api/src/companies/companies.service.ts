import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import * as jwt from "jsonwebtoken";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { hashPassword } from "../auth/password";
import { SessionSecurityService } from "../auth/session-security.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type {
  Company,
  CompanyAdmin,
  CompanyAdminStatus,
  CompanyConfig,
  CompanyDashboardRow,
  CompanyDetail,
  CompanyListFilters,
  CompanyStatus,
  BrandingAssetSlot,
  CreateCompanyRequest,
  DomainAvailabilityResult,
  EmployeeNumberFormat,
  ImpersonateResponse,
  ModuleKey,
  PackageTier,
} from "@aihxm/shared-types";

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
    },
    enabledModules: row.enabled_modules ?? [],
    employeeNumberFormat: row.employee_number_format,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAdmin(row: any): CompanyAdmin {
  return {
    id: row.id,
    companyId: row.company_id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    hasLogin: Boolean(row.user_account_id),
    // Not a secret — a foreign key, not a credential — and TM-017's Force
    // Logout action needs it to target the right user's sessions from the
    // Tenant Users / Admins screen.
    userAccountId: row.user_account_id ?? null,
  };
}

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
        slugAvailable: (slugResult.rowCount ?? 0) === 0,
        customDomain: input.customDomain ?? null,
        customDomainAvailable,
      };
    });
  }

  async create(claims: RequestClaims, input: CreateCompanyRequest): Promise<CompanyDetail> {
    return this.db.withClaims(claims, async (client) => {
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
          [company.id, input.initialAdmin.fullName, input.initialAdmin.email]
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
      const companyResult = await client.query("SELECT * FROM companies WHERE id = $1", [companyId]);
      if (companyResult.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const configResult = await client.query(
        "SELECT * FROM company_config WHERE company_id = $1",
        [companyId]
      );
      const adminsResult = await client.query(
        "SELECT * FROM company_admins WHERE company_id = $1 ORDER BY created_at ASC",
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
        admins: adminsResult.rows.map(rowToAdmin),
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
   * TM-038 Danger Zone: request deletion with a grace period rather than
   * ever hard-deleting on a single API call — "Never immediate hard
   * delete" per the spec's own guidance. `TenantLifecycleSweep` (a new
   * cron job, see tenant-lifecycle.sweep.ts) is what actually archives a
   * company once `deletion_purge_at` passes; this only starts the clock
   * and immediately blocks access the same way Lock/Suspend do (a company
   * pending deletion has no business staying reachable in the meantime).
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

    const company = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE companies SET
           status = 'locked',
           status_reason = $2,
           status_changed_at = now(),
           deletion_requested_at = now(),
           deletion_reason = $2,
           deletion_purge_at = now() + ($3 || ' days')::interval,
           deletion_requested_by = $4,
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, input.reason, graceDays, claims.sub]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "company.deletion_requested",
        target: companyId,
        metadata: { reason: input.reason, graceDays },
      });

      return rowToCompany(result.rows[0]);
    });

    await this.sessionSecurity.invalidateCompanyStatusCache(companyId);
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
      branding?: { primaryColor?: string; secondaryColor?: string };
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

      const existingAdmin = await client.query(
        "SELECT 1 FROM company_admins WHERE company_id = $1 AND email = $2",
        [companyId, input.email]
      );
      if ((existingAdmin.rowCount ?? 0) > 0) {
        throw new ConflictException(`${input.email} is already an admin on this company`);
      }

      const result = await client.query(
        `INSERT INTO company_admins (company_id, full_name, email) VALUES ($1, $2, $3) RETURNING *`,
        [companyId, input.fullName, input.email]
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

      return rowToAdmin(result.rows[0]);
    });
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
   */
  async createAdminLogin(
    claims: RequestClaims,
    companyId: string,
    adminId: string,
    initialPassword: string
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

      const passwordHash = await hashPassword(initialPassword);
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [existing.rows[0].email, passwordHash]
      );
      const userAccountId = account.rows[0].id as string;

      const updated = await client.query(
        "UPDATE company_admins SET user_account_id = $1 WHERE id = $2 RETURNING *",
        [userAccountId, adminId]
      );

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
        metadata: { rolesGranted: ["hr_admin", "system_admin"] },
      });

      return rowToAdmin(updated.rows[0]);
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
   * "Login As" scoped impersonation (plan doc Section 3). Issues a
   * short-lived, company-scoped token — not a platform-admin one — and
   * logs the fact that impersonation happened. There is no tenant
   * workspace UI to actually land on yet (that starts at Phase 7); this
   * proves the scoped-session mechanism itself end to end, which is the
   * part Phase 2's exit criterion actually cares about.
   */
  async impersonate(claims: RequestClaims, companyId: string): Promise<ImpersonateResponse> {
    return this.db.withClaims(claims, async (client) => {
      const companyResult = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyResult.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error("JWT_SECRET is not set");
      }

      const token = jwt.sign(
        { sub: `${claims.sub}:login-as`, is_platform_admin: false, company_id: companyId },
        secret,
        { expiresIn: "30m" }
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.impersonate",
        target: companyId,
        metadata: {},
      });

      return {
        token,
        expiresIn: "30m",
        companyId,
        note: "Tenant workspace UI arrives starting Phase 7 (Employee Core). This token proves the scoped-session mechanism end to end: it carries this company's id and is not a platform-admin token, exactly what RLS keys off.",
      };
    });
  }
}
