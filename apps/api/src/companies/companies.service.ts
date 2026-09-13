import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import * as jwt from "jsonwebtoken";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { hashPassword } from "../auth/password";
import type {
  Company,
  CompanyAdmin,
  CompanyAdminStatus,
  CompanyConfig,
  CompanyDashboardRow,
  CompanyDetail,
  CompanyStatus,
  CreateCompanyRequest,
  EmployeeNumberFormat,
  ImpersonateResponse,
  ModuleKey,
  PackageTier,
} from "@boostfactor/shared-types";

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
function rowToCompany(row: any): Company {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    packageTier: row.package_tier,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToConfig(row: any): CompanyConfig {
  return {
    companyId: row.company_id,
    branding: row.branding ?? {},
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
  };
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateCompanyRequest): Promise<CompanyDetail> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM companies WHERE slug = $1", [input.slug]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`slug "${input.slug}" is already in use`);
      }

      const companyResult = await client.query(
        `INSERT INTO companies (name, slug, package_tier) VALUES ($1, $2, $3) RETURNING *`,
        [input.name, input.slug, input.packageTier ?? "starter"]
      );
      const company = rowToCompany(companyResult.rows[0]);

      const employeeNumberFormat: EmployeeNumberFormat = {
        prefix: input.employeeNumberFormat?.prefix ?? "EMP",
        padding: input.employeeNumberFormat?.padding ?? 4,
        startingSequence: input.employeeNumberFormat?.startingSequence ?? 1,
        preserveImportedNumbers: input.employeeNumberFormat?.preserveImportedNumbers ?? true,
      };

      const configResult = await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, $2::jsonb, $3::jsonb) RETURNING *`,
        [company.id, JSON.stringify(input.enabledModules ?? []), JSON.stringify(employeeNumberFormat)]
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
        metadata: { packageTier: company.packageTier, enabledModules: input.enabledModules ?? [] },
      });

      return { company, config, admins };
    });
  }

  async list(claims: RequestClaims): Promise<CompanyDashboardRow[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`
        SELECT c.*, COUNT(ca.id)::int AS admin_count
        FROM companies c
        LEFT JOIN company_admins ca ON ca.company_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `);
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

      return {
        company: rowToCompany(companyResult.rows[0]),
        config: rowToConfig(configResult.rows[0]),
        admins: adminsResult.rows.map(rowToAdmin),
      };
    });
  }

  async updateCompany(
    claims: RequestClaims,
    companyId: string,
    patch: { status?: CompanyStatus; packageTier?: PackageTier }
  ): Promise<Company> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE companies SET
           status = COALESCE($2, status),
           package_tier = COALESCE($3, package_tier),
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, patch.status ?? null, patch.packageTier ?? null]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "company.updated",
        target: companyId,
        metadata: patch,
      });

      return rowToCompany(result.rows[0]);
    });
  }

  async updateConfig(
    claims: RequestClaims,
    companyId: string,
    patch: {
      branding?: Partial<CompanyConfig["branding"]>;
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

      const nextBranding = { ...existing.branding, ...(patch.branding ?? {}) };
      const nextModules = patch.enabledModules ?? existing.enabledModules;
      const nextFormat: EmployeeNumberFormat = {
        ...existing.employeeNumberFormat,
        ...(patch.employeeNumberFormat ?? {}),
      };

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

      const updated = await client.query(
        "UPDATE company_admins SET user_account_id = $1 WHERE id = $2 RETURNING *",
        [account.rows[0].id, adminId]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.admin.login_created",
        target: existing.rows[0].email,
        metadata: {},
      });

      return rowToAdmin(updated.rows[0]);
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
