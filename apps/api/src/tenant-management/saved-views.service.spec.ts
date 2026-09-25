import { Pool } from "pg";
import { SavedViewsService } from "./saved-views.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "saved-views-spec" };

/**
 * SavedViewsService backs both the Tenant Directory's "save view"
 * (view_type='tenant_directory', TM-003) and, since Tenant Management
 * gap-fill Phase 1 item #6, the Audit Log's saved searches
 * (view_type='audit_log') — same table (platform_saved_views), same
 * shape, discriminated by the `view_type` column added in migration 0051.
 */
describe("SavedViewsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: SavedViewsService;
  const createdIds: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new SavedViewsService(db);
  });

  afterAll(async () => {
    await db.withClaims(CLAIMS, (client) =>
      client.query("DELETE FROM platform_saved_views WHERE id = ANY($1::uuid[])", [createdIds])
    );
    await pool.end();
  });

  it("defaults a new view to 'tenant_directory' when no viewType is given", async () => {
    const view = await service.create(CLAIMS, `Default type ${Date.now()}`, "tenant_directory", {
      search: "acme",
    });
    createdIds.push(view.id);

    expect(view.viewType).toBe("tenant_directory");
    expect(view.filters).toEqual({ search: "acme" });
  });

  it("stores an audit_log saved search distinctly from tenant_directory views", async () => {
    const stamp = Date.now();
    const auditView = await service.create(CLAIMS, `Audit search ${stamp}`, "audit_log", {
      actor: "kumail",
      action: "company.impersonate",
    });
    createdIds.push(auditView.id);
    const directoryView = await service.create(CLAIMS, `Directory search ${stamp}`, "tenant_directory", {
      status: ["active"],
    });
    createdIds.push(directoryView.id);

    const auditList = await service.list(CLAIMS, "audit_log");
    const directoryList = await service.list(CLAIMS, "tenant_directory");

    expect(auditList.some((v) => v.id === auditView.id)).toBe(true);
    expect(auditList.some((v) => v.id === directoryView.id)).toBe(false);
    expect(directoryList.some((v) => v.id === directoryView.id)).toBe(true);
    expect(directoryList.some((v) => v.id === auditView.id)).toBe(false);
  });

  it("lists every view type when no viewType filter is given", async () => {
    const stamp = Date.now();
    const auditView = await service.create(CLAIMS, `Mixed audit ${stamp}`, "audit_log", { actor: "x" });
    createdIds.push(auditView.id);
    const directoryView = await service.create(CLAIMS, `Mixed directory ${stamp}`, "tenant_directory", {});
    createdIds.push(directoryView.id);

    const all = await service.list(CLAIMS);

    expect(all.some((v) => v.id === auditView.id)).toBe(true);
    expect(all.some((v) => v.id === directoryView.id)).toBe(true);
  });

  it("deletes a saved view", async () => {
    const view = await service.create(CLAIMS, `To delete ${Date.now()}`, "audit_log", {});
    await service.delete(CLAIMS, view.id);

    const all = await service.list(CLAIMS, "audit_log");
    expect(all.some((v) => v.id === view.id)).toBe(false);
  });

  it("throws NotFoundException when deleting a saved view that doesn't exist", async () => {
    await expect(
      service.delete(CLAIMS, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow("Saved view not found");
  });
});
