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
  sub: "employees-e2e-fixtures",
};

/**
 * Real routes only (employees.controller.ts): POST /employees, GET
 * /employees, GET /employees/org-chart, GET /employees/:id, PATCH
 * /employees/:id, POST /employees/:id/account, plus the document-vault
 * and job-history sub-resources covered elsewhere. There is no DELETE
 * /employees/:id and no POST /employees/:id/assign-manager — "soft
 * delete" is PATCH { employmentStatus: "terminated", terminationDate }
 * (employees.service.ts's update()), and manager assignment is just
 * managerId on create/update. CreateEmployeeDto/UpdateEmployeeDto's real
 * field names are firstName/lastName/email/phone/department/designation
 * (not jobTitle)/employmentType/managerId/dateOfJoining (not joinDate) —
 * email has no format validation (@IsString() only), so an "invalid
 * email" case isn't a 400 here.
 */
describe("Employees HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;

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
        `Employees E2E Co ${stamp}`,
        `employees-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
      return id;
    });

    const hrAdminUserId = await createUser(`employees-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe("GET /employees", () => {
    it("should list employees for HR admin", async () => {
      const res = await request(app.getHttpServer())
        .get("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("should reject without authorization", async () => {
      const res = await request(app.getHttpServer()).get("/employees");

      expect(res.status).toBe(401);
    });
  });

  describe("POST /employees", () => {
    it("should create employee", async () => {
      const timestamp = Date.now();
      const res = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "John",
          lastName: "Doe",
          email: `employee-${timestamp}@example.com`,
          phone: "+92-300-1234567",
          dateOfBirth: "1990-01-15",
          department: "engineering",
          designation: "Software Engineer",
          employmentType: "permanent",
          dateOfJoining: new Date().toISOString().split("T")[0],
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.firstName).toBe("John");
      expect(res.body.email).toBe(`employee-${timestamp}@example.com`);
      expect(res.body.employeeNumber).toBeDefined();
    });

    it("should reject creation with missing required fields", async () => {
      const res = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Jane",
          // Missing lastName (the only other required field).
        });

      expect(res.status).toBe(400);
    });

    it("should reject creation with an invalid employmentType", async () => {
      const res = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Jane",
          lastName: "Doe",
          department: "engineering",
          designation: "Engineer",
          employmentType: "not-a-real-type",
        });

      expect(res.status).toBe(400);
    });

    it("rejects without authorization", async () => {
      const res = await request(app.getHttpServer()).post("/employees").send({
        firstName: "No",
        lastName: "Session",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /employees/:id", () => {
    let employeeId: string;

    beforeAll(async () => {
      const createRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Get",
          lastName: "Employee",
          email: `get-employee-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
        });

      employeeId = createRes.body.id;
    });

    it("should get employee detail", async () => {
      const res = await request(app.getHttpServer())
        .get(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(employeeId);
      expect(res.body.firstName).toBe("Get");
    });

    it("should reject without authorization", async () => {
      const res = await request(app.getHttpServer()).get(`/employees/${employeeId}`);

      expect(res.status).toBe(401);
    });

    it("404s for an employee id that doesn't exist", async () => {
      const res = await request(app.getHttpServer())
        .get("/employees/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /employees/:id", () => {
    let employeeId: string;

    beforeAll(async () => {
      const createRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Update",
          lastName: "Employee",
          email: `update-employee-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
        });

      employeeId = createRes.body.id;
    });

    it("should update employee details", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          department: "sales",
          designation: "Sales Manager",
        });

      expect(res.status).toBe(200);
      expect(res.body.department).toBe("sales");
      expect(res.body.designation).toBe("Sales Manager");
    });

    it("should reject update without authorization", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${employeeId}`)
        .send({
          department: "hr",
        });

      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /employees/:id — soft delete via termination", () => {
    let employeeId: string;

    beforeAll(async () => {
      const createRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Terminate",
          lastName: "Employee",
          email: `terminate-employee-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
        });

      employeeId = createRes.body.id;
    });

    it("requires a terminationDate when setting employmentStatus to terminated", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ employmentStatus: "terminated" });

      expect(res.status).toBe(400);
    });

    it("terminates an employee (the app's soft-delete) rather than removing the row", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          employmentStatus: "terminated",
          terminationDate: new Date().toISOString().split("T")[0],
        });

      expect(res.status).toBe(200);
      expect(res.body.employmentStatus).toBe("terminated");

      // Still retrievable by id — termination is a status change, not a deletion.
      const getRes = await request(app.getHttpServer())
        .get(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.employmentStatus).toBe("terminated");
    });
  });

  describe("manager assignment (managerId on create/update)", () => {
    it("assigns a manager to an employee via PATCH managerId", async () => {
      const mgrRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Manager",
          lastName: "User",
          email: `mgr-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineering Manager",
          employmentType: "permanent",
        });
      const managerId = mgrRes.body.id;

      const empRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Employee",
          lastName: "WithManager",
          email: `emp-mgr-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
        });
      const employeeId = empRes.body.id;

      const res = await request(app.getHttpServer())
        .patch(`/employees/${employeeId}`)
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({ managerId });

      expect(res.status).toBe(200);
      expect(res.body.managerId).toBe(managerId);
    });

    it("accepts managerId directly at creation time", async () => {
      const mgrRes = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Manager",
          lastName: "AtCreate",
          email: `mgr-create-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineering Manager",
          employmentType: "permanent",
        });
      const managerId = mgrRes.body.id;

      const res = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${hrAdminToken}`)
        .send({
          firstName: "Direct",
          lastName: "Report",
          email: `direct-report-${Date.now()}@example.com`,
          department: "engineering",
          designation: "Engineer",
          employmentType: "permanent",
          managerId,
        });

      expect(res.status).toBe(201);
      expect(res.body.managerId).toBe(managerId);
    });
  });

  describe("GET /employees/org-chart", () => {
    it("returns the company org chart", async () => {
      const res = await request(app.getHttpServer())
        .get("/employees/org-chart")
        .set("Authorization", `Bearer ${hrAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
