import { Pool } from "pg";
import { CompaniesService } from "./companies.service";
import { AuthService } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { MailerService } from "../mailer/mailer.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "admin-login-reset-integration-fixtures",
};

/**
 * Reproduces a bug reported straight from production: Platform Admin
 * creates a Company Admin login, later resets that admin's password via
 * the new "Reset password" button, gets the confirmation banner back —
 * and the admin's OWN tenant-path login (/:slug/login, the exact path
 * CompaniesService.createAdminLogin/resetAdminPassword exist to serve)
 * then rejects the brand-new password with "Invalid login ID or
 * password", even pasted in verbatim (ruling out a typo).
 *
 * Every other test for these two pieces (companies.service.spec.ts's
 * resetAdminPassword suite, auth.service.spec.ts's loginWithEmployeeNumber
 * suite) exercises them in isolation, against rows it inserts directly
 * with SQL — never CompaniesService.createAdminLogin() followed by
 * CompaniesService.resetAdminPassword() followed by
 * AuthService.loginWithEmployeeNumber(), the exact sequence a real
 * Platform Admin performs through the UI. This is that sequence, end to
 * end, against the real database.
 */
describe("Admin login create -> reset -> login (integration)", () => {
  let companies: CompaniesService;
  let auth: AuthService;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(() => {
    const sessionSecurity = new SessionSecurityService(db, new CacheService());
    companies = new CompaniesService(
      db,
      new AuditService(),
      new EntitlementsService(db),
      sessionSecurity,
      new LocalFileStorageService()
    );
    auth = new AuthService(db, new EntitlementsService(db), new MailerService(), sessionSecurity);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("lets the admin log in with the password Reset password just set, via their own login_id", async () => {
    const created = await companies.create(FIXTURE_CLAIMS, {
      name: "Integration Reset Login Co",
      slug: `int-reset-login-${Date.now()}`,
      initialAdmin: {
        fullName: "Integration Admin",
        email: `int-reset-login-${Date.now()}@example.com`,
      },
    });
    const adminId = created.admins[0].id;
    const loginId = `INT_Admin_${Math.floor(Math.random() * 100000)}`;

    await companies.createAdminLogin(FIXTURE_CLAIMS, created.company.id, adminId, "OriginalPassword123!", loginId);

    // Same call the "Reset password" button in CompanyDetailPage makes.
    await companies.resetAdminPassword(FIXTURE_CLAIMS, created.company.id, adminId, "BrandNewPassword456!");

    // Same call the tenant login page (/:slug/login) makes with the
    // "Employee ID / Login ID" and "Password" fields the user typed.
    const result = await auth.loginWithEmployeeNumber(created.company.slug, loginId, "BrandNewPassword456!");
    expect(result.status).toBe("mfa_setup_required");
  });
});
