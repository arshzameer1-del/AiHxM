import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "attendance-corrections-e2e-fixtures" };

/**
 * Real routes only (leave.controller.ts): POST /attendance-corrections,
 * GET /attendance-corrections/pending, PATCH
 * /attendance-corrections/:id/decision, GET
 * /employees/:employeeId/attendance-corrections — proven over the real
 * HTTP surface, same as shifts.e2e.spec.ts does for Shift Management
 * (the service-level spec already covers the finer-grained business
 * rules).
 */
describe("Attendance corrections HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let staffToken: string;
  let staffEmployeeId: string;

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
        `Corrections E2E Co ${stamp}`,
        `corrections-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`corr-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`corr-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`corr-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    const managerEmpRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Maya", lastName: "Manager", userAccountId: managerUserId });

    const staffEmpRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Sam", lastName: "Staff", managerId: managerEmpRes.body.id, userAccountId: staffUserId });
    staffEmployeeId = staffEmpRes.body.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects a validation-invalid submission (missing reason)", async () => {
    const res = await request(app.getHttpServer())
      .post("/attendance-corrections")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, requestedDate: "2026-03-01", requestedClockIn: "2026-03-01T09:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  describe("full submit -> pending queue -> decide lifecycle", () => {
    let requestId: string;

    it("lets the employee submit a correction over HTTP", async () => {
      const res = await request(app.getHttpServer())
        .post("/attendance-corrections")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          requestedDate: "2026-03-01",
          requestedClockIn: "2026-03-01T09:05:00.000Z",
          requestedClockOut: "2026-03-01T17:00:00.000Z",
          reason: "Forgot to badge in that morning",
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending");
      requestId = res.body.id;
    });

    it("shows up in the manager's pending queue", async () => {
      const res = await request(app.getHttpServer())
        .get("/attendance-corrections/pending")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.some((r: { id: string }) => r.id === requestId)).toBe(true);
    });

    it("refuses the employee themselves from deciding it", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/attendance-corrections/${requestId}/decision`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(403);
    });

    it("lets the manager approve it, and it drops out of the pending queue", async () => {
      const decide = await request(app.getHttpServer())
        .patch(`/attendance-corrections/${requestId}/decision`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ decision: "approved", comment: "Confirmed" });
      expect(decide.status).toBe(200);
      expect(decide.body.status).toBe("approved");
      expect(decide.body.attendanceRecordId).not.toBeNull();

      const pending = await request(app.getHttpServer())
        .get("/attendance-corrections/pending")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(pending.body.some((r: { id: string }) => r.id === requestId)).toBe(false);

      const forEmployee = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/attendance-corrections`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(forEmployee.status).toBe(200);
      expect(forEmployee.body.find((r: { id: string }) => r.id === requestId).status).toBe("approved");

      // The whole point: a corrected clock-in now shows up in the real
      // attendance list too, not just the correction request record.
      const attendance = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/attendance`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(attendance.body.some((a: { clockInAt: string }) => a.clockInAt === "2026-03-01T09:05:00.000Z")).toBe(true);
    });
  });
});
