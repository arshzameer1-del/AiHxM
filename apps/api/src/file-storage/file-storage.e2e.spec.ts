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
  sub: "file-storage-e2e-fixtures",
};

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

/**
 * There is no dedicated file-storage controller — `FileStorageModule` only
 * exports the `FILE_STORAGE` provider (see file-storage.module.ts); it
 * exposes no HTTP routes of its own. The only real HTTP surface backed by
 * `LocalFileStorageService` today is the employee document vault
 * (employees.controller.ts's `POST/GET /employees/:id/documents` and
 * `GET /employees/:id/documents/:documentId`, calling through to
 * EmployeesService.addDocument/listDocuments/downloadDocument — see
 * file-storage.interface.ts's doc comment: "every caller... depends on
 * THIS interface"). So this e2e spec exercises file storage through that
 * real multipart upload / download flow rather than inventing a
 * `/file-storage/...` route that doesn't exist. Service-level coverage of
 * `LocalFileStorageService` itself (namespacing, sanitization, path
 * traversal) lives in file-storage.service.spec.ts.
 */
describe("File storage HTTP surface (e2e) — employee document vault", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let employeeId: string;

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
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `File Storage E2E Co ${stamp}`,
        `file-storage-e2e-${stamp}`,
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

    const hrAdminUserId = await createUser(`file-storage-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await createUser(`file-storage-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const createEmployeeRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Vault", lastName: "Target" });
    employeeId = createEmployeeRes.body.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects an upload with no session", async () => {
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/documents`)
      .field("documentType", "cnic_copy")
      .attach("file", Buffer.from("no session"), "no-session.txt");

    expect(res.status).toBe(401);
  });

  it("uploads a document via POST /employees/:id/documents (multipart) and returns its metadata", async () => {
    const fileContents = Buffer.from("fake CNIC scan bytes for the e2e flow");

    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/documents`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .field("documentType", "cnic_copy")
      .attach("file", fileContents, { filename: "cnic-scan.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.employeeId).toBe(employeeId);
    expect(res.body.documentType).toBe("cnic_copy");
    expect(res.body.fileName).toBe("cnic-scan.pdf");
    expect(res.body.mimeType).toBe("application/pdf");
    expect(res.body.sizeBytes).toBe(fileContents.byteLength);
    // The response is metadata only — storagePath is an internal detail
    // the vault never leaks over HTTP (see EmployeeDocumentView).
    expect(res.body.storagePath).toBeUndefined();
  });

  it("denies an upload from a caller without employee.manage.all", async () => {
    const res = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/documents`)
      .set("Authorization", `Bearer ${managerToken}`)
      .field("documentType", "cnic_copy")
      .attach("file", Buffer.from("should be denied"), "denied.txt");

    expect(res.status).toBe(403);
  });

  it("lists uploaded documents via GET /employees/:id/documents", async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/documents`)
      .set("Authorization", `Bearer ${hrAdminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].fileName).toBe("cnic-scan.pdf");
  });

  it("downloads a document's exact bytes via GET /employees/:id/documents/:documentId", async () => {
    const fileContents = Buffer.from("bytes that must round-trip exactly through the vault");

    const uploadRes = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/documents`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .field("documentType", "offer_letter")
      .attach("file", fileContents, { filename: "offer-letter.pdf", contentType: "application/pdf" });

    const documentId = uploadRes.body.id;

    const downloadRes = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .responseType("blob");

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-type"]).toBe("application/pdf");
    expect(downloadRes.headers["content-disposition"]).toContain('offer-letter.pdf');
    expect(Buffer.from(downloadRes.body).equals(fileContents)).toBe(true);
  });

  it("404s for a document id that doesn't exist on that employee", async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/documents/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${hrAdminToken}`);

    expect(res.status).toBe(404);
  });
});
