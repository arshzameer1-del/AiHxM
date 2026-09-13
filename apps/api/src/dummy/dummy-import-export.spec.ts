import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { ImportExportService } from "../import-export/import-export.service";
import { DummyService } from "./dummy.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "dummy-import-export-spec" };

/**
 * Phase 6's "Conversions" WRICEF pillar, proven against the same
 * dummy_records scaffolding object every other engine in this phase was
 * proven against — see DummyService.importCsv's doc comment.
 */
describe("DummyService CSV import/export", () => {
  let pool: Pool;
  let db: DatabaseService;
  let dummy: DummyService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    dummy = new DummyService(db, new RbacService(db), new EntitlementsService(db), new ImportExportService());

    const stamp = Date.now();
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
        [`Import Export Spec Co ${stamp}`, `import-export-spec-${stamp}`]
      );
      companyId = company.rows[0].id;
      // dummy module entitlement so a later real-list call wouldn't 404 —
      // not exercised by this file, but keeps the fixture realistic.
      await client.query(
        `INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'dummy', true)`,
        [companyId]
      );
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
    });
    await pool.end();
  });

  it("imports valid rows, skips bad ones with a per-row error, and never throws on a partial failure", async () => {
    const csv = ["title,status", "First Record,locked", ",unlocked", "Second Record,unlocked"].join("\n");
    const result = await dummy.importCsv(FIXTURE_CLAIMS, companyId, csv);

    expect(result.imported).toBe(2);
    expect(result.rows.map((r) => r.title)).toEqual(["First Record", "Second Record"]);
    expect(result.errors).toEqual([{ row: 3, message: "Missing value for: title" }]);
  });

  it("exports exactly what was imported as valid CSV", async () => {
    const csv = await dummy.exportCsv(FIXTURE_CLAIMS, companyId);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("id,title,status,testField,createdAt");
    // The two rows imported above, plus this file's own isolated fixture
    // company means nothing else could be present.
    expect(lines).toHaveLength(3);
    expect(csv).toContain("First Record");
    expect(csv).toContain("Second Record");
  });
});
