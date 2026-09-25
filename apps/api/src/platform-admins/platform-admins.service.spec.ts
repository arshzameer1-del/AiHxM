import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { PlatformAdminsService } from "./platform-admins.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
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
    service = new PlatformAdminsService(db, new AuditService(), new SessionSecurityService(db, new CacheService()));
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

  /** A company row, only needed here as a valid id for a 'scoped' admin's scope list. */
  async function createCompany(): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Platform Admins Spec Co ${stamp}`,
        `platform-admins-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  }

  // Phase 2 gap-fill item #7 — Platform Admin delegation. The e2e file
  // (platform-admin-delegation.e2e.spec.ts) already proves the HTTP-level
  // enforcement end to end; these cover create()/setAccess()'s own
  // CRUD shape and requireFullAccess() directly at the service level.
  describe("create with accessLevel/scopedCompanyIds", () => {
    it("defaults to 'full' access with no scope when accessLevel is omitted", async () => {
      const result = await service.create(FIXTURE_CLAIMS, {
        fullName: "Default Access Admin",
        email: `platform-admin-default-access-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });

      expect(result.accessLevel).toBe("full");
      expect(result.scopedCompanyIds).toEqual([]);
    });

    it("creates a 'read_only' admin", async () => {
      const result = await service.create(FIXTURE_CLAIMS, {
        fullName: "Read Only Admin",
        email: `platform-admin-read-only-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
        accessLevel: "read_only",
      });

      expect(result.accessLevel).toBe("read_only");
      expect(result.scopedCompanyIds).toEqual([]);
    });

    it("creates a 'scoped' admin with the given scoped company ids", async () => {
      const companyA = await createCompany();
      const companyB = await createCompany();

      const result = await service.create(FIXTURE_CLAIMS, {
        fullName: "Scoped Admin",
        email: `platform-admin-scoped-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
        accessLevel: "scoped",
        scopedCompanyIds: [companyA, companyB],
      });

      expect(result.accessLevel).toBe("scoped");
      expect(result.scopedCompanyIds.sort()).toEqual([companyA, companyB].sort());
    });

    it("ignores scopedCompanyIds when accessLevel is not 'scoped'", async () => {
      const companyA = await createCompany();

      const result = await service.create(FIXTURE_CLAIMS, {
        fullName: "Full Admin With Stray Scope",
        email: `platform-admin-stray-scope-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
        accessLevel: "full",
        scopedCompanyIds: [companyA],
      });

      expect(result.accessLevel).toBe("full");
      expect(result.scopedCompanyIds).toEqual([]);
    });

    it("rejects an unknown access level", async () => {
      await expect(
        service.create(FIXTURE_CLAIMS, {
          fullName: "Bad Access Level Admin",
          email: `platform-admin-bad-access-${Date.now()}@example.com`,
          initialPassword: "SecurePassword123!",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          accessLevel: "super_admin" as any,
        })
      ).rejects.toThrow('Unknown access level "super_admin"');
    });

    it("rejects a non-full caller (privilege-escalation guard)", async () => {
      const scopedCallerClaims: RequestClaims = {
        ...FIXTURE_CLAIMS,
        sub: "scoped-caller",
        platformAdminAccessLevel: "scoped",
        platformAdminScopedCompanyIds: [],
      };

      await expect(
        service.create(scopedCallerClaims, {
          fullName: "Should Not Be Created",
          email: `platform-admin-escalation-${Date.now()}@example.com`,
          initialPassword: "SecurePassword123!",
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows a service-role caller (no platformAdminAccessLevel at all — the bootstrap seed script)", async () => {
      const serviceClaims: RequestClaims = { is_platform_admin: false, is_service: true, sub: "bootstrap-seed" };

      const result = await service.create(serviceClaims, {
        fullName: "Bootstrap Seeded Admin",
        email: `platform-admin-bootstrap-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });

      expect(result.accessLevel).toBe("full");
    });
  });

  describe("setAccess", () => {
    it("changes an existing admin's access level and scope together", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        fullName: "Set Access Admin",
        email: `platform-admin-set-access-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });
      const companyA = await createCompany();

      const updated = await service.setAccess(FIXTURE_CLAIMS, created.id, "scoped", [companyA]);

      expect(updated.accessLevel).toBe("scoped");
      expect(updated.scopedCompanyIds).toEqual([companyA]);
    });

    it("clears the scope list when switching an admin back to 'full'", async () => {
      const companyA = await createCompany();
      const created = await service.create(FIXTURE_CLAIMS, {
        fullName: "Set Access Back To Full Admin",
        email: `platform-admin-set-access-full-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
        accessLevel: "scoped",
        scopedCompanyIds: [companyA],
      });

      const updated = await service.setAccess(FIXTURE_CLAIMS, created.id, "full", undefined);

      expect(updated.accessLevel).toBe("full");
      expect(updated.scopedCompanyIds).toEqual([]);
    });

    it("throws NotFoundException for a non-existent admin id", async () => {
      await expect(
        service.setAccess(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000", "read_only", undefined)
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects a non-full caller (privilege-escalation guard)", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        fullName: "Target Admin",
        email: `platform-admin-setaccess-target-${Date.now()}@example.com`,
        initialPassword: "SecurePassword123!",
      });
      const readOnlyCallerClaims: RequestClaims = {
        ...FIXTURE_CLAIMS,
        sub: "read-only-caller",
        platformAdminAccessLevel: "read_only",
        platformAdminScopedCompanyIds: [],
      };

      await expect(
        service.setAccess(readOnlyCallerClaims, created.id, "full", undefined)
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
