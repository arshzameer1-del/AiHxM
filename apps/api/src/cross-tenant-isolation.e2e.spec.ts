import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "./app.module";
import { DatabaseService } from "./database/database.service";
import type { RequestClaims } from "./database/tenant-context";

/**
 * Cross-Tenant Isolation Security Test Suite
 *
 * CRITICAL P0 ITEM: This suite proves that a user from Company A cannot read,
 * write, or update Company B's data through any API endpoint. This is the top
 * security-adjacent gap from mvp-gate-audit.md Section 8.
 *
 * Each test authenticates as users from two different companies and asserts
 * that access to the other company's records fails with 403 or 404. This
 * exercises Postgres Row Level Security (FORCE ROW LEVEL SECURITY) as the
 * structural backstop — the API-layer RBAC checks that follow are defense
 * in depth, but RLS is the load-bearing guardrail.
 *
 * The RLS policies (user_accounts_select, employees_select, etc.) all have
 * a similar structure:
 *   - For Platform Admin (is_platform_admin = true): unrestricted
 *   - For tenant users: WHERE company_id = current_setting('app.company_id')
 *
 * These tests verify that the WHERE clause actually works by trying to fetch
 * records across the company_id boundary and confirming the access is denied.
 */

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "cross-tenant-isolation-fixtures",
};

function signSession(payload: {
  sub: string;
  is_platform_admin: boolean;
  company_id: string | null;
}): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: "10m",
  });
}

