import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EffectiveDatingEngine, toIsoDate } from "./effective-dating.engine";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "effective-dating-spec-fixtures" };

/**
 * Exercises the shared engine directly against two of its real,
 * production consumers' own tables (`leave_policy_versions` for the
 * single-row shape, `tax_slabs` for the row-set shape) rather than a
 * throwaway fixture table — so passing here is real evidence the engine
 * reproduces the exact supersession behavior `EmployeeGroupsService`
 * and `PayrollService` each hand-built separately in migration 0033,
 * not just evidence it behaves consistently with itself.
 */
describe("EffectiveDatingEngine", () => {
  let pool: Pool;
  let db: DatabaseService;
  let engine: EffectiveDatingEngine;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    engine = new EffectiveDatingEngine();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureCompany(namePrefix: string): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
      ]);
      return company.rows[0].id as string;
    });
  }

  async function createFixtureLeavePolicy(companyId: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "INSERT INTO leave_policies (company_id, name, is_default) VALUES ($1, 'Engine spec policy', false) RETURNING id",
        [companyId]
      );
      return result.rows[0].id as string;
    });
  }

  describe("applyVersionedRow — single-row shape (leave_policy_versions)", () => {
    it("creates the first version when none exists yet", async () => {
      const companyId = await createFixtureCompany("Engine RowFirst");
      const policyId = await createFixtureLeavePolicy(companyId);

      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await engine.applyVersionedRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: policyId },
          extraInsertColumns: { company_id: companyId },
          data: { annual_leave_days: 14, casual_leave_days: 8, sick_leave_days: 6 },
        });
        expect(result.collapsed).toBe(false);
        expect(result.row.annual_leave_days).toBe(14);
        expect(toIsoDate(result.row.effective_from)).toBe(toIsoDate(new Date()));
        expect(result.row.effective_to).toBeNull();
      });
    });

    it("collapses a same-day second edit into the still-open version rather than opening a second one", async () => {
      const companyId = await createFixtureCompany("Engine RowCollapse");
      const policyId = await createFixtureLeavePolicy(companyId);

      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const first = await engine.applyVersionedRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: policyId },
          extraInsertColumns: { company_id: companyId },
          data: { annual_leave_days: 10, casual_leave_days: 5, sick_leave_days: 5 },
        });

        const second = await engine.applyVersionedRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: policyId },
          extraInsertColumns: { company_id: companyId },
          data: { annual_leave_days: 20, casual_leave_days: 5, sick_leave_days: 5 },
        });

        expect(second.collapsed).toBe(true);
        expect(second.row.id).toBe(first.row.id);
        expect(second.row.annual_leave_days).toBe(20);

        const history = await engine.getHistory(client, { table: "leave_policy_versions", scope: { policy_id: policyId } });
        expect(history).toHaveLength(1);
      });
    });

    it("closes a version opened on a prior day with no gap or overlap, and opens a new one", async () => {
      const companyId = await createFixtureCompany("Engine RowBackdated");
      const policyId = await createFixtureLeavePolicy(companyId);

      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const original = await engine.applyVersionedRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: policyId },
          extraInsertColumns: { company_id: companyId },
          data: { annual_leave_days: 12, casual_leave_days: 6, sick_leave_days: 6 },
        });
        // Simulate "opened yesterday" the same way the prior hand-built
        // spec for this exact scenario did — backdating directly in
        // Postgres is the only deterministic way to exercise this branch.
        await client.query(
          "UPDATE leave_policy_versions SET effective_from = (CURRENT_DATE - INTERVAL '1 day')::date WHERE id = $1",
          [original.row.id]
        );

        const superseded = await engine.applyVersionedRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: policyId },
          extraInsertColumns: { company_id: companyId },
          data: { annual_leave_days: 18, casual_leave_days: 6, sick_leave_days: 6 },
        });

        expect(superseded.collapsed).toBe(false);
        expect(superseded.row.id).not.toBe(original.row.id);

        const closedRow = await client.query("SELECT effective_to FROM leave_policy_versions WHERE id = $1", [original.row.id]);
        const closedTo = toIsoDate(closedRow.rows[0].effective_to);
        const reopenedFrom = toIsoDate(superseded.row.effective_from);
        const oneDayLater = new Date(closedTo);
        oneDayLater.setUTCDate(oneDayLater.getUTCDate() + 1);
        expect(toIsoDate(oneDayLater)).toBe(reopenedFrom);

        const history = await engine.getHistory(client, { table: "leave_policy_versions", scope: { policy_id: policyId } });
        expect(history).toHaveLength(2);
      });
    });

    it("getCurrentRow returns null when a scope has no rows at all", async () => {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const current = await engine.getCurrentRow(client, {
          table: "leave_policy_versions",
          scope: { policy_id: "00000000-0000-0000-0000-000000000000" },
        });
        expect(current).toBeNull();
      });
    });
  });

  describe("applyVersionedSet — row-set shape (tax_slabs)", () => {
    it("creates the first generation when none exists yet", async () => {
      const companyId = await createFixtureCompany("Engine SetFirst");

      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await engine.applyVersionedSet(client, {
          table: "tax_slabs",
          scope: { company_id: companyId },
          rows: [
            { min_annual_income: 0, max_annual_income: 600000, base_tax: 0, rate_percent: 0 },
            { min_annual_income: 600000, max_annual_income: null, base_tax: 0, rate_percent: 10 },
          ],
        });
        expect(result.collapsed).toBe(false);
        expect(result.rows).toHaveLength(2);
        for (const row of result.rows) {
          expect(row.effective_to).toBeNull();
        }
      });
    });

    it("collapses a same-day second set-change by replacing the open generation in place", async () => {
      const companyId = await createFixtureCompany("Engine SetCollapse");

      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await engine.applyVersionedSet(client, {
          table: "tax_slabs",
          scope: { company_id: companyId },
          rows: [{ min_annual_income: 0, max_annual_income: null, base_tax: 0, rate_percent: 5 }],
        });

        const second = await engine.applyVersionedSet(client, {
          table: "tax_slabs",
          scope: { company_id: companyId },
          rows: [
            { min_annual_income: 0, max_annual_income: 500000, base_tax: 0, rate_percent: 0 },
            { min_annual_income: 500000, max_annual_income: null, base_tax: 0, rate_percent: 15 },
          ],
        });

        expect(second.collapsed).toBe(true);
        expect(second.rows).toHaveLength(2);

        const history = await engine.getHistory(client, { table: "tax_slabs", scope: { company_id: companyId } });
        expect(history).toHaveLength(2); // only the collapsed (replaced) generation's 2 rows, not 3
      });
    });

    it("closes a generation opened on a prior day with no gap or overlap, and opens a new one", async () => {
      const companyId = await createFixtureCompany("Engine SetBackdated");

      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await engine.applyVersionedSet(client, {
          table: "tax_slabs",
          scope: { company_id: companyId },
          rows: [{ min_annual_income: 0, max_annual_income: null, base_tax: 0, rate_percent: 8 }],
        });
        await client.query(
          "UPDATE tax_slabs SET effective_from = (CURRENT_DATE - INTERVAL '1 day')::date WHERE company_id = $1 AND effective_to IS NULL",
          [companyId]
        );

        const superseded = await engine.applyVersionedSet(client, {
          table: "tax_slabs",
          scope: { company_id: companyId },
          rows: [{ min_annual_income: 0, max_annual_income: null, base_tax: 0, rate_percent: 12 }],
        });

        expect(superseded.collapsed).toBe(false);

        const closed = await client.query(
          "SELECT DISTINCT effective_to FROM tax_slabs WHERE company_id = $1 AND effective_to IS NOT NULL",
          [companyId]
        );
        const closedTo = toIsoDate(closed.rows[0].effective_to);
        const reopenedFrom = toIsoDate(superseded.rows[0].effective_from);
        const oneDayLater = new Date(closedTo);
        oneDayLater.setUTCDate(oneDayLater.getUTCDate() + 1);
        expect(toIsoDate(oneDayLater)).toBe(reopenedFrom);

        const history = await engine.getHistory(client, { table: "tax_slabs", scope: { company_id: companyId }, orderBy: "effective_from ASC, min_annual_income ASC" });
        expect(history).toHaveLength(2); // 1 closed + 1 open
      });
    });
  });
});
