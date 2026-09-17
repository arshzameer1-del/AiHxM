import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import { CompaniesService } from "./companies.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
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

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CompaniesService,
        DatabaseService,
        AuditService,
        EntitlementsService,
        {
          provide: "DATABASE_CONNECTION",
          useValue: pool,
        },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);
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
      expect(result.company.status).toBe("active");
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
    it("updates company status", async () => {
      const created = await service.create(FIXTURE_CLAIMS, {
        name: "Test Company Update",
        slug: `test-co-update-${Date.now()}`,
      });

      const updated = await service.updateCompany(
        FIXTURE_CLAIMS,
        created.company.id,
        { status: "suspended" }
      );

      expect(updated.status).toBe("suspended");
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
