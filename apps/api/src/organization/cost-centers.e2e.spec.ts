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
  sub: "cost-centers-e2e-fixtures",
};

/**
 * Organization Management, Phase 4 — real HTTP routes
 * (cost-centers.controller.ts) through the actual guards
 * (SessionGuard/ValidationPipe), same shape as jobs.e2e.spec.ts.
 */
describe("Cost Centers HTTP surface (e2e)", () => {
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
        `Cost Centers E2E Co ${stamp}`,
        `cost-centers-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`cost-centers-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`cost-centers-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/cost-centers");
    expect(res.status).toBe(401);
  });

  let costCenterId: string;

  describe("POST /organization/cost-centers", () => {
    it("creates a cost center as HR Admin", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/cost-centers")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Finance Cost Center", code: "CC-FIN" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Finance Cost Center");
      expect(res.body.status).toBe("active");
      costCenterId = res.body.id;
    });

    it("rejects a nonexistent orgUnitId", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/cost-centers")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Bad Link", orgUnitId: "00000000-0000-0000-0000-000000000000" });

      expect(res.status).toBe(404);
    });

    it("403s for a Line Manager (cost_center.view.all only, no manage)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/cost-centers")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ name: "Nope" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /organization/cost-centers, /:id, /:id/history", () => {
    it("returns the cost center catalog", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/cost-centers")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((c: { id: string }) => c.id)).toContain(costCenterId);
    });

    it("a Line Manager can read the catalog (view.all) even though they can't mutate it", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/cost-centers")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
    });

    it("returns one cost center by id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/cost-centers/${costCenterId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(costCenterId);
    });

    it("returns the version history, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/cost-centers/${costCenterId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /organization/cost-centers/:id", () => {
    it("renames a cost center", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/organization/cost-centers/${costCenterId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Finance Cost Center (Renamed)" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Finance Cost Center (Renamed)");
    });
  });

  describe("POST /organization/cost-centers/:id/archive and /activate", () => {
    it("archives then reactivates a cost center", async () => {
      const archived = await request(app.getHttpServer())
        .post(`/organization/cost-centers/${costCenterId}/archive`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe("archived");

      const activated = await request(app.getHttpServer())
        .post(`/organization/cost-centers/${costCenterId}/activate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(activated.status).toBe(201);
      expect(activated.body.status).toBe("active");
    });
  });

  describe("position <-> cost/profit center tagging through the real /organization/positions routes", () => {
    it("POST /organization/positions with costCenterId tags the position", async () => {
      const orgUnit = await request(app.getHttpServer())
        .post("/organization/units")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Finance Division", unitType: "division" });
      expect(orgUnit.status).toBe(201);

      const res = await request(app.getHttpServer())
        .post("/organization/positions")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ orgUnitId: orgUnit.body.id, positionTitle: "Finance Analyst", costCenterId });

      expect(res.status).toBe(201);
      expect(res.body.costCenterId).toBe(costCenterId);
    });
  });
});