describe("Cross-Tenant Isolation (Security E2E) — Negative tests for tenant boundary enforcement", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  // Company A setup
  let companyAId: string;
  let companyAHrAdminUserId: string;
  let companyAHrAdminToken: string;
  let companyAEmployeeUserId: string;
  let companyAEmployeeToken: string;
  let companyAEmployeeId: string;

  // Company B setup
  let companyBId: string;
  let companyBHrAdminUserId: string;
  let companyBHrAdminToken: string;
  let companyBEmployeeUserId: string;
  let companyBEmployeeToken: string;
  let companyBEmployeeId: string;

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

    const stamp = Date.now();

    // Setup Company A
    companyAId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
        [`Cross-Tenant Test Company A ${stamp}`, `xtt-company-a-${stamp}`]
      );
      const id = company.rows[0].id as string;

      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee","leave","recruitment","performance"]'::jsonb, '{"prefix":"A","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );

      for (const module of [
        "employee",
        "leave",
        "recruitment",
        "performance",
      ]) {
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)",
          [id, module]
        );
      }

      return id;
    });

    // Create Company A's HR Admin
    companyAHrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (
      client
    ) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`xtt-company-a-hr-${stamp}@example.com`]
      );
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [
        "hr_admin",
      ]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [account.rows[0].id, companyAId, role.rows[0].id]
      );
      return account.rows[0].id as string;
    });
    companyAHrAdminToken = signSession({
      sub: companyAHrAdminUserId,
      is_platform_admin: false,
      company_id: companyAId,
    });

    // Create Company A's Employee
    const aEmployeeEmail = `xtt-company-a-emp-${stamp}@example.com`;
    companyAEmployeeId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const emp = await client.query(
        `INSERT INTO employees (company_id, first_name, last_name, email, employment_type, employment_status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [companyAId, "Alice", "CompanyA", aEmployeeEmail, "permanent", "active"]
      );
      return emp.rows[0].id as string;
    });

    companyAEmployeeUserId = await db.withClaims(FIXTURE_CLAIMS, async (
      client
    ) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [aEmployeeEmail]
      );
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [
        "employee_self_service",
      ]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [account.rows[0].id, companyAId, role.rows[0].id]
      );
      return account.rows[0].id as string;
    });
    companyAEmployeeToken = signSession({
      sub: companyAEmployeeUserId,
      is_platform_admin: false,
      company_id: companyAId,
    });

    // Setup Company B (identical pattern)
    companyBId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
        [`Cross-Tenant Test Company B ${stamp}`, `xtt-company-b-${stamp}`]
      );
      const id = company.rows[0].id as string;

      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee","leave","recruitment","performance"]'::jsonb, '{"prefix":"B","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );

      for (const module of [
        "employee",
        "leave",
        "recruitment",
        "performance",
      ]) {
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)",
          [id, module]
        );
      }

      return id;
    });

    companyBHrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (
      client
    ) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`xtt-company-b-hr-${stamp}@example.com`]
      );
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [
        "hr_admin",
      ]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [account.rows[0].id, companyBId, role.rows[0].id]
      );
      return account.rows[0].id as string;
    });
    companyBHrAdminToken = signSession({
      sub: companyBHrAdminUserId,
      is_platform_admin: false,
      company_id: companyBId,
    });

    const bEmployeeEmail = `xtt-company-b-emp-${stamp}@example.com`;
    companyBEmployeeId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const emp = await client.query(
        `INSERT INTO employees (company_id, first_name, last_name, email, employment_type, employment_status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [companyBId, "Bob", "CompanyB", bEmployeeEmail, "permanent", "active"]
      );
      return emp.rows[0].id as string;
    });

    companyBEmployeeUserId = await db.withClaims(FIXTURE_CLAIMS, async (
      client
    ) => {
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [bEmployeeEmail]
      );
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [
        "employee_self_service",
      ]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [account.rows[0].id, companyBId, role.rows[0].id]
      );
      return account.rows[0].id as string;
    });
    companyBEmployeeToken = signSession({
      sub: companyBEmployeeUserId,
      is_platform_admin: false,
      company_id: companyBId,
    });
  });

  afterAll(async () => {
    // Clean up both companies
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyAId]);
      await client.query("DELETE FROM companies WHERE id = $1", [companyBId]);
    });
    await pool.end();
    await app.close();
  });

  describe("Employee Core — cross-tenant access denial", () => {
    it("Company A's HR Admin cannot GET Company B's employees", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${companyBEmployeeId}`)
        .set("Authorization", `Bearer ${companyAHrAdminToken}`);

      // Should return 404 (not found from this company's perspective)
      expect(res.status).toBe(404);
    });

    it("Company A's HR Admin cannot LIST Company B's employees in their list", async () => {
      const res = await request(app.getHttpServer())
        .get("/employees")
        .set("Authorization", `Bearer ${companyAHrAdminToken}`);

      // Should succeed and return employees, but Bob from Company B should not be in the list
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const companyBPresent = res.body.some(
        (e: { id: string }) => e.id === companyBEmployeeId
      );
      expect(companyBPresent).toBe(false);
    });

    it("Company A's HR Admin cannot PATCH Company B's employee", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${companyBEmployeeId}`)
        .set("Authorization", `Bearer ${companyAHrAdminToken}`)
        .send({ firstName: "Hacked" });

      expect(res.status).toBe(404);
    });

    it("Company A's Employee cannot GET Company B's employees", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${companyBEmployeeId}`)
        .set("Authorization", `Bearer ${companyAEmployeeToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe("Leave & Attendance — cross-tenant access denial", () => {
    let companyALeaveRequestId: string;

    beforeAll(async () => {
      // Create a leave request in Company A for isolation testing
      companyALeaveRequestId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const lr = await client.query(
          `INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            companyAId,
            companyAEmployeeId,
            "annual",
            "2026-10-01",
            "2026-10-05",
            "pending",
          ]
        );
        return lr.rows[0].id as string;
      });
    });

    it("Company B's HR Admin cannot GET Company A's leave request", async () => {
      const res = await request(app.getHttpServer())
        .get(`/leave-requests/${companyALeaveRequestId}`)
        .set("Authorization", `Bearer ${companyBHrAdminToken}`);

      expect(res.status).toBe(404);
    });

    it("Company B's HR Admin cannot LIST Company A's leave requests in their list", async () => {
      const res = await request(app.getHttpServer())
        .get("/leave-requests")
        .set("Authorization", `Bearer ${companyBHrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const companyAPresent = res.body.some(
        (lr: { id: string }) => lr.id === companyALeaveRequestId
      );
      expect(companyAPresent).toBe(false);
    });

    it("Company B's HR Admin cannot PATCH Company A's leave request (approve/reject)", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/leave-requests/${companyALeaveRequestId}`)
        .set("Authorization", `Bearer ${companyBHrAdminToken}`)
        .send({ status: "approved" });

      expect(res.status).toBe(404);
    });

    it("Company A's Employee cannot see Company B's leave requests when listing", async () => {
      // First, create a leave request in Company B
      const companyBLeaveRequestId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const lr = await client.query(
          `INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            companyBId,
            companyBEmployeeId,
            "sick",
            "2026-10-10",
            "2026-10-12",
            "pending",
          ]
        );
        return lr.rows[0].id as string;
      });

      const res = await request(app.getHttpServer())
        .get("/leave-requests")
        .set("Authorization", `Bearer ${companyAEmployeeToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const companyBPresent = res.body.some(
        (lr: { id: string }) => lr.id === companyBLeaveRequestId
      );
      expect(companyBPresent).toBe(false);
    });
  });

  describe("Recruitment — cross-tenant access denial", () => {
    let companyARequisitionId: string;
    let companyBRequisitionId: string;

    beforeAll(async () => {
      companyARequisitionId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const req = await client.query(
          `INSERT INTO requisitions (company_id, title, department, status)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [companyAId, "Senior Engineer", "Engineering", "open"]
        );
        return req.rows[0].id as string;
      });

      companyBRequisitionId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const req = await client.query(
          `INSERT INTO requisitions (company_id, title, department, status)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [companyBId, "Sales Manager", "Sales", "open"]
        );
        return req.rows[0].id as string;
      });
    });

    it("Company A's HR Admin cannot GET Company B's requisition", async () => {
      const res = await request(app.getHttpServer())
        .get(`/requisitions/${companyBRequisitionId}`)
        .set("Authorization", `Bearer ${companyAHrAdminToken}`);

      expect(res.status).toBe(404);
    });

    it("Company A's HR Admin cannot LIST Company B's requisitions in their list", async () => {
      const res = await request(app.getHttpServer())
        .get("/requisitions")
        .set("Authorization", `Bearer ${companyAHrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const companyBPresent = res.body.some(
        (r: { id: string }) => r.id === companyBRequisitionId
      );
      expect(companyBPresent).toBe(false);
    });

    it("Company B's HR Admin cannot PATCH Company A's requisition", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/requisitions/${companyARequisitionId}`)
        .set("Authorization", `Bearer ${companyBHrAdminToken}`)
        .send({ status: "closed" });

      expect(res.status).toBe(404);
    });
  });

  describe("Performance & Goals — cross-tenant access denial", () => {
    let companyAReviewCycleId: string;
    let companyBReviewCycleId: string;

    beforeAll(async () => {
      companyAReviewCycleId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const cycle = await client.query(
          `INSERT INTO review_cycles (company_id, name, status, period_start, period_end)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            companyAId,
            "Q4 2026 Review",
            "active",
            "2026-10-01",
            "2026-12-31",
          ]
        );
        return cycle.rows[0].id as string;
      });

      companyBReviewCycleId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const cycle = await client.query(
          `INSERT INTO review_cycles (company_id, name, status, period_start, period_end)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            companyBId,
            "H2 2026 Review",
            "draft",
            "2026-07-01",
            "2026-12-31",
          ]
        );
        return cycle.rows[0].id as string;
      });
    });

    it("Company A's HR Admin cannot GET Company B's review cycle", async () => {
      const res = await request(app.getHttpServer())
        .get(`/review-cycles/${companyBReviewCycleId}`)
        .set("Authorization", `Bearer ${companyAHrAdminToken}`);

      expect(res.status).toBe(404);
    });

    it("Company A's HR Admin cannot LIST Company B's review cycles in their list", async () => {
      const res = await request(app.getHttpServer())
        .get("/review-cycles")
        .set("Authorization", `Bearer ${companyAHrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const companyBPresent = res.body.some(
        (c: { id: string }) => c.id === companyBReviewCycleId
      );
      expect(companyBPresent).toBe(false);
    });

    it("Company B's HR Admin cannot PATCH Company A's review cycle", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/review-cycles/${companyAReviewCycleId}`)
        .set("Authorization", `Bearer ${companyBHrAdminToken}`)
        .send({ status: "closed" });

      expect(res.status).toBe(404);
    });
  });

  describe("Platform Admin isolation — Platform Admins still cannot access tenant data", () => {
    let platformAdminUserId: string;
    let platformAdminToken: string;

    beforeAll(async () => {
      // Create a Platform Admin user
      platformAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (
        client
      ) => {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [`xtt-platform-admin-${Date.now()}@example.com`]
        );
        await client.query(
          "INSERT INTO platform_admins (full_name, email, user_account_id) VALUES ($1, $2, $3)",
          ["Isolation Test Admin", account.rows[0].email, account.rows[0].id]
        );
        return account.rows[0].id as string;
      });

      // Platform Admin token has company_id = null
      platformAdminToken = signSession({
        sub: platformAdminUserId,
        is_platform_admin: true,
        company_id: null,
      });
    });

    it("Platform Admin with company_id=null cannot access tenant API endpoints (employees)", async () => {
      const res = await request(app.getHttpServer())
        .get("/employees")
        .set("Authorization", `Bearer ${platformAdminToken}`);

      // Should fail because Platform Admin's session has company_id=null,
      // and tenant endpoints require a valid company_id in the session
      expect(res.status).toBe(401);
    });

    it("Platform Admin cannot GET a Company A employee", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${companyAEmployeeId}`)
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(res.status).toBe(401);
    });
  });
});
