import { Pool } from "pg";
import { AuditService } from "./audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "audit-service-fixtures" };

/**
 * AuditService is deliberately tiny (audit.service.ts): `record()` writes
 * one row inside the CALLER's own transaction/client (so an audit entry
 * commits atomically with whatever it documents, per its own doc
 * comment), and `list()` reads back with an optional company/limit
 * filter. There is no per-action/per-user/per-date-range query surface,
 * no `getAuditLogById`, and no standalone `log()` method — every other
 * module (CompaniesService, etc.) calls `record` from inside its own
 * `db.withClaims` block, which is what these tests reproduce.
 */
describe("AuditService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let audit: AuditService;
  let companyAId: string;
  let companyBId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    audit = new AuditService();

    const stamp = Date.now();
    companyAId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Audit Spec Co A ${stamp}`,
        `audit-spec-a-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
    companyBId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Audit Spec Co B ${stamp}`,
        `audit-spec-b-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyAId, companyBId]])
    );
    await pool.end();
  });

  describe("record", () => {
    it("writes a row queryable back via list()", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, {
          companyId: companyAId,
          action: "employee.create",
          target: "employee:123",
          metadata: { firstName: "Test" },
        })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));

      expect(entries.some((e) => e.action === "employee.create" && e.target === "employee:123")).toBe(true);
    });

    it("records the acting user as `actor` from claims.sub", async () => {
      const actingClaims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "actor-user-1" };

      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, actingClaims, { companyId: companyAId, action: "leave_request.approve" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));

      expect(entries.some((e) => e.action === "leave_request.approve" && e.actor === "actor-user-1")).toBe(true);
    });

    it("defaults target and metadata when omitted", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "settings.view" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));
      const entry = entries.find((e) => e.action === "settings.view")!;

      expect(entry.target).toBeNull();
      expect(entry.metadata).toEqual({});
    });

    it("accepts a null companyId for platform-level actions", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: null, action: "platform_admin.create" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, {}));

      expect(entries.some((e) => e.action === "platform_admin.create" && e.companyId === null)).toBe(true);
    });
  });

  describe("list", () => {
    it("filters by companyId", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "scoped.to.a" })
      );
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyBId, action: "scoped.to.b" })
      );

      const aEntries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));

      expect(aEntries.every((e) => e.companyId === companyAId)).toBe(true);
      expect(aEntries.some((e) => e.action === "scoped.to.a")).toBe(true);
      expect(aEntries.some((e) => e.action === "scoped.to.b")).toBe(false);
    });

    it("returns newest-first order", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "order.first" })
      );
      await new Promise((r) => setTimeout(r, 5));
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "order.second" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));
      const firstIdx = entries.findIndex((e) => e.action === "order.first");
      const secondIdx = entries.findIndex((e) => e.action === "order.second");

      expect(secondIdx).toBeLessThan(firstIdx);
    });

    it("caps the limit at 500 even when a larger value is requested", async () => {
      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.list(client, { companyId: companyAId, limit: 10_000 })
      );
      expect(entries.length).toBeLessThanOrEqual(500);
    });

    it("joins the company name onto each entry", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "name.join.check" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));
      const entry = entries.find((e) => e.action === "name.join.check")!;

      expect(entry.companyName).toContain("Audit Spec Co A");
    });

    it("preserves arbitrary metadata as a JSON object", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, {
          companyId: companyAId,
          action: "metadata.roundtrip",
          metadata: { before: { salary: 50000 }, after: { salary: 60000 } },
        })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) => audit.list(client, { companyId: companyAId }));
      const entry = entries.find((e) => e.action === "metadata.roundtrip")!;

      expect(entry.metadata).toEqual({ before: { salary: 50000 }, after: { salary: 60000 } });
    });

    // Tenant Management gap-fill Phase 1 item #6 — actor/action/date-range
    // filters.
    it("filters by a partial (case-insensitive) actor match", async () => {
      const actingClaims: RequestClaims = {
        is_platform_admin: false,
        company_id: companyAId,
        sub: "PhaseSixActor-42",
      };
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, actingClaims, { companyId: companyAId, action: "phase6.actor.match" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.list(client, { companyId: companyAId, actor: "phasesixactor" })
      );

      expect(entries.some((e) => e.action === "phase6.actor.match")).toBe(true);
    });

    it("filters by a partial action match", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "company.deletion_approved" })
      );
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "company.impersonate" })
      );

      const entries = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.list(client, { companyId: companyAId, action: "deletion" })
      );

      expect(entries.every((e) => e.action.includes("deletion"))).toBe(true);
      expect(entries.some((e) => e.action === "company.deletion_approved")).toBe(true);
    });

    it("filters by a from/to date range", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.record(client, FIXTURE_CLAIMS, { companyId: companyAId, action: "date.range.check" })
      );

      const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const noneYet = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.list(client, { companyId: companyAId, action: "date.range.check", from: farFuture })
      );
      expect(noneYet.length).toBe(0);

      const farPast = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const found = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        audit.list(client, { companyId: companyAId, action: "date.range.check", from: farPast, to: farFuture })
      );
      expect(found.some((e) => e.action === "date.range.check")).toBe(true);
    });
  });
});
