import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { payslipDesignPreset } from "@aihxm/shared-types";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payslip-design-e2e-fixtures" };

describe("Payslip print design (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrToken: string;
  let staffToken: string;

  const sign = (sub: string) => jwt.sign({ sub, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query(text, params)).rows as T[]);
  async function createUser(email: string, roleKey: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const id = (await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email])).rows[0].id as string;
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [id, companyId, role.rows[0].id]);
      return id;
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
      const id = (await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Design Co ${stamp}`, `design-${stamp}`])).rows[0].id as string;
      await client.query(`INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, '["employee", "payroll"]'::jsonb)`, [id]);
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'payroll',true)", [id]);
      return id;
    });
    hrToken = sign(await createUser(`design-hr-${stamp}@example.com`, "hr_admin"));
    staffToken = sign(await createUser(`design-staff-${stamp}@example.com`, "employee_self_service"));
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it("a company that never saved a design gets the built-in one, readable by an employee", async () => {
    const res = await http().get("/payroll/payslip-design").set("Authorization", `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.version).toBe(0);
    expect(res.body.design.page.size).toBe("A4");
  });

  it("an employee cannot change or reset the design", async () => {
    expect((await http().put("/payroll/payslip-design").set("Authorization", `Bearer ${staffToken}`).send(payslipDesignPreset("modern"))).status).toBe(403);
    expect((await http().delete("/payroll/payslip-design").set("Authorization", `Bearer ${staffToken}`)).status).toBe(403);
  });

  it("an invalid design is refused with the list of problems and nothing is stored", async () => {
    const bad = { ...payslipDesignPreset("modern"), page: { size: "A3", orientation: "portrait", marginMm: 15 }, colors: { accent: "red", text: "#000000", zebraRows: true } };
    const res = await http().put("/payroll/payslip-design").set("Authorization", `Bearer ${hrToken}`).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.problems.map((p: { path: string }) => p.path).sort()).toEqual(["colors.accent", "page.size"]);
    expect(await sql("SELECT 1 FROM payslip_print_designs WHERE company_id = $1", [companyId])).toHaveLength(0);
  });

  it("HR saves a design, every save raises the version, and the employee then reads it", async () => {
    const first = await http().put("/payroll/payslip-design").set("Authorization", `Bearer ${hrToken}`).send(payslipDesignPreset("modern"));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ isDefault: false, version: 1 });
    expect(first.body.design.header.style).toBe("band");

    const custom = { ...payslipDesignPreset("modern"), watermark: { text: "CONFIDENTIAL", opacityPct: 10 } };
    const second = await http().put("/payroll/payslip-design").set("Authorization", `Bearer ${hrToken}`).send(custom);
    expect(second.body.version).toBe(2);

    const seen = await http().get("/payroll/payslip-design").set("Authorization", `Bearer ${staffToken}`);
    expect(seen.body.design.watermark.text).toBe("CONFIDENTIAL");
    expect(seen.body.version).toBe(2);

    const audit = await sql<{ action: string }>("SELECT action FROM audit_log WHERE company_id = $1 AND action LIKE 'payslip_print_design.%' ORDER BY created_at", [companyId]);
    expect(audit.map((a) => a.action)).toEqual(["payslip_print_design.update", "payslip_print_design.update"]);
  });

  it("resetting goes back to the built-in design and is audited", async () => {
    const res = await http().delete("/payroll/payslip-design").set("Authorization", `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isDefault: true, version: 0 });
    const audit = await sql<{ action: string }>("SELECT action FROM audit_log WHERE company_id = $1 AND action = 'payslip_print_design.reset'", [companyId]);
    expect(audit).toHaveLength(1);
  });

  it("the Configuration Center card appears for HR with a count of 0 or 1", async () => {
    const res = await http().get("/configuration-center").set("Authorization", `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
    const card = res.body.find((c: { domainKey: string }) => c.domainKey === "payslip_print_design");
    expect(card).toBeDefined();
    expect(card.count).toBe(0);
  });
});
