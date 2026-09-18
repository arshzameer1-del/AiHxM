import { ConflictException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { hashPassword } from "../auth/password";
import type { PackageTier, SignupRequest, SignupResponse } from "@boostfactor/shared-types";
import { SignupDto } from "./dto/signup.dto";

/**
 * Trusted server-side code with no real user session behind it yet —
 * the exact case `app.is_service()` exists for (0002_auth_identity.sql's
 * own header comment, and `AuthService`'s identical `SERVICE_CLAIMS`
 * for its own pre-auth lookups). `0025_self_service_signup.sql` is what
 * makes this claims object actually able to INSERT into
 * `companies`/`company_config`/`company_admins` — those three tables
 * predate `is_service()` and, until that migration, only ever accepted
 * a real Platform Admin session, because every company before this
 * feature existed WAS onboarded by one.
 */
const SIGNUP_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "signup-service" };

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

@Injectable()
export class SignupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService
  ) {}

  /**
   * The one thing `CompaniesService.create()` (Platform-Admin-only)
   * cannot do on its own behalf: provision a brand-new company AND grant
   * its own first admin a working, USABLE login in the same request —
   * `hr_admin`, not just a bare `company_admins` row with zero RBAC
   * permissions (Decision #12's own documented gap for that tier, closed
   * here specifically for the self-signup path: there is no Platform
   * Admin left to grant that role by hand afterward, so this request has
   * to be the thing that does it, scoped ONLY to the company this exact
   * call is itself creating — never an existing one).
   */
  async signup(dto: SignupDto | SignupRequest): Promise<SignupResponse> {
    const packageTier: PackageTier = dto.packageTier ?? "starter";

    return this.db.withClaims(SIGNUP_CLAIMS, async (client) => {
      const existingEmail = await client.query("SELECT 1 FROM user_accounts WHERE email = $1", [dto.adminEmail]);
      if ((existingEmail.rowCount ?? 0) > 0) {
        throw new ConflictException("An account with this email already exists. Try logging in instead.");
      }

      const baseSlug = slugify(dto.slug ?? dto.companyName);
      if (!baseSlug) {
        throw new ConflictException("companyName must contain at least one letter or digit");
      }
      let slug = baseSlug;
      for (let attempt = 0; attempt < 25; attempt++) {
        const existingSlug = await client.query("SELECT 1 FROM companies WHERE slug = $1", [slug]);
        if ((existingSlug.rowCount ?? 0) === 0) break;
        slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      }

      const companyResult = await client.query(
        `INSERT INTO companies (name, slug, package_tier, status) VALUES ($1, $2, $3, 'trial') RETURNING id`,
        [dto.companyName, slug, packageTier]
      );
      const companyId = companyResult.rows[0].id as string;

      const enabledModules = await this.entitlements.seedForNewCompany(client, companyId, packageTier);

      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, $2::jsonb, $3::jsonb)`,
        [
          companyId,
          JSON.stringify(enabledModules),
          JSON.stringify({ prefix: "EMP", padding: 4, startingSequence: 1, preserveImportedNumbers: true }),
        ]
      );

      const passwordHash = await hashPassword(dto.adminPassword);
      const userAccountResult = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [dto.adminEmail, passwordHash]
      );
      const userAccountId = userAccountResult.rows[0].id as string;

      await client.query(
        `INSERT INTO company_admins (company_id, full_name, email, status, user_account_id)
         VALUES ($1, $2, $3, 'active', $4)`,
        [companyId, dto.adminFullName, dto.adminEmail, userAccountId]
      );

      // The step Decision #12 deliberately left Platform-Admin-gated for
      // every OTHER onboarding path ("production is read-only unless
      // explicitly authorized" around a real tenant's initial setup) —
      // safe here specifically because it's scoped to a company this
      // same request just created, never an existing one a self-signup
      // caller could otherwise reach into.
      const hrAdminRole = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, hrAdminRole.rows[0].id]
      );

      await this.audit.record(client, { ...SIGNUP_CLAIMS, sub: userAccountId }, {
        companyId,
        action: "company.self_signup",
        target: slug,
        metadata: { packageTier, enabledModules, adminEmail: dto.adminEmail },
      });

      return { companyId, slug, packageTier };
    });
  }
}
