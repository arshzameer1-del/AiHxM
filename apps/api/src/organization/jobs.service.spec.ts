import { Pool } from "pg";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { JobsService } from "./jobs.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "jobs-spec-fixtures" };

/**
 * Organization Management, Phase 2 (see the Master Engineering
 * Instruction doc's Section 10, and 0068_job_position_architecture.sql).
 * Proven the same way OrgUnitsService was: real Postgres, no mocks —
 * catalog CRUD, effective-dating/versioning, RBAC, tenant isolation.
 */
describe("JobsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let jobs: JobsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    jobs = new JobsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureCompany(namePrefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
      ]);
      const companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        companyId,
      ]);
      return companyId as string;
    });
  }

  async function createUser(email: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, companyId: string, roleKey: string) {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, role.rows[0].id]
      );
    });
  }

  describe("catalog CRUD, effective-dating, and RBAC", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineerId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Job Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`job-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`job-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      engineerId = (
        await jobs.create(hrAdminClaims, {
          title: "Software Engineer II",
          jobCode: "ENG-2",
          jobFamily: "engineering",
          jobLevel: "L4",
        })
      ).id;
    });

    it("creates a job with an initial version effective today", async () => {
      const job = await jobs.get(hrAdminClaims, engineerId);
      expect(job).toMatchObject({
        title: "Software Engineer II",
        jobCode: "ENG-2",
        jobFamily: "engineering",
        jobLevel: "L4",
        status: "active",
      });

      const history = await jobs.getHistory(hrAdminClaims, engineerId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ title: "Software Engineer II", effectiveTo: null });
    });

    it("rejects a duplicate job code within the same tenant", async () => {
      await expect(
        jobs.create(hrAdminClaims, { title: "Duplicate Code Job", jobCode: "ENG-2" })
      ).rejects.toThrow(ConflictException);
    });

    it("allows a job with no jobFamily/jobLevel/jobCode at all — none are required", async () => {
      const minimal = await jobs.create(hrAdminClaims, { title: "Minimal Job" });
      expect(minimal).toMatchObject({ title: "Minimal Job", jobCode: null, jobFamily: null, jobLevel: null });
    });

    it("list() returns every job in the tenant, alphabetical", async () => {
      const list = await jobs.list(hrAdminClaims);
      const titles = list.map((j) => j.title);
      expect(titles).toEqual([...titles].sort());
      expect(titles).toContain("Software Engineer II");
    });

    it("update() renames in place and opens a new version (unless same-day, then collapses)", async () => {
      const updated = await jobs.update(hrAdminClaims, engineerId, { title: "Software Engineer III" });
      expect(updated.title).toBe("Software Engineer III");
      // Same-day collapse — create() and this update() both land on today.
      const history = await jobs.getHistory(hrAdminClaims, engineerId);
      expect(history).toHaveLength(1);
      expect(history[0].title).toBe("Software Engineer III");
    });

    it("archive()/activate() toggle status", async () => {
      const archived = await jobs.archive(hrAdminClaims, engineerId);
      expect(archived.status).toBe("archived");
      const reactivated = await jobs.activate(hrAdminClaims, engineerId);
      expect(reactivated.status).toBe("active");
    });

    it("404s on a nonexistent job id", async () => {
      await expect(jobs.get(hrAdminClaims, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(NotFoundException);
    });

    it("a Line Manager (job.view.all only) can read the catalog but not mutate it", async () => {
      const list = await jobs.list(managerClaims);
      expect(list.length).toBeGreaterThan(0);
      await expect(jobs.create(managerClaims, { title: "Nope" })).rejects.toThrow(ForbiddenException);
      await expect(jobs.update(managerClaims, engineerId, { title: "Nope" })).rejects.toThrow(ForbiddenException);
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(jobs.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a job created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Job Isolation A");
      const companyBId = await createFixtureCompany("Job Isolation B");
      const hrAdminA = await createUser(`job-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`job-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const jobA = await jobs.create(claimsA, { title: "A-Only Job" });

      await expect(jobs.get(claimsB, jobA.id)).rejects.toThrow(NotFoundException);
      const listB = await jobs.list(claimsB);
      expect(listB.find((j) => j.id === jobA.id)).toBeUndefined();
    });
  });
});
