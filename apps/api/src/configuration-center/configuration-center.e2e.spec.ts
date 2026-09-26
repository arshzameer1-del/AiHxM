import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "config-center-e2e-fixtures" };

/** Real route only (configuration-center.controller.ts): GET /configuration-center. */
describe("Configuration Center HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
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
        `Config Center E2E Co ${stamp}`,
        `config-center-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave", "payroll"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        `INSERT INTO tenant_module_entitlement (company_id, module_key, enabled)
         VALUES ($1, 'employee', true), ($1, 'leave', true), ($1, 'payroll', true)`,
        [id]
      );
      return id;
    });

    const hrAdminUserId = await createUser(`config-center-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await createUser(`config-center-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await app.close();
    await pool.end();
  });

  it("rejects an unauthenticated request", async () => {
    await request(app.getHttpServer()).get("/configuration-center").expect(401);
  });

  it("returns hr_admin's manageable domains with real, deep-linkable admin routes", async () => {
    const res = await request(app.getHttpServer())
      .get("/configuration-center")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(200);

    const domainKeys = res.body.map((row: { domainKey: string }) => row.domainKey);
    expect(domainKeys).toEqual(
      expect.arrayContaining(["leave_policy", "employee_group", "shift", "holiday", "tax_slab", "org_unit"])
    );
    // hr_admin does not hold workflow_template.manage.all (System Admin's job).
    expect(domainKeys).not.toContain("workflow_template");

    const holidayRow = res.body.find((row: { domainKey: string }) => row.domainKey === "holiday");
    expect(holidayRow.adminRoute).toBe("/app/admin?tab=holidays");
    expect(typeof holidayRow.count).toBe("number");

    // Organization Management Phase 1's Configuration Center registration
    // (0067_configuration_center_org_units.sql) — proves the real HTTP
    // route surfaces the new card with its real admin route and a live
    // count, not just that the service method does.
    const orgUnitRow = res.body.find((row: { domainKey: string }) => row.domainKey === "org_unit");
    expect(orgUnitRow).toBeDefined();
    expect(orgUnitRow.adminRoute).toBe("/app/organization");
    expect(orgUnitRow.supportsEffectiveDating).toBe(true);
    expect(typeof orgUnitRow.count).toBe("number");

    // Organization Management Phase 2's Configuration Center registration
    // (0070_configuration_center_job.sql) — proves the real HTTP route
    // surfaces the Job Catalog card with its real admin route and a live
    // count. Position deliberately never appears (0070's own header
    // comment — operational data, not a setup catalog).
    const jobRow = res.body.find((row: { domainKey: string }) => row.domainKey === "job");
    expect(jobRow).toBeDefined();
    expect(jobRow.adminRoute).toBe("/app/organization/jobs");
    expect(jobRow.supportsEffectiveDating).toBe(true);
    expect(typeof jobRow.count).toBe("number");
    expect(domainKeys).not.toContain("position");
  });

  it("returns a narrower list for a plain employee_self_service login", async () => {
    const res = await request(app.getHttpServer())
      .get("/configuration-center")
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);

    const domainKeys = res.body.map((row: { domainKey: string }) => row.domainKey);
    expect(domainKeys).not.toContain("leave_policy");
    expect(domainKeys).not.toContain("tax_slab");
    // holiday.view.all is deliberately granted broadly to every role
    // (Holiday Management's own design) -- staff legitimately still see it.
    expect(domainKeys).toContain("holiday");
  });
});
