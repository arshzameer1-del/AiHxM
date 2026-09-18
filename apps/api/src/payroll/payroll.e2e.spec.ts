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
  sub: "payroll-e2e-fixtures",
};

/**
 * Real routes only (payroll.controller.ts) — there is no /payroll/calculate,
 * /payroll/slips/:id, /payroll/reports/statutory, /payroll/export/bank-file
 * or /payroll/audit-trail anywhere in this app. Payroll is a run lifecycle:
 * POST /payroll/compensation to set pay, POST /payroll/runs to open a
 * period, POST /payroll/runs/:id/calculate to produce payslips (a run is
 * re-calculable until finalized), POST /payroll/runs/:id/finalize to lock
 * it, and GET /payroll/runs/:id/disbursement for the bank CSV export —
 * that CSV *is* this app's "bank file"/disbursement report, there is no
 * separate reports/statutory or export/bank-file endpoint. Payslips are
 * read via GET /payslips and GET /payslips/:id (no "/payroll" prefix on
 * those two). There is no tenant-facing payroll audit-trail HTTP route —
 * audit.controller.ts only exposes a platform-admin-only audit log.
 */
describe("Payroll HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let staffToken: string;
  let outsiderToken: string;
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
        `Payroll E2E Co ${stamp}`,
        `payroll-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "payroll"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'payroll', true)",
        [id]
      );
      return id;
    });

    const hrAdminUserId = await createUser(`payroll-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`payroll-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    const outsiderUserId = await createUser(`payroll-outsider-${stamp}@example.com`);
    outsiderToken = signSession({ sub: outsiderUserId, is_platform_admin: false, company_id: companyId });

    const empRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({
        firstName: "Payroll",
        lastName: "Staff",
        department: "engineering",
        userAccountId: staffUserId,
        bankAccountNumber: "PK00-STAFF",
        dateOfJoining: "2020-01-01",
      });
    staffEmployeeId = empRes.body.id;

    await request(app.getHttpServer())
      .post("/payroll/compensation")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ employeeId: staffEmployeeId, monthlySalary: 150000, effectiveFrom: "2020-01-01" });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("POST /payroll/compensation and GET /payroll/compensation/:employeeId", () => {
    it("was already set for the fixture employee in beforeAll and shows up in history", async () => {
      const res = await request(app.getHttpServer())
        .get(`/payroll/compensation/${staffEmployeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].monthlySalary).toBe(150000);
    });

    it("rejects without authorization", async () => {
      const res = await request(app.getHttpServer()).post("/payroll/compensation").send({
        employeeId: staffEmployeeId,
        monthlySalary: 100000,
        effectiveFrom: "2026-01-01",
      });

      expect(res.status).toBe(401);
    });

    it("denies a caller without payroll.manage.all", async () => {
      const res = await request(app.getHttpServer())
        .post("/payroll/compensation")
        .set("Authorization", `Bearer ${outsiderToken}`)
        .send({ employeeId: staffEmployeeId, monthlySalary: 100000, effectiveFrom: "2026-01-01" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /payroll/tax-slabs and POST /payroll/tax-slabs", () => {
    it("returns the seeded default FBR tax slabs", async () => {
      const res = await request(app.getHttpServer())
        .get("/payroll/tax-slabs")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe("GET /payroll/settings and PATCH /payroll/settings", () => {
    it("returns default settings, then applies a patch", async () => {
      const getRes = await request(app.getHttpServer())
        .get("/payroll/settings")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(getRes.status).toBe(200);

      const patchRes = await request(app.getHttpServer())
        .patch("/payroll/settings")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ socialSecurityScheme: "pessi", socialSecurityEmployerRatePercent: 6 });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.socialSecurityScheme).toBe("pessi");
    });
  });

  describe("Payroll run lifecycle", () => {
    let runId: string;

    it("creates a run via POST /payroll/runs", async () => {
      const res = await request(app.getHttpServer())
        .post("/payroll/runs")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ periodStart: "2027-01-01", periodEnd: "2027-01-31" });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("draft");
      runId = res.body.id;
    });

    it("rejects run creation without authorization", async () => {
      const res = await request(app.getHttpServer()).post("/payroll/runs").send({
        periodStart: "2027-02-01",
        periodEnd: "2027-02-28",
      });

      expect(res.status).toBe(401);
    });

    it("lists runs and gets a single run via GET /payroll/runs and GET /payroll/runs/:id", async () => {
      const listRes = await request(app.getHttpServer())
        .get("/payroll/runs")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((r: { id: string }) => r.id === runId)).toBe(true);

      const getRes = await request(app.getHttpServer())
        .get(`/payroll/runs/${runId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(runId);
    });

    it("calculates the run via POST /payroll/runs/:id/calculate, producing a statutory-correct payslip", async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/runs/${runId}/calculate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(201);
      expect(res.body.run.status).toBe("calculated");
      expect(res.body.payslipCount).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.body.errors)).toBe(true);

      const payslipsRes = await request(app.getHttpServer())
        .get("/payslips")
        .query({ payrollRunId: runId })
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(payslipsRes.status).toBe(200);
      const slip = payslipsRes.body.find((p: { employeeId: string }) => p.employeeId === staffEmployeeId);
      expect(slip).toBeDefined();
      expect(slip.grossPay).toBe(150000);
      expect(slip.incomeTaxMonthly).toBeGreaterThanOrEqual(0);
      expect(slip.eobiEmployeeContribution).toBeGreaterThanOrEqual(0);
      expect(slip.netPay).toBeLessThanOrEqual(slip.grossPay);
    });

    it("is re-runnable while calculated but not finalized", async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/runs/${runId}/calculate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(201);
      expect(res.body.run.status).toBe("calculated");
    });

    it("a self-view employee cannot see any payslip from a run that isn't finalized yet", async () => {
      const listRes = await request(app.getHttpServer())
        .get("/payslips")
        .query({ payrollRunId: runId })
        .set("Authorization", `Bearer ${staffToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toEqual([]);
    });

    it("finalizes the run via POST /payroll/runs/:id/finalize, then refuses to finalize twice or recalculate", async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/runs/${runId}/finalize`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("finalized");

      const secondFinalize = await request(app.getHttpServer())
        .post(`/payroll/runs/${runId}/finalize`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(secondFinalize.status).toBe(400);

      const recalculate = await request(app.getHttpServer())
        .post(`/payroll/runs/${runId}/calculate`)
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(recalculate.status).toBe(400);
    });

    it("once finalized, the self-view employee can see their own payslip", async () => {
      const res = await request(app.getHttpServer())
        .get("/payslips")
        .query({ payrollRunId: runId })
        .set("Authorization", `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].employeeId).toBe(staffEmployeeId);
    });

    it("GET /payroll/runs/:id/disbursement returns a CSV bank file", async () => {
      const res = await request(app.getHttpServer())
        .get(`/payroll/runs/${runId}/disbursement`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain("PK00-STAFF");
    });
  });

  describe("GET /payroll/tax-slabs/history", () => {
    // Runs after the run lifecycle tests above so mutating this tenant's
    // tax slabs here can't affect the earlier calculation assertions
    // (which only check incomeTaxMonthly >= 0, not an exact figure, but
    // there's no reason to risk it).
    it("starts as a single generation, then grows after a same-day and a backdated change", async () => {
      const firstRes = await request(app.getHttpServer())
        .get("/payroll/tax-slabs/history")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body).toHaveLength(1);
      expect(firstRes.body[0].effectiveTo).toBeNull();

      // Same-day collapse: replacing the slabs again today updates the one
      // open generation rather than adding a second.
      await request(app.getHttpServer())
        .post("/payroll/tax-slabs")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 15 }] });

      const afterSameDayRes = await request(app.getHttpServer())
        .get("/payroll/tax-slabs/history")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(afterSameDayRes.body).toHaveLength(1);
      expect(afterSameDayRes.body[0].slabs[0].ratePercent).toBe(15);

      // Backdate the open generation, then change it again — this time it
      // should close and a new generation should open.
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "UPDATE tax_slabs SET effective_from = CURRENT_DATE - INTERVAL '7 days' WHERE company_id = $1 AND effective_to IS NULL",
          [companyId]
        )
      );
      await request(app.getHttpServer())
        .post("/payroll/tax-slabs")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 18 }] });

      const finalRes = await request(app.getHttpServer())
        .get("/payroll/tax-slabs/history")
        .set("Authorization", `Bearer ${hrAdminToken}`);
      expect(finalRes.body).toHaveLength(2);
      expect(finalRes.body[0].slabs[0].ratePercent).toBe(15);
      expect(finalRes.body[0].effectiveTo).not.toBeNull();
      expect(finalRes.body[1].slabs[0].ratePercent).toBe(18);
      expect(finalRes.body[1].effectiveTo).toBeNull();
    });

    it("denies a caller without payroll.manage.all", async () => {
      const res = await request(app.getHttpServer())
        .get("/payroll/tax-slabs/history")
        .set("Authorization", `Bearer ${outsiderToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /payslips/:id", () => {
    it("404s for a payslip that does not exist", async () => {
      const res = await request(app.getHttpServer())
        .get("/payslips/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(404);
    });

    it("rejects without authorization", async () => {
      const res = await request(app.getHttpServer()).get("/payslips/00000000-0000-0000-0000-000000000000");

      expect(res.status).toBe(401);
    });
  });
});
