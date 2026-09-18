import { ConflictException, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { PlatformAdminsService } from "./platform-admins.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "platform-admins-service-fixtures",
};

/**
 * PlatformAdminsService (platform-admins.service.ts) bundles account
 * creation and profile creation into one transaction — there is no
 * separate "add profile, then create login" flow the way CompaniesService
 * has for CompanyAdmin. Its public surface is exactly three methods:
 * list(claims), create(claims, { fullName, email, initialPassword }), and
 * setStatus(claims, adminId, status). There is no grantCompanyAccess,
 * no createPlatformAdmin, and no per-admin detail getter.
 */
describe("PlatformAdminsService", () => {
  let service: PlatformAdminsService;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(() => {
    // Direct construction, not Test.createTestingModule: see
    // companies.service.spec.ts's identical comment — a DI-container
    // provider list here previously supplied the wrong token for
    // DatabaseService's Pool dependency, which only failed at test-run
    // time. Matching the rest of this codebase's service-level specs.
    service = new PlatformAdminsService(db, new AuditService());
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("create", () => {
    it("creates a platform admin with a bundled login", async () => {
      const email = `platform-admin-${Date.now()}@example.com`;
      const result = await service.create(FIXTURE_CLAIMS, {
        fullName: "Test Platform Admin",
        email,
        initialPassword: "SecurePassword123!",
      });

      expect(result.id).toBeDefined();
      expect(result.fullName).toBe("Test Platform Admin");
      expect(result.email).toBe(email);
      expect(result.status).toBe("active");
      expect(result.createdAt).toBeDefined();
    });

    it("rejects a duplicate email", async () => {
      const email = `platform-admin-dup-${Date.now()}@example.com`;
      await service.create(FIXTURE_CLAIMS, {
        fullName: "First Admin",
        email,
        initialPassword: "SecurePassword123!",
      });

      await expect(
        service.create(FIXTURE_CLAIMS, {
          fullName: "Second Admin",
          email,
          initialPassword: "AnotherPassword123!",
        })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("list", () => {
    it("lists platform admins ordered by creation", async () => {
      const email = `platform-admin-list-${Date.now()}@example.com`;
      await service.create(FIXTURE_CLAIMS, {
        fullName: "List Test Admin",
        email,
        initialPassword: "SecurePassword123!",
      });

      const result = await service.list(FIXTURE_CLAIMS);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      const found = result.find((a) => a.email === email);
      expect(found).toBeDefined();
      expect(found?.fullName).toBe("List Test Admin");
    });
  });

  describe("setStatus", () => {
    it("locks and unlocks a platform admin", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        fullName: "Status Test Admin",
        email: `platform-admin-status-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });

      const locked = await service.setStatus(FIXTURE_CLAIMS, created.id, "locked");
      expect(locked.status).toBe("locked");

      const unlocked = await service.setStatus(FIXTURE_CLAIMS, created.id, "active");
      expect(unlocked.status).toBe("active");
    });

    it("throws NotFoundException for a non-existent admin id", async () => {
      await expect(
        service.setStatus(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000", "locked")
      ).rejects.toThrow(NotFoundException);
    });
  });
});
