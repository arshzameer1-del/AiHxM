import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "shifts-e2e-fixtures" };

/**
 * Real routes only (shifts.controller.ts): POST /shifts, GET /shifts,
 * PATCH /shifts/:id, POST /shift-assignments, GET
 * /employees/:employeeId/shift, GET /employees/:employeeId/shift-history
 * — plus the integration point this whole feature exists for: POST
 * /attendance/clock-in (leave.controller.ts) now returns a real `status`
 * ("on_time"/"late"/"no_shift_assigned") computed against whatever shift
 * is assigned, proven here end to end through the real HTTP surface
 * rather than only at the service layer (shifts.service.spec.ts covers
 * that level already).
 */
describe("Shift Management HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let staffToken: string;
  let outsiderToken: string;
  let staffEmployeeId: string;
  let staffEmployeeNumber: string;

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
        `Shifts E2E Co ${stamp}`,
        `shifts-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`shifts-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`shifts-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    const outsiderUserId = await createUser(`shifts-outsider-${stamp}@example.com`);
    await assignRole(outsiderUserId, "employee_self_service");
    outsiderToken = signSession({ sub: outsiderUserId, is_platform_admin: false, company_id: companyId });

    const staffEmpRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Shift", lastName: "Worker", department: "Operations", userAccountId: staffUserId });
    staffEmployeeId = staffEmpRes.body.id;
    staffEmployeeNumber = staffEmpRes.body.employeeNumber;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("POST /shifts", () => {
    it("lets hr_admin create a shift", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Standard Shift", startTime: "09:00", endTime: "17:00", graceMinutesLate: 10 });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Standard Shift");
      expect(res.body.graceMinutesLate).toBe(10);
    });

    it("rejects a non-admin from creating a shift", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ name: "Sneaky Shift", startTime: "09:00", endTime: "17:00" });
      expect(res.status).toBe(403);
    });

    it("rejects a malformed time string", async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Bad Time Shift", startTime: "9am", endTime: "17:00" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /shifts", () => {
    it("lists shifts for the company", async () => {
      const res = await request(app.getHttpServer()).get("/shifts").set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.some((s: { name: string }) => s.name === "Standard Shift")).toBe(true);
    });
  });

  describe("shift assignment + resolution", () => {
    let shiftId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post("/shifts")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: "Assignment Shift", startTime: "08:00", endTime: "16:00", graceMinutesLate: 5 });
      shiftId = res.body.id;

      await request(app.getHttpServer())
        .post("/shift-assignments")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employeeId: staffEmployeeId, shiftId, effectiveFrom: "2020-01-01" });
    });

    it("lets the employee see their own current shift", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/shift`)
        .set("Authorization", `Bearer ${staffToken}`);
      expect(res.status).toBe(200);
      expect(res.body.shiftId).toBe(shiftId);
    });

    it("refuses another employee viewing someone else's shift", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/shift`)
        .set("Authorization", `Bearer ${outsiderToken}`);
      expect(res.status).toBe(403);
    });

    it("returns the shift assignment history", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/shift-history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe("attendance status now reflects the assigned shift", () => {
    it("clocking in returns a status computed against the resolved shift", async () => {
      const clockIn = await request(app.getHttpServer())
        .post("/attendance/clock-in")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ employeeNumber: staffEmployeeNumber, source: "manual" });
      expect(clockIn.status).toBe(201);
      expect(["on_time", "late"]).toContain(clockIn.body.status);
      expect(clockIn.body.shiftName).toBe("Assignment Shift");

      await request(app.getHttpServer())
        .post("/attendance/clock-out")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ employeeNumber: staffEmployeeNumber });

      const list = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/attendance`)
        .set("Authorization", `Bearer ${staffToken}`);
      expect(list.status).toBe(200);
      expect(list.body[0]).toHaveProperty("status");
      expect(list.body[0]).toHaveProperty("shiftName");
    });
  });
});
