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
  sub: "leave-e2e-fixtures",
};

/**
 * Real routes only (leave.controller.ts) — note there is NO "/leave"
 * prefix anywhere: POST /leave-requests, GET /leave-requests, GET
 * /leave-requests/:id, PATCH /leave-requests/:id/decision (not
 * /approve or /reject), POST /leave-requests/:id/cancel, GET
 * /employees/:employeeId/leave-balances, POST /attendance/clock-in,
 * POST /attendance/clock-out, GET /employees/:employeeId/attendance.
 * Leave policies live on employee-groups.controller.ts's POST/GET
 * /leave-policies. There is no `leave_policies.type` column and no
 * standalone attendance controller beyond what's listed here — see
 * leave-requests.service.spec.ts for the equivalent service-level
 * coverage this e2e file mirrors at the HTTP layer.
 *
 * A leave request only routes anywhere once a tenant-wide default leave
 * policy exists (employee-groups) and a `leave_request` workflow
 * template exists (workflow) — both are seeded here via their own real
 * HTTP routes before any leave-request test runs, exactly like the
 * service-level spec's `beforeAll`.
 */
describe("Leave & Attendance HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
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
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      })
    );
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [
        `Leave E2E Co ${stamp}`,
        `leave-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`leave-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    // Also holds workflow_template.manage.all (via the demo role) so this
    // same fixture user can configure the tenant's approval workflow —
    // see 0008_workflow_seed.sql: hr_admin alone doesn't carry that
    // permission, only rbac_demo_full_access and system_admin do.
    await assignRole(hrAdminUserId, "rbac_demo_full_access");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`leave-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`leave-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    const outsiderUserId = await createUser(`leave-outsider-${stamp}@example.com`);
    outsiderToken = signSession({ sub: outsiderUserId, is_platform_admin: false, company_id: companyId });

    const managerEmpRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Maya", lastName: "Manager", department: "Engineering", userAccountId: managerUserId });
    const managerEmployeeId = managerEmpRes.body.id;

    const staffEmpRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({
        firstName: "Sam",
        lastName: "Staff",
        department: "Engineering",
        managerId: managerEmployeeId,
        userAccountId: staffUserId,
      });
    staffEmployeeId = staffEmpRes.body.id;
    staffEmployeeNumber = staffEmpRes.body.employeeNumber;

    // Tenant-wide default leave policy — the safe-deny fallback every
    // employee here resolves to, since no employee group is configured.
    await request(app.getHttpServer())
      .post("/leave-policies")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ name: "Default Policy", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true });

    // A single manager_of_submitter approval step, routing every leave
    // request to the submitter's actual manager.
    await request(app.getHttpServer())
      .post("/workflow/templates")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({
        key: "leave_request",
        name: "Leave Approval",
        objectKey: "leave_request",
        steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }],
      });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("POST /leave-requests", () => {
    it("should create leave request", async () => {
      const res = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "annual",
          startDate: "2026-03-01",
          endDate: "2026-03-03",
          reason: "Family trip",
        });

      expect(res.status).toBe(201);
      expect(res.body.request.status).toBe("pending");
      expect(res.body.request.daysRequested).toBe(3);
      expect(res.body.request.workflowInstanceId).toBeTruthy();
    });

    it("should reject leave request with invalid dates", async () => {
      const res = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "annual",
          startDate: "2026-03-10",
          endDate: "2026-03-05",
        });

      expect(res.status).toBe(400);
    });

    it("should reject leave request without authorization", async () => {
      const res = await request(app.getHttpServer()).post("/leave-requests").send({
        employeeId: staffEmployeeId,
        leaveType: "annual",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
      });

      expect(res.status).toBe(401);
    });

    it("denies a caller with neither create.self nor manage.all", async () => {
      const res = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${outsiderToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "annual",
          startDate: "2026-03-15",
          endDate: "2026-03-15",
        });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /employees/:employeeId/leave-balances", () => {
    it("should get employee leave balance", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/leave-balances`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const annual = res.body.find((b: { leaveType: string }) => b.leaveType === "annual");
      expect(annual.entitledDays).toBe(14);
    });

    it("should reject without authorization", async () => {
      const res = await request(app.getHttpServer()).get(`/employees/${staffEmployeeId}/leave-balances`);

      expect(res.status).toBe(401);
    });
  });

  describe("GET /leave-requests", () => {
    it("should list leave requests for a specific employee", async () => {
      const res = await request(app.getHttpServer())
        .get("/leave-requests")
        .query({ employeeId: staffEmployeeId })
        .set("Authorization", `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((r: { employeeId: string }) => r.employeeId === staffEmployeeId)).toBe(true);
    });

    it("should list all leave requests for HR admin", async () => {
      const res = await request(app.getHttpServer())
        .get("/leave-requests")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe("PATCH /leave-requests/:id/decision", () => {
    it("should approve leave request", async () => {
      const submitRes = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "casual",
          startDate: "2026-04-01",
          endDate: "2026-04-01",
        });
      const requestId = submitRes.body.request.id;

      const res = await request(app.getHttpServer())
        .patch(`/leave-requests/${requestId}/decision`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ decision: "approved", comment: "Approved" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
    });

    it("should reject leave request", async () => {
      const submitRes = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "sick",
          startDate: "2026-04-05",
          endDate: "2026-04-05",
        });
      const requestId = submitRes.body.request.id;

      const res = await request(app.getHttpServer())
        .patch(`/leave-requests/${requestId}/decision`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ decision: "rejected", comment: "Not enough coverage" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
    });

    it("rejects a decision from someone who isn't the resolved approver", async () => {
      const submitRes = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "casual",
          startDate: "2026-04-08",
          endDate: "2026-04-08",
        });
      const requestId = submitRes.body.request.id;

      const res = await request(app.getHttpServer())
        .patch(`/leave-requests/${requestId}/decision`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ decision: "approved" });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /leave-requests/:id/cancel", () => {
    it("cancels a pending leave request", async () => {
      const submitRes = await request(app.getHttpServer())
        .post("/leave-requests")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          employeeId: staffEmployeeId,
          leaveType: "annual",
          startDate: "2026-04-20",
          endDate: "2026-04-20",
        });
      const requestId = submitRes.body.request.id;

      const cancelRes = await request(app.getHttpServer())
        .post(`/leave-requests/${requestId}/cancel`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(cancelRes.status).toBe(201);

      const getRes = await request(app.getHttpServer())
        .get(`/leave-requests/${requestId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(getRes.body.status).toBe("cancelled");
    });
  });

  describe("GET /leave-policies", () => {
    it("should list leave policies", async () => {
      const res = await request(app.getHttpServer())
        .get("/leave-policies")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((p: { name: string }) => p.name === "Default Policy")).toBe(true);
    });
  });

  describe("GET /leave-policies/:id/history", () => {
    it("returns one version on creation, and a second after an entitlement change", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/leave-policies")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ name: `History Policy ${Date.now()}`, annualLeaveDays: 12, casualLeaveDays: 6, sickLeaveDays: 6 });
      expect(createRes.status).toBe(201);
      const policyId = createRes.body.id;

      const firstHistoryRes = await request(app.getHttpServer())
        .get(`/leave-policies/${policyId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(firstHistoryRes.status).toBe(200);
      expect(firstHistoryRes.body).toHaveLength(1);
      expect(firstHistoryRes.body[0]).toEqual(
        expect.objectContaining({ policyId, annualLeaveDays: 12, effectiveTo: null })
      );

      // Backdate the open version directly so a same-day entitlement edit
      // deterministically exercises the "close + reopen" branch rather
      // than the same-day collapse branch — same technique the service
      // spec uses.
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "UPDATE leave_policy_versions SET effective_from = CURRENT_DATE - INTERVAL '5 days' WHERE policy_id = $1",
          [policyId]
        )
      );

      const patchRes = await request(app.getHttpServer())
        .patch(`/leave-policies/${policyId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ annualLeaveDays: 18 });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.annualLeaveDays).toBe(18);

      const secondHistoryRes = await request(app.getHttpServer())
        .get(`/leave-policies/${policyId}/history`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(secondHistoryRes.status).toBe(200);
      expect(secondHistoryRes.body).toHaveLength(2);
      expect(secondHistoryRes.body[0]).toEqual(expect.objectContaining({ annualLeaveDays: 12, effectiveTo: expect.any(String) }));
      expect(secondHistoryRes.body[1]).toEqual(expect.objectContaining({ annualLeaveDays: 18, effectiveTo: null }));
    });

    it("404s for a policy that doesn't exist, and denies a caller without leave_policy.manage", async () => {
      const notFoundRes = await request(app.getHttpServer())
        .get("/leave-policies/00000000-0000-0000-0000-000000000000/history")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(notFoundRes.status).toBe(404);

      const listRes = await request(app.getHttpServer())
        .get("/leave-policies")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      const anyPolicyId = listRes.body[0].id;

      const forbiddenRes = await request(app.getHttpServer())
        .get(`/leave-policies/${anyPolicyId}/history`)
        .set("Authorization", `Bearer ${staffToken}`);
      expect(forbiddenRes.status).toBe(403);
    });
  });

  describe("Attendance HTTP surface", () => {
    it("clocks in and out by employee_number, and lists attendance records for the employee", async () => {
      const clockInRes = await request(app.getHttpServer())
        .post("/attendance/clock-in")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ employeeNumber: staffEmployeeNumber, source: "manual" });

      expect(clockInRes.status).toBe(201);
      expect(clockInRes.body.clockOutAt).toBeNull();

      const doubleClockInRes = await request(app.getHttpServer())
        .post("/attendance/clock-in")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ employeeNumber: staffEmployeeNumber, source: "manual" });
      expect(doubleClockInRes.status).toBe(409);

      const clockOutRes = await request(app.getHttpServer())
        .post("/attendance/clock-out")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ employeeNumber: staffEmployeeNumber });
      expect(clockOutRes.status).toBe(201);
      expect(clockOutRes.body.clockOutAt).toBeTruthy();

      const listRes = await request(app.getHttpServer())
        .get(`/employees/${staffEmployeeId}/attendance`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body)).toBe(true);
      expect(listRes.body.length).toBeGreaterThan(0);
    });
  });
});
