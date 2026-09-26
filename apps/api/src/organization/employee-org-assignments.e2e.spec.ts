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
  sub: "employee-assignments-e2e-fixtures",
};

/**
 * Organization Management, Phase 3 — real HTTP routes
 * (employee-org-assignments.controller.ts) through the actual guards
 * (SessionGuard/ValidationPipe), same shape as jobs.e2e.spec.ts/
 * positions.e2e.spec.ts.
 */
describe("Employee Org Assignments HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let engineeringUnitId: string;
  let employeeId: string;

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
        `Assignments E2E Co ${stamp}`,
        `assignments-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`assign-e2e-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`assign-e2e-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    engineeringUnitId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO org_units (company_id, name, unit_type, status) VALUES ($1, 'Engineering', 'department', 'active') RETURNING id",
        [companyId]
      );
      return result.rows[0].id as string;
    });
    employeeId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1, 'EMP-0001', 'E2E', 'Employee') RETURNING id",
        [companyId]
      );
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/employee-assignments");
    expect(res.status).toBe(401);
  });

  let assignmentId: string;

  describe("POST /organization/employee-assignments", () => {
    it("creates a primary assignment as HR Admin", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/employee-assignments")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId, assignmentType: "primary", orgUnitId: engineeringUnitId });

      expect(res.status).toBe(201);
      expect(res.body.assignmentType).toBe("primary");
      expect(res.body.status).toBe("active");
      assignmentId = res.body.id;
    });

    it("rejects an invalid assignmentType", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/employee-assignments")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId, assignmentType: "not-a-real-type", orgUnitId: engineeringUnitId });
      expect(res.status).toBe(400);
    });

    it("409s a second open primary assignment for the same employee", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/employee-assignments")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId, assignmentType: "primary", orgUnitId: engineeringUnitId });
      expect(res.status).toBe(409);
    });

    it("403s for a Line Manager (view.all only, no manage)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/employee-assignments")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ employeeId, assignmentType: "secondary", orgUnitId: engineeringUnitId });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /organization/employee-assignments, /:id, /:id/history", () => {
    it("returns the assignment list", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/employee-assignments")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((a: { id: string }) => a.id)).toContain(assignmentId);
    });

    it("a Line Manager can read (view.all) even though they can't mutate", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/employee-assignments")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
    });

    it("returns one assignment by id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/employee-assignments/${assignmentId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(assignmentId);
    });

    it("returns the version history, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/employee-assignments/${assignmentId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /organization/employee-assignments/:id", () => {
    it("moves an assignment to a different org unit", async () => {
      const salesUnitId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO org_units (company_id, name, unit_type, status) VALUES ($1, 'Sales', 'department', 'active') RETURNING id",
          [companyId]
        );
        return result.rows[0].id as string;
      });

      const res = await request(app.getHttpServer())
        .patch(`/organization/employee-assignments/${assignmentId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ orgUnitId: salesUnitId });
      expect(res.status).toBe(200);
      expect(res.body.orgUnitId).toBe(salesUnitId);
    });
  });

  describe("POST /organization/employee-assignments/:id/end", () => {
    it("ends an assignment", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/employee-assignments/${assignmentId}/end`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("ended");
    });

    it("a second primary assignment can now be created since the prior one is ended", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/employee-assignments")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId, assignmentType: "primary", orgUnitId: engineeringUnitId });
      expect(res.status).toBe(201);
    });
  });
});
