import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeesService } from "../employees/employees.service";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { WorkflowService } from "../workflow/workflow.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";

/**
 * Phase 9's exit criterion, verified the extra way its own plan doc entry
 * calls for on top of the service-level integration tests
 * (leave-requests.service.spec.ts): real HTTP, through the actual guards/
 * controllers/ValidationPipe stack (supertest against a real Nest
 * application), not just direct service calls. Same signed-JWT-instead-
 * of-real-login shortcut dummy.e2e.spec.ts already established for Phase
 * 4 (AuthService's own login mechanics are proven elsewhere) — this
 * file's job is proving the leave/attendance HTTP surface end to end:
 * submit -> manager approval -> balance decrement, and a real
 * clock-in/clock-out round trip, all over the wire.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "leave-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Leave & Attendance HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let groups: EmployeeGroupsService;
  let workflow: WorkflowService;

  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let staffToken: string;

  let managerEmployeeId: string;
  let staffEmployeeId: string;
  let staffEmployeeNumber: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // main.ts's own global pipe isn't applied automatically by
    // createNestApplication() in a test module — registered explicitly
    // here so the third test below (invalid leaveType) actually exercises
    // real DTO validation over HTTP, not just the controller/service.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, new LocalFileStorageService());
    groups = new EmployeeGroupsService(db, rbac, entitlements);
    workflow = new WorkflowService(db, rbac, audit);

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
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

    async function makeUser(email: string): Promise<string> {
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
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      });
    }

    const hrAdminUserId = await makeUser(`leave-e2e-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access"); // workflow_template.manage.all, to configure the approval workflow below
    const hrAdminClaims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const managerUserId = await makeUser(`leave-e2e-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");

    const staffUserId = await makeUser(`leave-e2e-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");

    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    managerEmployeeId = (
      await employees.create(hrAdminClaims, { firstName: "Mona", lastName: "Manager", userAccountId: managerUserId })
    ).id;
    const staffEmployee = await employees.create(hrAdminClaims, {
      firstName: "Sana",
      lastName: "Staff",
      managerId: managerEmployeeId,
      userAccountId: staffUserId,
    });
    staffEmployeeId = staffEmployee.id;
    staffEmployeeNumber = staffEmployee.employeeNumber;

    await groups.createLeavePolicy(hrAdminClaims, {
      name: "E2E Default Policy",
      annualLeaveDays: 12,
      casualLeaveDays: 8,
      sickLeaveDays: 6,
      isDefault: true,
    });

    await workflow.createTemplate(hrAdminClaims, {
      key: "leave_request",
      name: "Leave Approval",
      objectKey: "leave_request",
      steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  it("real HTTP round trip: submit -> manager approves -> balance decrements, all through the actual controllers/guards", async () => {
    const submitResponse = await request(app.getHttpServer())
      .post("/leave-requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, leaveType: "annual", startDate: "2026-11-10", endDate: "2026-11-12" })
      .expect(201);

    expect(submitResponse.body.request.status).toBe("pending");
    expect(submitResponse.body.request.daysRequested).toBe(3);
    const leaveRequestId = submitResponse.body.request.id;

    // The employee themselves cannot decide their own request.
    await request(app.getHttpServer())
      .patch(`/leave-requests/${leaveRequestId}/decision`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ decision: "approved" })
      .expect(403);

    const decideResponse = await request(app.getHttpServer())
      .patch(`/leave-requests/${leaveRequestId}/decision`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ decision: "approved", comment: "Enjoy!" })
      .expect(200);
    expect(decideResponse.body.status).toBe("approved");

    const balancesResponse = await request(app.getHttpServer())
      .get(`/employees/${staffEmployeeId}/leave-balances`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(200);
    const annual = balancesResponse.body.find((b: { leaveType: string }) => b.leaveType === "annual");
    expect(annual.usedDays).toBe(3);
    expect(annual.remainingDays).toBe(9);
  });

  it("real HTTP clock-in/clock-out round trip, including the already-clocked-in conflict", async () => {
    const clockInResponse = await request(app.getHttpServer())
      .post("/attendance/clock-in")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeNumber: staffEmployeeNumber, source: "manual" })
      .expect(201);
    expect(clockInResponse.body.clockOutAt).toBeNull();

    await request(app.getHttpServer())
      .post("/attendance/clock-in")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeNumber: staffEmployeeNumber, source: "manual" })
      .expect(409);

    const clockOutResponse = await request(app.getHttpServer())
      .post("/attendance/clock-out")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeNumber: staffEmployeeNumber })
      .expect(201);
    expect(clockOutResponse.body.clockOutAt).not.toBeNull();
  });

  it("a request with an invalid leaveType is rejected by the ValidationPipe before it ever reaches the service", async () => {
    await request(app.getHttpServer())
      .post("/leave-requests")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ employeeId: staffEmployeeId, leaveType: "not-a-real-type", startDate: "2026-12-01", endDate: "2026-12-01" })
      .expect(400);
  });
});
