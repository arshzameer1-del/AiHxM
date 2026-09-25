import { ConflictException, NotFoundException, BadRequestException } from "@nestjs/common";
import { Pool } from "pg";
import { CompaniesService } from "./companies.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { verifyPassword } from "../auth/password";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "companies-service-fixtures",
};

describe("CompaniesService", () => {
  let service: CompaniesService;
  let pool: Pool;
  let db: DatabaseService;
  let sessionSecurity: SessionSecurityService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    sessionSecurity = new SessionSecurityService(db, new CacheService());
  });

  beforeEach(() => {
    // Direct construction, not Test.createTestingModule: DatabaseService
    // takes its Pool via @Inject(PG_POOL), and a DI-container-based
    // provider list here previously supplied the wrong token
    // ("DATABASE_CONNECTION"), which only failed at test-run time, not
    // at compile time. Every other service-level spec in this codebase
    // (recruitment, employees, leave, payroll, performance) already
    // constructs its service under test directly for the same reason —
    // matching that pattern here removes the whole class of bug.
    service = new CompaniesService(
      db,
      new AuditService(),
      new EntitlementsService(db),
      sessionSecurity,
      new LocalFileStorageService()
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("create", () => {
    it("creates a company with default settings", async () => {
      const result = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company A",
        slug: `test-co-a-${Date.now()}`,
      });

      expect(result.company).toBeDefined();
      expect(result.company.name).toBe("Test Company A");
      expect(result.company.status).toBe("trial");
      expect(result.company.packageTier).toBe("starter");
      expect(result.config).toBeDefined();
      expect(Array.isArray(result.config.enabledModules)).toBe(true);
    });

    it("creates a company with explicit employee number format", async () => {
      const result = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company B",
        slug: `test-co-b-${Date.now()}`,
        employeeNumberFormat: {
          prefix: "TEST",
          padding: 5,
          startingSequence: 100,
          preserveImportedNumbers: false,
        },
      });

      expect(result.config.employeeNumberFormat.prefix).toBe("TEST");
      expect(result.config.employeeNumberFormat.padding).toBe(5);
      expect(result.config.employeeNumberFormat.startingSequence).toBe(100);
      expect(result.config.employeeNumberFormat.preserveImportedNumbers).toBe(
        false
      );
    });

    it("creates a company with initial admin", async () => {
      const result = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company C",
        slug: `test-co-c-${Date.now()}`,
        initialAdmin: {
          fullName: "John Doe",
          email: `admin-${Date.now()}@example.com`,
        },
      });

      expect(result.admins).toHaveLength(1);
      expect(result.admins[0].fullName).toBe("John Doe");
      expect(result.admins[0].hasLogin).toBe(false);
    });

    it("rejects duplicate slug", async () => {
      const slug = `test-co-dup-${Date.now()}`;
      await service.create(FIXTURE_CLAIMS, {
        name: "Test Company D1",
        slug,
      });

      await expect(
        service.create(FIXTURE_CLAIMS, {
          name: "Test Company D2",
          slug,
        })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("list", () => {
    it("lists all companies", async () => {
      const slug = `test-co-list-${Date.now()}`;
      await service.create(FIXTURE_CLAIMS, {
        name: "Test Company List",
        slug,
      });

      const result = await service.list(FIXTURE_CLAIMS);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      const found = result.find((c) => c.slug === slug);
      expect(found).toBeDefined();
    });
  });

  describe("getDetail", () => {
    it("retrieves company details including config and admins", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Detail",
        slug: `test-co-detail-${Date.now()}`,
        initialAdmin: {
          fullName: "Admin",
          email: `detail-admin-${Date.now()}@example.com`,
        },
      });

      const detail = await service.getDetail(FIXTURE_CLAIMS, created.company.id);

      expect(detail.company.id).toBe(created.company.id);
      expect(detail.config.companyId).toBe(created.company.id);
      expect(detail.admins).toHaveLength(1);
      expect(detail.admins[0].fullName).toBe("Admin");
    });

    it("throws NotFoundException for non-existent company", async () => {
      await expect(
        service.getDetail(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000")
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateCompany", () => {
    it("updates company status with a reason, and records it", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Update",
        slug: `test-co-update-${Date.now()}`,
      });

      const updated = await service.updateCompany(
        FIXTURE_CLAIMS,
        created.company.id,
        { status: "suspended", reason: "Non-payment" }
      );

      expect(updated.status).toBe("suspended");
      expect(updated.statusReason).toBe("Non-payment");
      expect(updated.statusChangedAt).not.toBeNull();
    });

    it("updates company package tier", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Tier",
        slug: `test-co-tier-${Date.now()}`,
      });

      const updated = await service.updateCompany(
        FIXTURE_CLAIMS,
        created.company.id,
        { packageTier: "professional" }
      );

      expect(updated.packageTier).toBe("professional");
    });

    it("rejects suspending or locking a company with no reason (TM-005/TM-030)", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company No Reason",
        slug: `test-co-no-reason-${Date.now()}`,
      });

      await expect(
        service.updateCompany(FIXTURE_CLAIMS, created.company.id, { status: "suspended" })
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateCompany(FIXTURE_CLAIMS, created.company.id, { status: "locked", reason: "  " })
      ).rejects.toThrow(BadRequestException);
    });

    it("locking a company immediately blocks its own sessions (not just eventually, via cache TTL)", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Lock Enforcement",
        slug: `test-co-lock-enforce-${Date.now()}`,
      });

      // Warm the cache the same way SessionGuard would on a real request.
      expect(await sessionSecurity.companyAccessStatus(created.company.id)).toBe("ok");

      await service.updateCompany(FIXTURE_CLAIMS, created.company.id, {
        status: "locked",
        reason: "Fraud review",
      });

      // If updateCompany didn't invalidate the cache, this would still read
      // the stale "ok" value for up to 15 seconds.
      expect(await sessionSecurity.companyAccessStatus(created.company.id)).toBe("locked");
    });
  });

  describe("deletion workflow (TM-038 Danger Zone)", () => {
    it("requestDeletion locks the company and sets a purge date; cancelDeletion restores it", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Deletion",
        slug: `test-co-deletion-${Date.now()}`,
      });

      const requested = await service.requestDeletion(FIXTURE_CLAIMS, created.company.id, {
        reason: "Customer requested closure",
        graceDays: 7,
      });
      expect(requested.status).toBe("locked");
      expect(requested.deletionRequestedAt).not.toBeNull();
      expect(requested.deletionPurgeAt).not.toBeNull();
      expect(await sessionSecurity.companyAccessStatus(created.company.id)).toBe("locked");

      const cancelled = await service.cancelDeletion(FIXTURE_CLAIMS, created.company.id);
      expect(cancelled.status).toBe("active");
      expect(cancelled.deletionRequestedAt).toBeNull();
      expect(await sessionSecurity.companyAccessStatus(created.company.id)).toBe("ok");
    });

    it("rejects a deletion request with no reason", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Deletion No Reason",
        slug: `test-co-deletion-no-reason-${Date.now()}`,
      });
      await expect(
        service.requestDeletion(FIXTURE_CLAIMS, created.company.id, { reason: "" })
      ).rejects.toThrow(BadRequestException);
    });

    it("purgeExpiredDeletions archives only companies whose grace period has elapsed", async () => {
      const expired = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Expired Grace",
        slug: `test-co-expired-grace-${Date.now()}`,
      });
      const notYetExpired = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Grace In Progress",
        slug: `test-co-grace-progress-${Date.now()}`,
      });

      await service.requestDeletion(FIXTURE_CLAIMS, expired.company.id, {
        reason: "Closing",
        graceDays: 7,
      });
      await service.requestDeletion(FIXTURE_CLAIMS, notYetExpired.company.id, {
        reason: "Closing",
        graceDays: 7,
      });
      // Force the first company's grace period into the past — directly via
      // SQL, the same way a real 7-day wait would look once elapsed.
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE companies SET deletion_purge_at = now() - interval '1 hour' WHERE id = $1", [
          expired.company.id,
        ])
      );

      const purgedCount = await service.purgeExpiredDeletions(FIXTURE_CLAIMS);
      expect(purgedCount).toBeGreaterThanOrEqual(1);

      const expiredDetail = await service.getDetail(FIXTURE_CLAIMS, expired.company.id);
      expect(expiredDetail.company.status).toBe("archived");
      const notYetExpiredDetail = await service.getDetail(FIXTURE_CLAIMS, notYetExpired.company.id);
      expect(notYetExpiredDetail.company.status).toBe("locked");
    });
  });

  describe("updateConfig", () => {
    it("updates employee number format", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Config",
        slug: `test-co-config-${Date.now()}`,
      });

      const updated = await service.updateConfig(
        FIXTURE_CLAIMS,
        created.company.id,
        {
          employeeNumberFormat: { prefix: "NEW" },
        }
      );

      expect(updated.employeeNumberFormat.prefix).toBe("NEW");
    });

    it("updates company branding", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Branding",
        slug: `test-co-brand-${Date.now()}`,
      });

      const updated = await service.updateConfig(
        FIXTURE_CLAIMS,
        created.company.id,
        {
          branding: { primaryColor: "#FF0000" },
        }
      );

      expect(updated.branding.primaryColor).toBe("#FF0000");
    });
  });

  describe("addAdmin", () => {
    it("adds a new admin to a company", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company AddAdmin",
        slug: `test-co-add-admin-${Date.now()}`,
      });

      const newAdmin = await service.addAdmin(FIXTURE_CLAIMS, created.company.id, {
        fullName: "Jane Smith",
        email: `jane-${Date.now()}@example.com`,
      });

      expect(newAdmin.fullName).toBe("Jane Smith");
      expect(newAdmin.companyId).toBe(created.company.id);
      expect(newAdmin.hasLogin).toBe(false);
    });

    it("prevents duplicate admin emails on same company", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company DupAdmin",
        slug: `test-co-dup-admin-${Date.now()}`,
      });

      const email = `dup-admin-${Date.now()}@example.com`;
      await service.addAdmin(FIXTURE_CLAIMS, created.company.id, {
        fullName: "First",
        email,
      });

      await expect(
        service.addAdmin(FIXTURE_CLAIMS, created.company.id, {
          fullName: "Second",
          email,
        })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("setAdminStatus", () => {
    it("locks and unlocks company admins", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company AdminStatus",
        slug: `test-co-admin-status-${Date.now()}`,
        initialAdmin: {
          fullName: "Lock Test",
          email: `lock-${Date.now()}@example.com`,
        },
      });

      const adminId = created.admins[0].id;

      const locked = await service.setAdminStatus(
        FIXTURE_CLAIMS,
        created.company.id,
        adminId,
        "locked"
      );
      expect(locked.status).toBe("locked");

      const unlocked = await service.setAdminStatus(
        FIXTURE_CLAIMS,
        created.company.id,
        adminId,
        "active"
      );
      expect(unlocked.status).toBe("active");
    });
  });

  describe("createAdminLogin", () => {
    it("creates a login for a company admin", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Login",
        slug: `test-co-login-${Date.now()}`,
        initialAdmin: {
          fullName: "Login Test",
          email: `login-${Date.now()}@example.com`,
        },
      });

      const adminId = created.admins[0].id;
      expect(created.admins[0].hasLogin).toBe(false);

      const withLogin = await service.createAdminLogin(
        FIXTURE_CLAIMS,
        created.company.id,
        adminId,
        "SecurePassword123!"
      );

      expect(withLogin.hasLogin).toBe(true);

      // Real gap found during the Supabase test-deploy pass: this used to
      // create a login with zero RBAC role attached, and — unlike an
      // employee login — there was no self-service screen anywhere that
      // could fix it afterward, leaving the admin locked out of everything
      // despite a working login. createAdminLogin now grants BOTH
      // hr_admin (employee HR data) AND system_admin (workflow config +
      // managing other users' logins/roles) in the same transaction —
      // this admin is the tenant's Company Super Admin, so they need both
      // to actually administer their own tenant, not just its HR data.
      const assignedRoleKeys = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query<{ key: string }>(
          `SELECT r.key FROM user_role_assignments ura
           JOIN roles r ON r.id = ura.role_id
           WHERE ura.company_id = $1
             AND ura.user_account_id = (SELECT user_account_id FROM company_admins WHERE id = $2)
           ORDER BY r.key`,
          [created.company.id, adminId]
        )
      );
      expect(assignedRoleKeys.rows.map((r) => r.key)).toEqual(["hr_admin", "system_admin"]);
    });

    it("prevents duplicate login creation", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company DupLogin",
        slug: `test-co-dup-login-${Date.now()}`,
        initialAdmin: {
          fullName: "Dup Login Test",
          email: `dup-login-${Date.now()}@example.com`,
        },
      });

      const adminId = created.admins[0].id;
      await service.createAdminLogin(
        FIXTURE_CLAIMS,
        created.company.id,
        adminId,
        "Password123!"
      );

      await expect(
        service.createAdminLogin(
          FIXTURE_CLAIMS,
          created.company.id,
          adminId,
          "NewPassword123!"
        )
      ).rejects.toThrow(ConflictException);
    });

    it("rejects creating a login when the admin's email already has a login elsewhere, with a friendly error instead of a raw 500", async () => {
      // Real bug found from a production log: company_admins.email isn't
      // globally unique (two different companies' admin rows can list the
      // same address, e.g. a founder standing up several test tenants with
      // their own email), but user_accounts.email is (Section 5). This
      // path used to let that INSERT's 23505 escape unhandled — the
      // sibling insert in EmployeesService.createLogin() already caught it
      // — so a second company's "create login" for the same address
      // crashed as an unhandled exception instead of a clear 409.
      const sharedEmail = `shared-across-companies-${Date.now()}@example.com`;

      const first = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Shared Email A",
        slug: `test-co-shared-email-a-${Date.now()}`,
        initialAdmin: { fullName: "Shared Email Admin A", email: sharedEmail },
      });
      await service.createAdminLogin(FIXTURE_CLAIMS, first.company.id, first.admins[0].id, "SecurePassword123!");

      const second = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Shared Email B",
        slug: `test-co-shared-email-b-${Date.now()}`,
        initialAdmin: { fullName: "Shared Email Admin B", email: sharedEmail },
      });

      await expect(
        service.createAdminLogin(FIXTURE_CLAIMS, second.company.id, second.admins[0].id, "AnotherPassword123!")
      ).rejects.toThrow(ConflictException);
    });

    it("stores a Platform-Admin-chosen loginId, so this admin can sign in through their own tenant-path login too", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Login ID",
        slug: `test-co-login-id-${Date.now()}`,
        initialAdmin: {
          fullName: "Login ID Test",
          email: `login-id-${Date.now()}@example.com`,
        },
      });

      const adminId = created.admins[0].id;
      const withLogin = await service.createAdminLogin(
        FIXTURE_CLAIMS,
        created.company.id,
        adminId,
        "SecurePassword123!",
        "LHM_Admin1"
      );

      expect(withLogin.loginId).toBe("LHM_Admin1");
    });

    it("rejects a loginId already used by another admin on the same company, case-insensitively", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Login ID Clash",
        slug: `test-co-login-id-clash-${Date.now()}`,
        initialAdmin: {
          fullName: "First Admin",
          email: `first-admin-${Date.now()}@example.com`,
        },
      });
      const secondAdmin = await service.addAdmin(FIXTURE_CLAIMS, created.company.id, {
        fullName: "Second Admin",
        email: `second-admin-${Date.now()}@example.com`,
      });

      await service.createAdminLogin(
        FIXTURE_CLAIMS,
        created.company.id,
        created.admins[0].id,
        "SecurePassword123!",
        "Shared_Login"
      );

      await expect(
        service.createAdminLogin(
          FIXTURE_CLAIMS,
          created.company.id,
          secondAdmin.id,
          "AnotherPassword123!",
          "shared_login"
        )
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("resetAdminPassword", () => {
    it("overwrites the password for an admin who already has a login", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Reset Password",
        slug: `test-co-reset-pw-${Date.now()}`,
        initialAdmin: {
          fullName: "Reset Password Test",
          email: `reset-pw-${Date.now()}@example.com`,
        },
      });
      const adminId = created.admins[0].id;
      await service.createAdminLogin(FIXTURE_CLAIMS, created.company.id, adminId, "OriginalPassword123!");

      const updated = await service.resetAdminPassword(
        FIXTURE_CLAIMS,
        created.company.id,
        adminId,
        "BrandNewPassword456!"
      );
      expect(updated.hasLogin).toBe(true);

      const row = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query<{ password_hash: string }>(
          `SELECT ua.password_hash FROM user_accounts ua
           JOIN company_admins ca ON ca.user_account_id = ua.id
           WHERE ca.id = $1`,
          [adminId]
        )
      );
      const passwordHash = row.rows[0].password_hash;
      await expect(verifyPassword("BrandNewPassword456!", passwordHash)).resolves.toBe(true);
      await expect(verifyPassword("OriginalPassword123!", passwordHash)).resolves.toBe(false);
    });

    it("refuses to reset a password for an admin with no login yet", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Reset No Login",
        slug: `test-co-reset-no-login-${Date.now()}`,
        initialAdmin: {
          fullName: "No Login Yet",
          email: `no-login-${Date.now()}@example.com`,
        },
      });

      await expect(
        service.resetAdminPassword(FIXTURE_CLAIMS, created.company.id, created.admins[0].id, "SomePassword123!")
      ).rejects.toThrow(BadRequestException);
    });

    it("404s for an admin that doesn't belong to this company", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Reset Wrong Company",
        slug: `test-co-reset-wrong-co-${Date.now()}`,
      });

      await expect(
        service.resetAdminPassword(FIXTURE_CLAIMS, created.company.id, "00000000-0000-0000-0000-000000000000", "SomePassword123!")
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("impersonate", () => {
    it("generates a scoped impersonation token", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Impersonate",
        slug: `test-co-imp-${Date.now()}`,
      });

      const result = await service.impersonate(FIXTURE_CLAIMS, created.company.id);

      expect(result.token).toBeDefined();
      expect(result.companyId).toBe(created.company.id);
      expect(result.expiresIn).toBe("30m");
    });
  });
});
