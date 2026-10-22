import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employees-login-roles-fixtures" };

/**
 * Who may hand out which roles when a login is created: HR Admin gives the ordinary roles; System Admin and Payroll Approver
 * are given by a System Admin. Exception: while a company has no System Admin yet, HR Admin may create the first one.
 */
describe("Creating a login: privileged roles (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrToken: string;
  let sysToken: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const sign = (sub: string) => jwt.sign({ sub, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });

  async function user(email: string, roleKey: string | null): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
      if (roleKey) {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [u.rows[0].id, companyId, role.rows[0].id]);
      }
      return u.rows[0].id as string;
    });
  }

  async function newEmployee(token: string, label: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .send({
        firstName: label,
        lastName: "Login",
        email: `${label}-${stamp}@example.com`,
        phone: "+92-300-1234567",
        dateOfBirth: "1990-01-15",
        department: "engineering",
        designation: "Analyst",
        employmentType: "permanent",
        dateOfJoining: new Date().toISOString().split("T")[0],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  const makeLogin = (token: string, employeeId: string, roleKeys: string[]) =>
    request(app.getHttpServer()).post(`/employees/${employeeId}/account`).set("Authorization", `Bearer ${token}`).send({ initialPassword: "Password@123456789", roleKeys });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1,$2,'active') RETURNING id", [`Login Roles Co ${stamp}`, `login-roles-${stamp}`]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
    hrToken = sign(await user(`login-roles-hr-${stamp}@example.com`, "hr_admin"));
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("HR Admin gives ordinary roles", async () => {
    const id = await newEmployee(hrToken, "ordinary");
    const res = await makeLogin(hrToken, id, ["employee_self_service", "line_manager"]);
    expect(res.status).toBe(201);
  });

  it("HR Admin cannot give Payroll Approver", async () => {
    const id = await newEmployee(hrToken, "approver");
    const res = await makeLogin(hrToken, id, ["employee_self_service", "payroll_approver"]);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/System Admin/);
  });

  it("HR Admin can create the company's first System Admin, but not a second one", async () => {
    const first = await newEmployee(hrToken, "firstsys");
    const ok = await makeLogin(hrToken, first, ["system_admin"]);
    expect(ok.status).toBe(201);

    const second = await newEmployee(hrToken, "secondsys");
    const refused = await makeLogin(hrToken, second, ["system_admin"]);
    expect(refused.status).toBe(403);
  });

  it("a System Admin can give System Admin and Payroll Approver", async () => {
    const sysUser = await user(`login-roles-sys-${stamp}@example.com`, "system_admin");
    sysToken = sign(sysUser);
    const id = await newEmployee(hrToken, "bysys");
    const res = await makeLogin(sysToken, id, ["employee_self_service", "payroll_approver", "system_admin"]);
    expect(res.status).toBe(201);
  });
});
