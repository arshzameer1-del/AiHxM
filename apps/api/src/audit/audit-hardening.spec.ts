import { Pool } from "pg";
import { randomUUID } from "crypto";
import { AuditService } from "./audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { runWithContext } from "../common/request-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "audit-hardening-fixtures" };

/**
 * Gap Register SEC-06 (audit_log hardening), INT-01 (typed actor siblings)
 * and INT-04 (effective-dating overlap exclusion) — migrations 0117/0118.
 * Uses the owner connection (DATABASE_URL) for the "even the owner cannot"
 * assertions and the app role for everything the product actually does.
 */
describe("audit_log hardening + integrity constraints (0117/0118)", () => {
  let pool: Pool;
  let owner: Pool;
  let db: DatabaseService;
  let audit: AuditService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
    db = new DatabaseService(pool);
    audit = new AuditService();
    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const r = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Audit Hardening Co ${stamp}`,
        `audit-hardening-${stamp}`,
      ]);
      return r.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await owner.end();
  });

  it("persists correlation id, source channel, reason and before/after on record()", async () => {
    const correlationId = randomUUID();
    await runWithContext({ correlationId, ipAddress: "203.0.113.7", sourceChannel: "import" }, () =>
      db.withClaims(FIXTURE_CLAIMS, (c) =>
        audit.record(c, FIXTURE_CLAIMS, {
          companyId,
          action: "hardening.check",
          target: "thing:1",
          reason: "unit test",
          before: { a: 1 },
          after: { a: 2 },
        })
      )
    );
    const rows = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT * FROM audit_log WHERE correlation_id = $1", [correlationId])
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      source_channel: "import",
      reason: "unit test",
      before_data: { a: 1 },
      after_data: { a: 2 },
      actor_type: "service", // fixture sub is not a UUID
      actor_id: null,
    });
    expect(String(rows.rows[0].ip_address)).toBe("203.0.113.7");
  });

  it("stores a structured actor_id when the actor is a user UUID", async () => {
    const userId = randomUUID();
    const claims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: userId };
    await db.withClaims(FIXTURE_CLAIMS, (c) => audit.record(c, claims, { companyId, action: "hardening.actor" }));
    const entries = await db.withClaims(FIXTURE_CLAIMS, (c) => audit.list(c, { companyId, action: "hardening.actor" }));
    expect(entries[0]).toMatchObject({ actorId: userId, actorType: "user" });
  });

  it("rejects UPDATE and DELETE on audit_log even for the table owner", async () => {
    await db.withClaims(FIXTURE_CLAIMS, (c) => audit.record(c, FIXTURE_CLAIMS, { companyId, action: "hardening.immutable" }));
    await expect(owner.query("UPDATE audit_log SET action = 'tampered' WHERE action = 'hardening.immutable'")).rejects.toThrow(
      /append-only/
    );
    await expect(owner.query("DELETE FROM audit_log WHERE action = 'hardening.immutable'")).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
  });

  it("still allows the FK's ON DELETE SET NULL when a company is deleted", async () => {
    const stamp = Date.now();
    const tmp = await db.withClaims(FIXTURE_CLAIMS, async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Tmp ${stamp}`, `tmp-${stamp}`]);
      await audit.record(c, FIXTURE_CLAIMS, { companyId: r.rows[0].id, action: "hardening.company_gone", target: `company_gone:${stamp}` });
      return r.rows[0].id as string;
    });
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("DELETE FROM companies WHERE id = $1", [tmp]));
    const left = await db.withClaims(FIXTURE_CLAIMS, (c) =>
      c.query("SELECT company_id FROM audit_log WHERE action = 'hardening.company_gone' AND target = $1", [`company_gone:${stamp}`])
    );
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0].company_id).toBeNull();
  });

  it("INT-01: fills the typed *_id sibling from a UUID text actor and nulls it for non-UUIDs", async () => {
    const adminId = randomUUID();
    await owner.query("UPDATE companies SET deletion_requested_by = $2 WHERE id = $1", [companyId, adminId]);
    let r = await owner.query("SELECT deletion_requested_by_id FROM companies WHERE id = $1", [companyId]);
    expect(r.rows[0].deletion_requested_by_id).toBe(adminId);
    await owner.query("UPDATE companies SET deletion_requested_by = 'system' WHERE id = $1", [companyId]);
    r = await owner.query("SELECT deletion_requested_by_id FROM companies WHERE id = $1", [companyId]);
    expect(r.rows[0].deletion_requested_by_id).toBeNull();
  });

  it("INT-04: rejects overlapping effective-dated rows (including closed history) but allows adjacent ranges", async () => {
    const ins = (min: number, from: string, to: string | null) =>
      owner.query(
        "INSERT INTO tax_slabs (company_id, min_annual_income, rate_percent, effective_from, effective_to) VALUES ($1,$2,0,$3,$4)",
        [companyId, min, from, to]
      );
    await ins(1, "2020-01-01", "2020-12-31");
    await ins(1, "2021-01-01", "2021-12-31"); // adjacent, inclusive end -> fine
    await expect(ins(1, "2021-06-01", "2022-06-30")).rejects.toThrow(/tax_slabs_no_overlap/);
    await ins(2, "2021-06-01", "2022-06-30"); // different slab floor -> independent
  });
});
