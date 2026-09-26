import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "jobs-e2e-fixtures",
};

/**
 * Organization Management, Phase 2 — real HTTP routes
 * (jobs.controller.ts) through the actual guards
 * (SessionGuard/ValidationPipe), same shape as org-units.e2e.spec.ts.
 */
describe("Jobs HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;

  function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
    return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
  }

  async function createUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        userAccountId,
        companyId,
        role.rows[0].id,
      ]);
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [
        `Jobs E2E Co ${stamp}`,
        `jobs-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
      return id;
    });

    const hrAdminUserId = await createUser(`jobs-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`jobs-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/jobs");
    expect(res.status).toBe(401);
  });

  let jobId: string;

  describe("POST /organization/jobs", () => {
    it("creates a job as HR Admin", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/jobs")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ title: "Product Manager", jobCode: "PM-1", jobFamily: "product", jobLevel: "L5" });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe("Product Manager");
      expect(res.body.status).toBe("active");
      jobId = res.body.id;
    });

    it("rejects an invalid jobFamily", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/jobs")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ title: "Bad Family", jobFamily: "not-a-real-family" });

      expect(res.status).toBe(400);
    });

    it("403s for a Line Manager (job.view.all only, no manage)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/jobs")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ title: "Nope" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /organization/jobs, /:id, /:id/history", () => {
    it("returns the job catalog", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/jobs")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((j: { id: string }) => j.id)).toContain(jobId);
    });

    it("a Line Manager can read the catalog (view.all) even though they can't mutate it", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/jobs")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
    });

    it("returns one job by id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/jobs/${jobId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(jobId);
    });

    it("returns the version history, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/jobs/${jobId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /organization/jobs/:id", () => {
    it("retitles a job", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/organization/jobs/${jobId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ title: "Senior Product Manager" });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Senior Product Manager");
    });
  });

  describe("POST /organization/jobs/:id/archive and /activate", () => {
    it("archives then reactivates a job", async () => {
      const archived = await request(app.getHttpServer())
        .post(`/organization/jobs/${jobId}/archive`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe("archived");

      const activated = await request(app.getHttpServer())
        .post(`/organization/jobs/${jobId}/activate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(activated.status).toBe(201);
      expect(activated.body.status).toBe("active");
    });
  });
});
