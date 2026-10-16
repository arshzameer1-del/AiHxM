import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "role-least-privilege-fixtures" };

/**
 * Role access review (2026-10, migration 0155): finance master data and reorganization plans are HR Admin only.
 * Employee Self Service (both keys) and Line Manager must not hold them; if a later migration hands one back, this fails.
 */
describe("least privilege for organization finance data", () => {
  let pool: Pool;
  let db: DatabaseService;
  const HR_ONLY = ["cost_center.view.all", "profit_center.view.all", "org_change.view.all", "org_change.manage.all", "cost_center.manage.all", "profit_center.manage.all"];

  const holders = async (permissionKey: string) =>
    (
      await db.withClaims(FIXTURE, (c) =>
        c.query("SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.key = $1", [permissionKey])
      )
    ).rows.map((x) => x.key as string);

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });
  afterAll(async () => pool.end());

  it.each(HR_ONLY)("%s is not held by Employee Self Service, ess_portal or Line Manager", async (key) => {
    const keys = await holders(key);
    for (const forbidden of ["employee_self_service", "ess_portal", "line_manager"]) expect(keys).not.toContain(forbidden);
  });

  it.each(["cost_center.view.all", "profit_center.view.all", "org_change.view.all"])("%s stays with hr_admin", async (key) => {
    expect(await holders(key)).toContain("hr_admin");
  });

  it("the org chart itself (units, jobs, positions, locations) is still visible to Employee and Line Manager", async () => {
    for (const key of ["org_unit.view.all", "job.view.all", "position.view.all", "location.view.all"]) {
      const keys = await holders(key);
      expect(keys).toEqual(expect.arrayContaining(["employee_self_service", "ess_portal", "line_manager", "hr_admin"]));
    }
  });
});
