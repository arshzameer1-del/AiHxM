import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "lifecycle-e2e-fixtures" };

/**
 * Cross-module integration audit Item 4 (2026-10-01) — the lifecycle
 * reason catalogs reached through the REAL HTTP surface. Until the
 * lifecycle DTOs declared `reasonCode`, the global ValidationPipe
 * (`whitelist` + `forbidNonWhitelisted`, mirrored here exactly as main.ts
 * configures it) rejected every request carrying one with a 400 before
 * the service ever ran, so `HrReferenceCatalogService.validateActiveCode()`
 * was only reachable from unit tests. These go through the controller,
 * the DTO, Nest's real DI (which wires the catalog service in), and the
 * catalog itself.
 */
describe("Employee lifecycle HTTP surface — reasonCode (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let orgUnitId: string;

  function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
    return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
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
        `Lifecycle E2E Co ${stamp}`,
        `lifecycle-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      const unit = await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Treasury') RETURNING id", [id]);
      orgUnitId = unit.rows[0].id;
      return id;
    });

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const user = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `lifecycle-e2e-hr-${stamp}@example.com`,
      ]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        user.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return user.rows[0].id as string;
    });
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  async function createEmployee(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Reason", lastName: `Code-${Math.random().toString(36).slice(2, 8)}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("POST /employees/:id/transfer accepts an active catalog reasonCode and records it on the job history row", async () => {
    const employeeId = await createEmployee();
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/transfer`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ orgUnitId, effectiveDate: "2026-10-01", reasonCode: "business_need" });
    expect(res.status).toBe(201);
    expect(res.body.jobHistory.reasonCode).toBe("business_need");

    const stored = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
      (await client.query("SELECT reason_code FROM employee_job_history WHERE id = $1", [res.body.jobHistory.id])).rows[0]
    );
    expect(stored.reason_code).toBe("business_need");
  });

  it("rejects a reasonCode that is not an active item of that transaction's catalog — validated by the catalog, not the DTO", async () => {
    const employeeId = await createEmployee();
    const historyCount = async () =>
      db.withClaims(FIXTURE_CLAIMS, async (client) =>
        (await client.query("SELECT count(*)::int AS c FROM employee_job_history WHERE employee_id = $1", [employeeId])).rows[0].c as number
      );
    const before = await historyCount();
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/transfer`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ orgUnitId, effectiveDate: "2026-10-01", reasonCode: "not_a_real_reason" });
    expect(res.status).toBe(400);
    // The catalog's own message — proves the request got past the DTO
    // whitelist and was rejected by HrReferenceCatalogService.
    expect(JSON.stringify(res.body.message)).toContain("not a valid, active Transfer Reasons value");

    // Nothing written: no transfer history row, org unit unchanged.
    expect(await historyCount()).toBe(before);
  });

  it("a code valid for one transaction's catalog is rejected by another's (terminate uses lifecycle_reason:termination)", async () => {
    const employeeId = await createEmployee();
    const wrongCatalog = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/terminate`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ terminationDate: "2026-10-31", reasonCode: "business_need" });
    expect(wrongCatalog.status).toBe(400);

    const ok = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/terminate`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ terminationDate: "2026-10-31", reasonCode: "resignation" });
    expect(ok.status).toBe(201);
    expect(ok.body.jobHistory.reasonCode).toBe("resignation");
  });

  it("stays backward compatible: omitting reasonCode still succeeds with a null code", async () => {
    const employeeId = await createEmployee();
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/promote`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ designation: "Senior Analyst", effectiveDate: "2026-10-01" });
    expect(res.status).toBe(201);
    expect(res.body.jobHistory.reasonCode).toBeNull();
  });
});
