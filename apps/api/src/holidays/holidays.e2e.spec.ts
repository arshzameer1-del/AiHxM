import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "holidays-e2e-fixtures" };

/**
 * Real routes only (holidays.controller.ts): POST /holidays, GET
 * /holidays (with and without ?year=), PATCH /holidays/:id, DELETE
 * /holidays/:id — proving the manage-vs-view split (hr_admin manages,
 * every role views) over the real HTTP surface, same discipline as
 * shifts.e2e.spec.ts.
 */
describe("Holiday Management HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let staffToken: string;

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
        `Holidays E2E Co ${stamp}`,
        `holidays-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true)",
        [id]
      );
      return id;
    });

    const hrAdminUserId = await createUser(`holidays-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`holidays-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`holidays-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("POST /holidays", () => {
    it("lets hr_admin create a holiday", async () => {
      const res = await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Independence Day", holidayDate: "2026-08-14" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Independence Day");
      expect(res.body.isOptional).toBe(false);
    });

    it("rejects a line_manager and an employee from creating a holiday", async () => {
      const asManager = await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ name: "Sneaky Holiday", holidayDate: "2026-12-25" });
      expect(asManager.status).toBe(403);

      const asStaff = await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ name: "Sneaky Holiday", holidayDate: "2026-12-25" });
      expect(asStaff.status).toBe(403);
    });

    it("rejects a malformed date", async () => {
      const res = await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Bad Date Holiday", holidayDate: "not-a-date" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /holidays", () => {
    beforeAll(async () => {
      await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Quaid-e-Azam Day", holidayDate: "2026-12-25" });
      await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "New Year (next)", holidayDate: "2027-01-01" });
    });

    it("lets every role list the calendar", async () => {
      const asHr = await request(app.getHttpServer()).get("/holidays").set("Authorization", `Bearer ${hrAdminToken}`);
      const asManager = await request(app.getHttpServer())
        .get("/holidays")
        .set("Authorization", `Bearer ${managerToken}`);
      const asStaff = await request(app.getHttpServer()).get("/holidays").set("Authorization", `Bearer ${staffToken}`);
      expect(asHr.status).toBe(200);
      expect(asManager.status).toBe(200);
      expect(asStaff.status).toBe(200);
      expect(asHr.body.length).toBe(asStaff.body.length);
    });

    it("filters by year via ?year=", async () => {
      const res = await request(app.getHttpServer())
        .get("/holidays?year=2027")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("New Year (next)");
    });
  });

  describe("PATCH /holidays/:id and DELETE /holidays/:id", () => {
    it("updates and then deletes a holiday", async () => {
      const created = await request(app.getHttpServer())
        .post("/holidays")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Draft Holiday", holidayDate: "2026-05-01" });
      const id = created.body.id;

      const updated = await request(app.getHttpServer())
        .patch(`/holidays/${id}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Labour Day" });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe("Labour Day");

      const deleted = await request(app.getHttpServer())
        .delete(`/holidays/${id}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(deleted.status).toBe(200);

      const afterDelete = await request(app.getHttpServer())
        .get("/holidays")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(afterDelete.body.some((h: { id: string }) => h.id === id)).toBe(false);
    });
  });
});
