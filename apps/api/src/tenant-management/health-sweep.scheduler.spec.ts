import { Pool } from "pg";
import { HealthSweepScheduler } from "./health-sweep.scheduler";
import { DatabaseService } from "../database/database.service";
import type { HealthService } from "./health.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "health-sweep-spec-admin" };

/**
 * Phase 3 item #9 — Monitoring. Proves the sweep's own company-selection
 * logic (excludes draft/archived, includes everything else) and its
 * per-company error isolation, without exercising HealthService.runCheck's
 * 6 real subsystem probes — that's already covered by health.service's own
 * tests and health.e2e.spec.ts. Real Postgres for the company listing
 * (RLS is the point), a stubbed HealthService for runCheck itself.
 */
describe("HealthSweepScheduler", () => {
  let pool: Pool;
  let db: DatabaseService;
  let activeId: string;
  let suspendedId: string;
  let draftId: string;
  let archivedId: string;

  async function makeCompany(status: string): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, $3) RETURNING id", [
        `Health Sweep Spec ${status} ${stamp}`,
        `health-sweep-spec-${status}-${stamp}`,
        status,
      ]);
      return result.rows[0].id as string;
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    activeId = await makeCompany("active");
    suspendedId = await makeCompany("suspended");
    draftId = await makeCompany("draft");
    archivedId = await makeCompany("archived");
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[activeId, suspendedId, draftId, archivedId]])
    );
    await pool.end();
  });

  it("checks every non-draft/archived company and skips draft/archived ones", async () => {
    const runCheck = jest.fn(async (_claims: RequestClaims, _companyId: string) => []);
    const scheduler = new HealthSweepScheduler({ runCheck } as unknown as HealthService, db);

    await scheduler.handleSweep();

    const checkedIds = runCheck.mock.calls.map((call) => call[1]);
    expect(checkedIds).toEqual(expect.arrayContaining([activeId, suspendedId]));
    expect(checkedIds).not.toContain(draftId);
    expect(checkedIds).not.toContain(archivedId);
  });

  it("one company's runCheck throwing does not stop the sweep from checking the rest", async () => {
    const runCheck = jest.fn(async (_claims: RequestClaims, companyId: string) => {
      if (companyId === suspendedId) {
        throw new Error("simulated failure for one tenant");
      }
      return [];
    });
    const scheduler = new HealthSweepScheduler({ runCheck } as unknown as HealthService, db);

    await expect(scheduler.handleSweep()).resolves.toBeUndefined();

    const checkedIds = runCheck.mock.calls.map((call) => call[1]);
    expect(checkedIds).toEqual(expect.arrayContaining([activeId, suspendedId]));
  });

  it("calls runCheck with service claims, not a client-suppliable identity", async () => {
    const runCheck = jest.fn(async (_claims: RequestClaims, _companyId: string) => []);
    const scheduler = new HealthSweepScheduler({ runCheck } as unknown as HealthService, db);

    await scheduler.handleSweep();

    for (const call of runCheck.mock.calls) {
      const [claims] = call;
      expect(claims.is_service).toBe(true);
      expect(claims.is_platform_admin).toBe(false);
    }
  });
});
