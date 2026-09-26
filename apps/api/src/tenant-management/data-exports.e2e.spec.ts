import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generate as generateTotp } from "otplib";
import * as bcrypt from "bcryptjs";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { performStepUpForTest } from "../auth/step-up-test-support";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "data-exports-e2e-fixtures",
};

/**
 * TM-036 — Data export & migration jobs. Proves a real file is produced
 * per scope/format combination (JSON and CSV), a downloaded export's
 * content genuinely reflects this tenant's own rows, and that an
 * expired export is rejected server-side, not just hidden in the UI.
 */
describe("Data exports (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let platformAdminToken: string;
  // Phase 3 item #5's export-key routes are @RequireStepUp()-gated — kept
  // from the same login flow this file already drives so a fresh step-up
  // grant can be minted on demand via the real POST /auth/step-up route,
  // same idiom as scim.e2e.spec.ts's performStepUpForTest().
  let platformAdminMfaSecret: string;
  let companyId: string;

  async function createPlatformAdmin(email: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      await client.query(
        "INSERT INTO platform_admins (user_account_id, full_name, email, status) VALUES ($1, $2, $3, 'active')",
        [result.rows[0].id, "Exports E2E Platform Admin", email]
      );
    });
  }

  async function loginToSessionToken(email: string, password: string): Promise<{ token: string; mfaSecret: string }> {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    const mfaSecret = loginRes.body.secretForManualEntry as string;
    const code = await generateTotp({ secret: mfaSecret });
    const confirmRes = await request(app.getHttpServer())
      .post("/auth/mfa/enroll/confirm")
      .send({ mfaTicket: loginRes.body.mfaTicket, code });
    return { token: confirmRes.body.token, mfaSecret };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const email = `exports-e2e-admin-${Date.now()}@example.com`;
    const password = "SuperSecret123!";
    await createPlatformAdmin(email, password);
    const login = await loginToSessionToken(email, password);
    platformAdminToken = login.token;
    platformAdminMfaSecret = login.mfaSecret;

    const adminEmail = `exports-test-admin-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post("/platform/companies")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        name: `Exports Test Co ${Date.now()}`,
        slug: `exports-test-${Date.now()}`,
        initialAdmin: { fullName: "Admin", email: adminEmail },
      });
    companyId = createRes.body.company.id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it("rejects an unknown scope", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "everything", format: "json" });
    expect(res.status).toBe(400);
  });

  it("produces a real CSV for scope=employees", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "employees", format: "csv" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("completed");
    expect(res.body.format).toBe("csv");
    expect(res.body.expiresAt).toBeTruthy();

    const download = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports/${res.body.id}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");
  });

  it("produces a real JSON bundle for scope=full", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "full", format: "json" });
    expect(res.status).toBe(201);

    const download = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports/${res.body.id}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    const parsed = JSON.parse(download.text);
    expect(parsed.companyId).toBe(companyId);
    expect(Array.isArray(parsed.employees)).toBe(true);
    expect(Array.isArray(parsed.attendance)).toBe(true);
    expect(Array.isArray(parsed.payslips)).toBe(true);
  });

  it("rejects downloading an expired export", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "employees", format: "json" });
    const exportId = res.body.id;

    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE tenant_data_exports SET expires_at = now() - interval '1 hour' WHERE id = $1", [exportId])
    );

    const download = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports/${exportId}/download`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(download.status).toBe(400);
  });

  it("lists all requested exports for the tenant", async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it("flags a non-password-protected export as such", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "employees", format: "json" });
    expect(res.body.isPasswordProtected).toBe(false);
  });

  it("rejects a password shorter than 8 characters", async () => {
    const res = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/exports`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ scope: "employees", format: "json", password: "short" });
    expect(res.status).toBe(400);
  });

  describe("Phase 2 gap-fill item #6 — password-protected export", () => {
    let exportId: string;

    it("accepts a password at request time and reports the export as protected", async () => {
      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/exports`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ scope: "employees", format: "csv", password: "correct-horse-battery" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("completed");
      expect(res.body.isPasswordProtected).toBe(true);
      exportId = res.body.id;
    });

    it("refuses to download it with no password at all", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${exportId}/download`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/password-protected/i);
    });

    it("refuses to download it with the wrong password", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${exportId}/download`)
        .query({ password: "definitely-not-it" })
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/incorrect password/i);
    });

    it("downloads real, correct plaintext once the right password is supplied", async () => {
      const res = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${exportId}/download`)
        .query({ password: "correct-horse-battery" })
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");
    });

    it("was genuinely stored encrypted, not as plaintext CSV, in the underlying file storage", async () => {
      const row = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT file_key FROM tenant_data_exports WHERE id = $1", [exportId])
      );
      const fileKey = row.rows[0].file_key as string;
      // Read the raw stored bytes directly via LocalFileStorageService's
      // own on-disk layout rather than going through DataExportsService
      // (which would decrypt it for us) — proves the plaintext genuinely
      // never touched storage.
      const fs = await import("fs/promises");
      const path = await import("path");
      const storageRoot = path.resolve(process.env.FILE_STORAGE_LOCAL_DIR ?? "./storage-data");
      const raw = await fs.readFile(path.join(storageRoot, fileKey));
      expect(raw.toString("utf8")).not.toContain("employee_number");
      expect(raw[0]).toBe(1); // envelope mode byte: 1 = password-keyed
    });
  });

  describe("Phase 3 item #5 — tenant-dedicated export encryption key", () => {
    let firstExportId: string;
    let firstExportFileKey: string;

    it("enabling a dedicated key reports it in the status endpoint", async () => {
      const statusBefore = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/export-key`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(statusBefore.status).toBe(200);
      expect(statusBefore.body).toEqual({ enabled: false, hasKey: false, createdAt: null, previousKeyExpiresAt: null });

      const enableRes = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/export-key/enable`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      // No step-up grant has been established in this test yet — the
      // route is @RequireStepUp()-gated, same as rotateIntegrationSecret.
      expect(enableRes.status).toBe(403);

      await performStepUpForTest(app, platformAdminToken, platformAdminMfaSecret);

      const enabled = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/export-key/enable`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(enabled.status).toBe(201);
      expect(enabled.body.enabled).toBe(true);
      expect(enabled.body.hasKey).toBe(true);
      // Never exposes any key material, wrapped or not.
      expect(JSON.stringify(enabled.body)).not.toMatch(/[0-9a-f]{48,}/);
    });

    it("a new export with no explicit password now uses the tenant's own key (mode byte 2), not the shared server key", async () => {
      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/exports`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ scope: "employees", format: "csv" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("completed");
      firstExportId = res.body.id;

      const row = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT file_key FROM tenant_data_exports WHERE id = $1", [firstExportId])
      );
      firstExportFileKey = row.rows[0].file_key as string;
      const fs = await import("fs/promises");
      const path = await import("path");
      const storageRoot = path.resolve(process.env.FILE_STORAGE_LOCAL_DIR ?? "./storage-data");
      const raw = await fs.readFile(path.join(storageRoot, firstExportFileKey));
      expect(raw[0]).toBe(2); // envelope mode byte: 2 = tenant-key
    });

    it("downloads successfully using the tenant key transparently (no password needed)", async () => {
      const download = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${firstExportId}/download`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(download.status).toBe(200);
      expect(download.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");
    });

    it("rotating the key still allows downloading the OLDER export via the previous-key grace period", async () => {
      const rotated = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/export-key/rotate`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(rotated.status).toBe(201);
      expect(rotated.body.enabled).toBe(true);
      expect(rotated.body.previousKeyExpiresAt).toBeTruthy();

      const download = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${firstExportId}/download`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(download.status).toBe(200);
      expect(download.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");
    });

    it("a fresh export made after rotation is encrypted under the NEW current key, and downloads fine", async () => {
      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/exports`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ scope: "employees", format: "csv" });
      expect(res.status).toBe(201);

      const download = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${res.body.id}/download`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(download.status).toBe(200);
      expect(download.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");
    });

    it("disabling the key falls back to the shared server key for NEW exports, while the OLD tenant-keyed export still downloads", async () => {
      const disabled = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/export-key/disable`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(disabled.status).toBe(201);
      expect(disabled.body.enabled).toBe(false);
      expect(disabled.body.hasKey).toBe(true);

      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/exports`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ scope: "employees", format: "csv" });
      expect(res.status).toBe(201);

      const row = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT file_key FROM tenant_data_exports WHERE id = $1", [res.body.id])
      );
      const fs = await import("fs/promises");
      const path = await import("path");
      const storageRoot = path.resolve(process.env.FILE_STORAGE_LOCAL_DIR ?? "./storage-data");
      const raw = await fs.readFile(path.join(storageRoot, row.rows[0].file_key as string));
      expect(raw[0]).toBe(0); // envelope mode byte: 0 = shared server key, now that the tenant key is disabled

      const download = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${res.body.id}/download`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(download.status).toBe(200);
      expect(download.text.split("\n")[0]).toBe("id,employee_number,first_name,last_name,employment_status,hire_date");

      // The export made BEFORE disabling, under the tenant's (now-disabled)
      // key, must still be downloadable — disabling only affects future
      // exports, never already-encrypted ones.
      const stillDownloads = await request(app.getHttpServer())
        .get(`/platform/companies/${companyId}/exports/${firstExportId}/download`)
        .set("Authorization", `Bearer ${platformAdminToken}`);
      expect(stillDownloads.status).toBe(200);
    });

    it("an explicit per-export password still takes priority over an enabled tenant key", async () => {
      await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/export-key/enable`)
        .set("Authorization", `Bearer ${platformAdminToken}`);

      const res = await request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/exports`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ scope: "employees", format: "csv", password: "requester-chosen-password" });
      expect(res.status).toBe(201);

      const row = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT file_key FROM tenant_data_exports WHERE id = $1", [res.body.id])
      );
      const fs = await import("fs/promises");
      const path = await import("path");
      const storageRoot = path.resolve(process.env.FILE_STORAGE_LOCAL_DIR ?? "./storage-data");
      const raw = await fs.readFile(path.join(storageRoot, row.rows[0].file_key as string));
      expect(raw[0]).toBe(1); // password mode wins over the tenant key
    });
  });
});
