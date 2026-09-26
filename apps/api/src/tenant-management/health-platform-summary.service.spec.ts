import { Pool } from "pg";
import { HealthService } from "./health.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import type { SchedulerRegistry } from "@nestjs/schedule";
import type { FileStorageService } from "../file-storage/file-storage.interface";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "health-platform-spec-admin" };

/**
 * Phase 3 item #9 — Monitoring. HealthService.getPlatformSummary aggregates
 * real tenant_health_check_log rows (inserted directly here, exactly as
 * a real check run or the new sweep scheduler would leave them) across
 * every non-draft/non-archived company. Real Postgres — RLS is the point,
 * same idiom as data-residency.service.spec.ts.
 */
describe("HealthService.getPlatformSummary", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: HealthService;

  let healthyCompanyId: string;
  let degradedCompanyId: string;
  let downCompanyId: string;
  let neverCheckedCompanyId: string;
  let draftCompanyId: string;
  let archivedCompanyId: string;
  const allCompanyIds: string[] = [];

  async function makeCompany(status: string, namePrefix: string): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const id = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, $3) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
        status,
      ]);
      return result.rows[0].id as string;
    });
    allCompanyIds.push(id);
    return id;
  }

  async function insertCheckRow(companyId: string, checkKey: string, status: string, detail = "test"): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "INSERT INTO tenant_health_check_log (company_id, check_key, status, detail) VALUES ($1, $2, $3, $4)",
        [companyId, checkKey, status, detail]
      )
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new HealthService(
      db,
      new AuditService(),
      { dispatch: async () => undefined } as unknown as NotificationsService,
      { getCronJobs: () => new Map() } as unknown as SchedulerRegistry,
      {} as unknown as FileStorageService
    );

    healthyCompanyId = await makeCompany("active", "Platform Summary Healthy");
    degradedCompanyId = await makeCompany("active", "Platform Summary Degraded");
    downCompanyId = await makeCompany("suspended", "Platform Summary Down");
    neverCheckedCompanyId = await makeCompany("active", "Platform Summary Never Checked");
    draftCompanyId = await makeCompany("draft", "Platform Summary Draft");
    archivedCompanyId = await makeCompany("archived", "Platform Summary Archived");

    // Healthy: all 6 checks ok.
    for (const key of ["api", "db", "jobs", "email", "storage", "integrations"]) {
      await insertCheckRow(healthyCompanyId, key, "ok");
    }

    // Degraded: one degraded check, rest ok.
    for (const key of ["api", "db", "jobs", "email", "storage", "integrations"]) {
      await insertCheckRow(degradedCompanyId, key, key === "integrations" ? "degraded" : "ok", `${key}-detail`);
    }

    // Down: one down check, one degraded, rest ok.
    for (const key of ["api", "db", "jobs", "email", "storage", "integrations"]) {
      let status = "ok";
      if (key === "storage") status = "down";
      if (key === "email") status = "degraded";
      await insertCheckRow(downCompanyId, key, status, `${key}-detail`);
    }
    // An older, superseded row for the "down" company that must NOT win
    // over the newer one above (proves DISTINCT ON ... ORDER BY checked_at
    // DESC is really picking the latest, not just any row).
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO tenant_health_check_log (company_id, check_key, status, detail, checked_at)
         VALUES ($1, 'storage', 'ok', 'stale', now() - interval '1 day')`,
        [downCompanyId]
      )
    );

    // Draft and archived companies get rows too, to prove they're excluded
    // by status regardless of what tenant_health_check_log contains.
    await insertCheckRow(draftCompanyId, "db", "down");
    await insertCheckRow(archivedCompanyId, "db", "down");

    // neverCheckedCompanyId and companies not in this list at all
    // intentionally get zero rows.
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [allCompanyIds])
    );
    await pool.end();
  });

  it("counts every non-draft/archived company as never-checked when it has zero rows, not as ok", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    expect(summary.companiesNeverChecked).toBeGreaterThanOrEqual(1);

    // The specific never-checked fixture must not appear anywhere as
    // contributing an "ok" count, and must not appear in failingCompanies.
    expect(summary.failingCompanies.find((c) => c.companyId === neverCheckedCompanyId)).toBeUndefined();
  });

  it("excludes draft and archived companies entirely, even though they have failing check rows", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    expect(summary.failingCompanies.find((c) => c.companyId === draftCompanyId)).toBeUndefined();
    expect(summary.failingCompanies.find((c) => c.companyId === archivedCompanyId)).toBeUndefined();
  });

  it("does not include a fully-ok company in failingCompanies", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    expect(summary.failingCompanies.find((c) => c.companyId === healthyCompanyId)).toBeUndefined();
  });

  it("reports the degraded company's single failing check exactly", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    const entry = summary.failingCompanies.find((c) => c.companyId === degradedCompanyId);
    expect(entry).toBeDefined();
    expect(entry?.failingChecks).toHaveLength(1);
    expect(entry?.failingChecks[0]).toMatchObject({ checkKey: "integrations", status: "degraded" });
  });

  it("reports the down company's latest storage status as down, not the superseded stale 'ok' row", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    const entry = summary.failingCompanies.find((c) => c.companyId === downCompanyId);
    expect(entry).toBeDefined();
    const storageCheck = entry?.failingChecks.find((c) => c.checkKey === "storage");
    expect(storageCheck?.status).toBe("down");
    const emailCheck = entry?.failingChecks.find((c) => c.checkKey === "email");
    expect(emailCheck?.status).toBe("degraded");
    expect(entry?.failingChecks).toHaveLength(2);
  });

  it("sorts failingCompanies worst-first: any company with a down check before companies with only degraded", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    const downIndex = summary.failingCompanies.findIndex((c) => c.companyId === downCompanyId);
    const degradedIndex = summary.failingCompanies.findIndex((c) => c.companyId === degradedCompanyId);
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(degradedIndex).toBeGreaterThanOrEqual(0);
    expect(downIndex).toBeLessThan(degradedIndex);
  });

  it("aggregates perCheckCounts across companies for a given check key", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    // integrations: healthy=ok, degraded=degraded, down=ok -> at least 1 degraded present
    expect(summary.perCheckCounts.integrations.degraded).toBeGreaterThanOrEqual(1);
    // storage: healthy=ok, degraded=ok, down=down -> at least 1 down present
    expect(summary.perCheckCounts.storage.down).toBeGreaterThanOrEqual(1);
  });

  it("includes totalCompanies covering every eligible company, including the never-checked one", async () => {
    const summary = await service.getPlatformSummary(FIXTURE_CLAIMS);
    expect(summary.totalCompanies).toBeGreaterThanOrEqual(4); // healthy, degraded, down, never-checked
  });

  it("respects scoped Platform Admin access, same as CompaniesService.list", async () => {
    const scopedClaims: RequestClaims = {
      ...FIXTURE_CLAIMS,
      platformAdminAccessLevel: "scoped",
      platformAdminScopedCompanyIds: [degradedCompanyId],
    };
    const summary = await service.getPlatformSummary(scopedClaims);
    expect(summary.totalCompanies).toBe(1);
    expect(summary.failingCompanies).toHaveLength(1);
    expect(summary.failingCompanies[0].companyId).toBe(degradedCompanyId);
  });
});
