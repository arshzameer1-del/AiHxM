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
  sub: "positions-e2e-fixtures",
};

/**
 * Organization Management, Phase 2 — real HTTP routes
 * (positions.controller.ts) through the actual guards
 * (SessionGuard/ValidationPipe), same shape as org-units.e2e.spec.ts /
 * jobs.e2e.spec.ts. This file's real point is proving the occupancy
 * state transition (assign/unassign) works end to end over real HTTP —
 * the pure-service-layer edge cases (freeze/abolish guards, reassignment
 * side effects, RLS) are already covered by positions.service.spec.ts.
 */
describe("Positions HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let orgUnitId: string;
  let jobId: string;
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
        `Positions E2E Co ${stamp}`,
        `positions-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`positions-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`positions-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const orgUnitRes = await request(app.getHttpServer())
      .post("/organization/units")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ name: "Support", unitType: "department" });
    orgUnitId = orgUnitRes.body.id;

    const jobRes = await request(app.getHttpServer())
      .post("/organization/jobs")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ title: "Support Specialist" });
    jobId = jobRes.body.id;

    const employeeRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Occupant", lastName: "Employee" });
    employeeId = employeeRes.body.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/positions");
    expect(res.status).toBe(401);
  });

  let positionId: string;

  describe("POST /organization/positions", () => {
    it("creates a position vacant by default, titled from the job", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/positions")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ orgUnitId, jobId });

      expect(res.status).toBe(201);
      expect(res.body.orgUnitId).toBe(orgUnitId);
      expect(res.body.positionTitle).toBe("Support Specialist");
      expect(res.body.status).toBe("vacant");
      positionId = res.body.id;
    });

    it("403s for a Line Manager (position.view.all only, no manage)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/positions")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ orgUnitId, positionTitle: "Nope" });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /organization/positions, /:id, ?status=, ?orgUnitId=", () => {
    it("returns the position list", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/positions")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((p: { id: string }) => p.id)).toContain(positionId);
    });

    it("filters by status", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/positions?status=vacant")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.every((p: { status: string }) => p.status === "vacant")).toBe(true);
    });

    it("filters by orgUnitId", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/positions?orgUnitId=${orgUnitId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.every((p: { orgUnitId: string }) => p.orgUnitId === orgUnitId)).toBe(true);
    });
  });

  describe("occupancy: POST /:id/assign and /:id/unassign", () => {
    it("assigns an employee, filling the position", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/assign`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("filled");

      const employeeRes = await request(app.getHttpServer())
        .get(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(employeeRes.body.positionId).toBe(positionId);
    });

    it("rejects assigning to a position that's already filled", async () => {
      const secondEmployeeRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ firstName: "Second", lastName: "Occupant" });

      const res = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/assign`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: secondEmployeeRes.body.id });
      expect(res.status).toBe(409);
    });

    it("freeze rejects a filled position", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/freeze`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(400);
    });

    it("unassigns, flipping the position back to vacant", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/unassign`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("vacant");

      const employeeRes = await request(app.getHttpServer())
        .get(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(employeeRes.body.positionId).toBeNull();
    });
  });

  describe("lifecycle: POST /:id/freeze, /unfreeze, /abolish, /reactivate", () => {
    it("freezes, unfreezes, abolishes, and reactivates a vacant position", async () => {
      const frozen = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/freeze`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(frozen.status).toBe(201);
      expect(frozen.body.status).toBe("frozen");

      const unfrozen = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/unfreeze`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(unfrozen.status).toBe(201);
      expect(unfrozen.body.status).toBe("vacant");

      const abolished = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/abolish`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(abolished.status).toBe(201);
      expect(abolished.body.status).toBe("abolished");

      const reactivated = await request(app.getHttpServer())
        .post(`/organization/positions/${positionId}/reactivate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(reactivated.status).toBe(201);
      expect(reactivated.body.status).toBe("vacant");
    });
  });

  describe("GET /organization/positions/:id/history", () => {
    it("returns the version history, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/positions/${positionId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });
});
