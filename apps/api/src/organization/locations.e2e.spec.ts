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
  sub: "locations-e2e-fixtures",
};

/**
 * Organization Management, Phase 4 — real HTTP routes
 * (locations.controller.ts) through the actual guards
 * (SessionGuard/ValidationPipe), same shape as org-units.e2e.spec.ts.
 */
describe("Locations HTTP surface (e2e)", () => {
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
        `Locations E2E Co ${stamp}`,
        `locations-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`locations-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`locations-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/locations/tree");
    expect(res.status).toBe(401);
  });

  let rootId: string;
  let childId: string;

  describe("POST /organization/locations", () => {
    it("creates a root location as HR Admin", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/locations")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Pakistan", locationType: "country", code: "PK" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Pakistan");
      expect(res.body.parentId).toBeNull();
      rootId = res.body.id;
    });

    it("creates a child location under the root", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/locations")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Karachi", locationType: "city", parentId: rootId });

      expect(res.status).toBe(201);
      expect(res.body.parentId).toBe(rootId);
      childId = res.body.id;
    });

    it("rejects an invalid locationType", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/locations")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Bad Type", locationType: "not-a-real-type" });

      expect(res.status).toBe(400);
    });

    it("403s for a Line Manager (location.view.all only, no manage)", async () => {
      const res = await request(app.getHttpServer())
        .post("/organization/locations")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ name: "Nope", locationType: "city" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /organization/locations, /tree, /:id, /:id/history", () => {
    it("returns the nested tree", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/locations/tree")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      const rootNode = res.body.find((n: { id: string }) => n.id === rootId);
      expect(rootNode.children.map((c: { id: string }) => c.id)).toContain(childId);
    });

    it("a Line Manager can read the tree (view.all) even though they can't mutate it", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/locations/tree")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
    });

    it("returns the flat list", async () => {
      const res = await request(app.getHttpServer())
        .get("/organization/locations")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((l: { id: string }) => l.id)).toEqual(expect.arrayContaining([rootId, childId]));
    });

    it("returns one location by id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/locations/${childId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(childId);
    });

    it("returns the version history, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/organization/locations/${childId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /organization/locations/:id and /:id/move", () => {
    it("renames a location", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/organization/locations/${childId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Karachi (Renamed)" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Karachi (Renamed)");
    });

    it("rejects moving a location to be its own parent", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/locations/${rootId}/move`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ parentId: rootId });
      expect(res.status).toBe(400);
    });

    it("rejects moving a location under its own descendant", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/locations/${rootId}/move`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ parentId: childId });
      expect(res.status).toBe(400);
    });

    it("moves a location to become a root (parentId: null)", async () => {
      const res = await request(app.getHttpServer())
        .post(`/organization/locations/${childId}/move`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ parentId: null });
      expect(res.status).toBe(201);
      expect(res.body.parentId).toBeNull();
    });
  });

  describe("POST /organization/locations/:id/archive and /activate", () => {
    it("archives then reactivates a location", async () => {
      const archived = await request(app.getHttpServer())
        .post(`/organization/locations/${childId}/archive`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe("archived");

      const activated = await request(app.getHttpServer())
        .post(`/organization/locations/${childId}/activate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(activated.status).toBe(201);
      expect(activated.body.status).toBe("active");
    });
  });

  describe("employee <-> location linking through the real /employees routes", () => {
    it("POST /employees with locationId derives the location text", async () => {
      const res = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ firstName: "Linked", lastName: "Employee", locationId: rootId });

      expect(res.status).toBe(201);
      expect(res.body.locationId).toBe(rootId);
      expect(res.body.location).toBe("Pakistan");
    });
  });
});
