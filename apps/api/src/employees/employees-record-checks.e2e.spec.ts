import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "record-checks-fixtures" };

/**
 * The smaller employee records (education, qualifications, family, contacts, addresses, languages, disciplinary notices, assets,
 * important dates, extra payments, documents) go through the real HTTP surface. Each hostile input must come back as a 400 that says
 * what is wrong (several used to be a 500 from a database constraint, or were simply saved), and a sensible input must still work.
 */
describe("Employee record checks (HTTP)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let token: string;
  let employeeId: string;

  const post = (path: string, body: object, method: "post" | "put" | "patch" = "post") =>
    request(app.getHttpServer())[method](path).set("Authorization", `Bearer ${token}`).send({ employeeId, ...body });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Record Checks Co ${stamp}`, `record-checks-${stamp}`]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
    const userId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const user = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`record-checks-hr-${stamp}@example.com`]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [user.rows[0].id, companyId, role.rows[0].id]);
      return user.rows[0].id as string;
    });
    token = jwt.sign({ sub: userId, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });
    const created = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Record", lastName: "Checks", dateOfJoining: "2024-03-01", dateOfBirth: "1990-01-01" });
    expect(created.status).toBe(201);
    employeeId = created.body.id;
  }, 120000);

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  const refused: Array<[string, string, object, string]> = [
    ["education: end before start", "/employees/education", { degreeTitle: "BS", startDate: "2020-01-01", endDate: "2015-01-01" }, "end date cannot be before"],
    ["education: year 1800", "/employees/education", { degreeTitle: "BS", startDate: "1800-01-01" }, "too far in the past"],
    ["education: blank title", "/employees/education", { degreeTitle: "   " }, "cannot be empty"],
    ["qualification: expiry before issue", "/employees/qualifications", { qualificationType: "license", title: "Driving", issueDate: "2024-01-01", expiryDate: "2020-01-01" }, "expiry date cannot be before"],
    ["qualification: blank title", "/employees/qualifications", { qualificationType: "skill", title: " " }, "cannot be empty"],
    ["family: born in the future", "/employees/family-members", { relationship: "child", fullName: "Kid", dateOfBirth: "2090-01-01" }, "cannot be in the future"],
    ["family: blank name", "/employees/family-members", { relationship: "child", fullName: "  " }, "cannot be empty"],
    ["contact: bad email", "/employees/contacts", { contactType: "personal_email", value: "not-an-email" }, "Email does not look right"],
    ["contact: phone with letters", "/employees/contacts", { contactType: "personal_phone", value: "call me" }, "Phone must be"],
    ["contact: emergency contact without relationship", "/employees/contacts", { contactType: "emergency_contact", value: "0300-1234567" }, "relationship"],
    ["address: blank first line", "/employees/addresses", { addressType: "current", line1: "  " }, "cannot be empty"],
    ["address: postal code of letters", "/employees/addresses", { addressType: "current", line1: "12 Street", postalCode: "ABCDE" }, "Postal code"],
    ["language: digits only", "/employees/languages", { language: "12345" }, "contain letters"],
    ["disciplinary: incident in the future", "/employees/disciplinary", { recordType: "verbal_warning", subject: "Late", description: "Late again", incidentDate: "2090-01-01" }, "cannot be in the future"],
    ["disciplinary: incident before joining", "/employees/disciplinary", { recordType: "verbal_warning", subject: "Late", description: "Late again", incidentDate: "2010-01-01" }, "before the employee joined"],
    ["asset: assigned in the future", "/employees/assets", { assetType: "Laptop", assignedDate: "2090-01-01" }, "cannot be in the future"],
    ["important date: year 1800", "/employees/important-dates", { dateType: "contract_end", dateValue: "1800-01-01" }, "too far in the past"],
    ["important date: confirmation before joining", "/employees/important-dates", { dateType: "confirmation", dateValue: "2020-01-01" }, "before the employee joined"],
    ["extra payment: fractions of a paisa", "/employees/additional-payments", { paymentType: "earning", label: "Bonus", amount: 100.005, effectiveDate: "2026-10-01" }, "two decimal places"],
    ["extra payment: year 1900", "/employees/additional-payments", { paymentType: "earning", label: "Bonus", amount: 100, effectiveDate: "1900-01-01" }, "too far in the past"],
  ];

  it.each(refused)("%s is refused with a 400 that says why", async (_name, path, body, expected) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(expected);
  });

  it("sensible records are still accepted", async () => {
    const ok = [
      ["/employees/education", { degreeTitle: "BS Computer Science", startDate: "2008-09-01", endDate: "2012-06-30" }],
      ["/employees/qualifications", { qualificationType: "license", title: "Driving", issueDate: "2020-01-01", expiryDate: "2030-01-01" }],
      ["/employees/family-members", { relationship: "child", fullName: "Kid", dateOfBirth: "2018-05-05" }],
      ["/employees/contacts", { contactType: "personal_email", value: "someone@example.com" }],
      ["/employees/contacts", { contactType: "emergency_contact", value: "+92 300 1234567", relationship: "Brother" }],
      ["/employees/addresses", { addressType: "current", line1: "12 Street", city: "Lahore", postalCode: "54000" }],
      ["/employees/languages", { language: "Punjabi" }],
      ["/employees/disciplinary", { recordType: "verbal_warning", subject: "Late", description: "Late again", incidentDate: "2025-05-01" }],
      ["/employees/assets", { assetType: "Laptop", assetTag: "TAG-1", assignedDate: "2025-01-01" }],
      ["/employees/important-dates", { dateType: "confirmation", dateValue: "2024-09-01" }],
      ["/employees/additional-payments", { paymentType: "earning", label: "Bonus", amount: 1500.5, effectiveDate: "2026-10-01" }],
    ] as const;
    for (const [path, body] of ok) {
      const res = await post(path, body);
      expect([path, res.status, JSON.stringify(res.body).slice(0, 120)]).toEqual([path, 201, expect.anything()]);
    }
  });

  it("an asset tag cannot be issued twice, and an asset cannot come back before it went out", async () => {
    const dup = await post("/employees/assets", { assetType: "Laptop", assetTag: "tag-1", assignedDate: "2025-01-01" });
    expect(dup.status).toBe(400);
    expect(dup.body.message?.message ?? dup.body.message).toContain("already issued");
    const asset = await post("/employees/assets", { assetType: "Phone", assetTag: "PH-9", assignedDate: "2025-01-01" });
    const early = await request(app.getHttpServer()).post(`/employees/assets/${asset.body.id}/return`).set("Authorization", `Bearer ${token}`).send({ returnedDate: "2020-01-01" });
    expect(early.status).toBe(400);
    const fine = await request(app.getHttpServer()).post(`/employees/assets/${asset.body.id}/return`).set("Authorization", `Bearer ${token}`).send({ returnedDate: "2025-06-01" });
    expect(fine.status).toBe(201);
    // once returned, the tag can be issued again
    const again = await post("/employees/assets", { assetType: "Phone", assetTag: "PH-9", assignedDate: "2025-07-01" });
    expect(again.status).toBe(201);
  });

  it("gender is one of the known values on hire and on edit", async () => {
    const bad = await request(app.getHttpServer()).patch(`/employees/${employeeId}`).set("Authorization", `Bearer ${token}`).send({ gender: "xyz" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("Gender must be");
    const ok = await request(app.getHttpServer()).patch(`/employees/${employeeId}`).set("Authorization", `Bearer ${token}`).send({ gender: "Female" });
    expect(ok.status).toBe(200);
  });

  it("documents: empty files and files that are not what they say are refused; a real PDF is accepted", async () => {
    const up = (buf: Buffer, name: string, type: string) =>
      request(app.getHttpServer())
        .post(`/employees/${employeeId}/documents`)
        .set("Authorization", `Bearer ${token}`)
        .field("documentType", "other")
        .attach("file", buf, { filename: name, contentType: type });
    const empty = await up(Buffer.alloc(0), "empty.pdf", "application/pdf");
    expect(empty.status).toBe(400);
    const fake = await up(Buffer.from("just some text"), "fake.pdf", "application/pdf");
    expect(fake.status).toBe(400);
    expect(JSON.stringify(fake.body)).toContain("not really a PDF");
    const fakePng = await up(Buffer.from("not a png"), "x.png", "image/png");
    expect(fakePng.status).toBe(400);
    const real = await up(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"), "ok.pdf", "application/pdf");
    expect([real.status, JSON.stringify(real.body).slice(0, 100)]).toEqual([201, expect.anything()]);
  });
  it("cost allocation: the same cost center twice, fractions of a percent and more than 100% are refused with a clear 400", async () => {
    const [ccA, ccB] = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const a = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, $2) RETURNING id", [companyId, `RC CC A ${Date.now()}`]);
      const b = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, $2) RETURNING id", [companyId, `RC CC B ${Date.now()}`]);
      return [a.rows[0].id as string, b.rows[0].id as string];
    });
    const fraction = await post("/employees/cost-allocations", { costCenterId: ccA, allocationPercentage: 33.333 });
    expect(fraction.status).toBe(400);
    expect(JSON.stringify(fraction.body)).toContain("two decimal places");
    const first = await post("/employees/cost-allocations", { costCenterId: ccA, allocationPercentage: 60 });
    expect(first.status).toBe(201);
    const twice = await post("/employees/cost-allocations", { costCenterId: ccA, allocationPercentage: 10 });
    expect(twice.status).toBe(400);
    expect(JSON.stringify(twice.body)).toContain("already has 60% allocated");
    const tooMuch = await post("/employees/cost-allocations", { costCenterId: ccB, allocationPercentage: 50 });
    expect(tooMuch.status).toBe(400);
    expect(JSON.stringify(tooMuch.body)).toContain("exceed 100%");
    const second = await post("/employees/cost-allocations", { costCenterId: ccB, allocationPercentage: 40 });
    expect(second.status).toBe(201);
    const badEdit = await request(app.getHttpServer()).patch(`/employees/cost-allocations/${first.body.id}`).set("Authorization", `Bearer ${token}`).send({ allocationPercentage: 12.345 });
    expect(badEdit.status).toBe(400);
    expect(JSON.stringify(badEdit.body)).toContain("two decimal places");
  });
  it("numbering: a pattern that could hang the server is refused, a normal one is saved", async () => {
    const put = (manualPattern: string) => request(app.getHttpServer()).put("/configuration/core-employee/numbering").set("Authorization", `Bearer ${token}`).send({ manualPattern });
    const bad = await put("^(a+)+$");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("hang the server");
    const broken = await put("(");
    expect(broken.status).toBe(400);
    const ok = await put("^EMP-\\d{4}$");
    expect([ok.status, JSON.stringify(ok.body).slice(0, 120)]).toEqual([200, expect.anything()]);
    const longNumber = await post("/employees", { firstName: "Long", lastName: "Number", employeeNumber: "EMP-" + "1".repeat(60) });
    expect(longNumber.status).toBe(400);
  });
});
