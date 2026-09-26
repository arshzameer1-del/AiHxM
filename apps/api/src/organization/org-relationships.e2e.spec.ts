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
  sub: "org-relationships-e2e-fixtures",
};

/**
 * Organization Management, Phase 3 — real HTTP routes
 * (org-relationships.controller.ts) through the actual guards
 * (SessionGuard/ValidationPipe), same shape as
 * employee-org-assignments.e2e.spec.ts/jobs.e2e.spec.ts. Cycle prevention
 * and `employees.managerId` sync themselves are covered at the unit level
 * in org-relationships.service.spec.ts — this file exercises the HTTP
 * surface + guards only, the same division of labor every other
 * Organization Management *.e2e.spec.ts already uses.
 */
describe("Org Relationships HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let reportId: string;
  let managerId: string;
  let otherManagerId: string;

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

  async function createEmployee(employeeNumber: string, firstName: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1, $2, $3, 'E2E') RETURNING id",
        [companyId, employeeNumber, firstName]
      );
      return result.rows[0].id as string;
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
        `Relationships E2E Co ${stamp}`,
        `relationships-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`rel-e2e-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`rel-e2e-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    reportId = await createEmployee("EMP-0001", "Report");
    managerId = await createEmployee("EMP-0002", "Manager");
    otherManagerId = await createEmployee("EMP-0003", "OtherManager");
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/relationships");
    expect(res.status).toBe(401);
  });

  let relationshipId: string;

  describe("POST /organization/relationships", () => {
    it("creates a direct relationship as HR Admin", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: reportId, managerEmployeeId: managerId, relationshipType: "direct" });

      expect(res.status).toBe(201);
      expect(res.body.relationshipType).toBe("direct");
      expect(res.body.status).toBe("active");
      relationshipId = res.body.id;
    });

    it("syncs employees.managerId on the employees record", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${reportId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.managerId).toBe(managerId);
    });

    it("rejects an invalid relationshipType", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: reportId, managerEmployeeId: managerId, relationshipType: "not-a-real-type" });
      expect(res.status).toBe(400);
    });

    it("rejects an employee being their own manager", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: reportId, managerEmployeeId: reportId, relationshipType: "dotted_line" });
      expect(res.status).toBe(400);
    });

    it("409s a second open direct relationship for the same employee", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: reportId, managerEmployeeId: otherManagerId, relationshipType: "direct" });
      expect(res.status).toBe(409);
    });

    it("rejects a cycle (making the report their manager's manager)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: managerId, managerEmployeeId: reportId, relationshipType: "direct" });
      expect(res.status).toBe(400);
    });

    it("403s for a Line Manager (view.all only, no manage)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ employeeId: reportId, managerEmployeeId: otherManagerId, relationshipType: "dotted_line" });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /organization/relationships, /:id, /:id/history", () => {
    it("returns the relationship list", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((r: { id: string }) => r.id)).toContain(relationshipId);
    });

    it("a Line Manager can read (view.all) even though they can't mutate", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/relationships")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
    });

    it("returns one relationship by id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/relationships/${relationshipId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(relationshipId);
    });

    it("returns the version history, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/relationships/${relationshipId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /organization/relationships/:id", () => {
    it("reassigns the manager side, re-syncing employees.managerId", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/organization/relationships/${relationshipId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ managerEmployeeId: otherManagerId });
      expect(res.status).toBe(200);
      expect(res.body.managerEmployeeId).toBe(otherManagerId);

      const employee = await request(app.getHttpServer())
        .get(`/employees/${reportId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(employee.body.managerId).toBe(otherManagerId);
    });
  });

  describe("POST /organization/relationships/:id/end", () => {
    it("ends a relationship and clears employees.managerId", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/relationships/${relationshipId}/end`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("ended");

      const employee = await request(app.getHttpServer())
        .get(`/employees/${reportId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(employee.body.managerId).toBeNull();
    });

    it("a second direct relationship can now be created since the prior one is ended", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/relationships")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: reportId, managerEmployeeId: otherManagerId, relationshipType: "direct" });
      expect(res.status).toBe(201);
    });
  });
});
