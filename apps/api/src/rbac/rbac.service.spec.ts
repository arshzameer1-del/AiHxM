import { randomUUID } from "crypto";
import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "./rbac.service";

/**
 * "Should allow / should deny" per permission, plus the field-level
 * engine — the exact test suite shape the plan doc's Phase 4 row asks
 * for. Runs against real local Postgres (see test-setup.ts) using the
 * catalog migration 0004_rbac.sql seeds: three demo roles that between
 * them exercise object-level self-vs-all scope, field-level view-vs-
 * hidden, and one conditional (status-based) rule.
 *
 * Fixtures are written under Platform-Admin-shaped claims — the same
 * write path a real Platform Admin session uses through the API (Phase 2
 * companies_write only grants INSERT to `is_platform_admin()`, not
 * `is_service()`; the latter exists solely for AuthService/seed.ts's
 * pre-authentication reads, not general fixture writes).
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "rbac-spec-fixtures" };

describe("RbacService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;

  let companyId: string;
  let fullAccessUserId: string;
  let viewOnlyUserId: string;
  let selfServiceUserId: string;
  let strangerUserId: string;
  let ownRecordId: string;
  let othersRecordId: string;

  let fullAccessClaims: RequestClaims;
  let viewOnlyClaims: RequestClaims;
  let selfServiceClaims: RequestClaims;
  let strangerClaims: RequestClaims;
  let platformAdminShapedClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);

    const stamp = Date.now();

    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
        [`RBAC Spec Co ${stamp}`, `rbac-spec-${stamp}`]
      );
      companyId = company.rows[0].id;

      async function makeUser(email: string): Promise<string> {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [email]
        );
        return account.rows[0].id;
      }
      fullAccessUserId = await makeUser(`full-access-${stamp}@example.com`);
      viewOnlyUserId = await makeUser(`view-only-${stamp}@example.com`);
      selfServiceUserId = await makeUser(`self-service-${stamp}@example.com`);
      strangerUserId = await makeUser(`stranger-${stamp}@example.com`);

      async function assign(userAccountId: string, roleKey: string) {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      }
      await assign(fullAccessUserId, "rbac_demo_full_access");
      await assign(viewOnlyUserId, "rbac_demo_view_only");
      await assign(selfServiceUserId, "rbac_demo_self_service");
      // strangerUserId deliberately gets no role assignment at all.

      const ownRecord = await client.query(
        `INSERT INTO dummy_records (company_id, owner_user_account_id, title, status, test_field, secret_field)
         VALUES ($1, $2, 'Self-service-owned record', 'unlocked', 'test-value', 'secret-value')
         RETURNING id`,
        [companyId, selfServiceUserId]
      );
      ownRecordId = ownRecord.rows[0].id;

      const othersRecord = await client.query(
        `INSERT INTO dummy_records (company_id, owner_user_account_id, title, status, test_field, secret_field)
         VALUES ($1, $2, 'Someone else''s record', 'locked', 'other-test-value', 'other-secret-value')
         RETURNING id`,
        [companyId, fullAccessUserId]
      );
      othersRecordId = othersRecord.rows[0].id;
    });

    fullAccessClaims = { is_platform_admin: false, company_id: companyId, sub: fullAccessUserId };
    viewOnlyClaims = { is_platform_admin: false, company_id: companyId, sub: viewOnlyUserId };
    selfServiceClaims = { is_platform_admin: false, company_id: companyId, sub: selfServiceUserId };
    strangerClaims = { is_platform_admin: false, company_id: companyId, sub: strangerUserId };
    // Shaped exactly like a real Platform Admin session token: no company_id.
    platformAdminShapedClaims = { is_platform_admin: true, company_id: null, sub: randomUUID() };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyId]); // cascades role assignments + dummy_records
      await client.query("DELETE FROM user_accounts WHERE id = ANY($1::uuid[])", [
        [fullAccessUserId, viewOnlyUserId, selfServiceUserId, strangerUserId],
      ]);
    });
    await pool.end();
  });

  describe("can() — object/record-level", () => {
    it("should allow dummy_record.view.all for the full-access role", async () => {
      expect(await rbac.can(fullAccessClaims, "dummy_record.view.all")).toBe(true);
    });

    it("should allow dummy_record.view.all for the view-only role (object access, not field access)", async () => {
      expect(await rbac.can(viewOnlyClaims, "dummy_record.view.all")).toBe(true);
    });

    it("should deny dummy_record.view.all for the self-service role", async () => {
      expect(await rbac.can(selfServiceClaims, "dummy_record.view.all")).toBe(false);
    });

    it("should allow dummy_record.view.self for the self-service role on its own record", async () => {
      expect(
        await rbac.can(selfServiceClaims, "dummy_record.view.self", { ownerId: selfServiceUserId })
      ).toBe(true);
    });

    it("should deny dummy_record.view.self for the self-service role on someone else's record", async () => {
      expect(
        await rbac.can(selfServiceClaims, "dummy_record.view.self", { ownerId: fullAccessUserId })
      ).toBe(false);
    });

    it("should deny every permission for a user with no role assignment at all", async () => {
      expect(await rbac.can(strangerClaims, "dummy_record.view.all")).toBe(false);
      expect(
        await rbac.can(strangerClaims, "dummy_record.view.self", { ownerId: strangerUserId })
      ).toBe(false);
    });

    it("should deny every permission for a Platform-Admin-shaped session (no company_id, no bypass)", async () => {
      expect(await rbac.can(platformAdminShapedClaims, "dummy_record.view.all")).toBe(false);
    });
  });

  describe("resolveFieldAccess() — field-level, including conditional rules", () => {
    it("should allow view on testField for the full-access role", async () => {
      const record = { status: "locked" };
      expect(await rbac.resolveFieldAccess(fullAccessClaims, "dummy_record", "testField", record)).toBe(
        "view"
      );
    });

    it("should deny (hidden) testField for the view-only role — object access does not imply field access", async () => {
      const record = { status: "locked" };
      expect(await rbac.resolveFieldAccess(viewOnlyClaims, "dummy_record", "testField", record)).toBe(
        "hidden"
      );
    });

    it("should allow view on secretField for the full-access role only when the record is unlocked", async () => {
      expect(
        await rbac.resolveFieldAccess(fullAccessClaims, "dummy_record", "secretField", { status: "unlocked" })
      ).toBe("view");
    });

    it("should deny (hidden) secretField for the full-access role when the record is locked", async () => {
      expect(
        await rbac.resolveFieldAccess(fullAccessClaims, "dummy_record", "secretField", { status: "locked" })
      ).toBe("hidden");
    });

    it("should allow view on testField for the self-service role", async () => {
      expect(
        await rbac.resolveFieldAccess(selfServiceClaims, "dummy_record", "testField", { status: "unlocked" })
      ).toBe("view");
    });

    it("should deny (hidden) secretField for the self-service role under any condition (no rule at all)", async () => {
      expect(
        await rbac.resolveFieldAccess(selfServiceClaims, "dummy_record", "secretField", { status: "unlocked" })
      ).toBe("hidden");
    });

    it("should default to hidden for a field nobody has any rule for", async () => {
      expect(
        await rbac.resolveFieldAccess(fullAccessClaims, "dummy_record", "nonexistent_field", {})
      ).toBe("hidden");
    });
  });

  describe("filterRecordFields() — the actual enforcement point", () => {
    it("full-access sees test_field and, on the unlocked record, secret_field", async () => {
      const raw = { id: othersRecordId, title: "x", testField: "t", secretField: "s", status: "unlocked" };
      const filtered = await rbac.filterRecordFields(
        fullAccessClaims,
        "dummy_record",
        "dummy_record.view",
        raw,
        ["testField", "secretField"],
        fullAccessUserId
      );
      expect(filtered).not.toBeNull();
      expect(filtered!.testField).toBe("t");
      expect(filtered!.secretField).toBe("s");
    });

    it("view-only sees the record but neither gated field is present in the raw response at all", async () => {
      const raw = { id: othersRecordId, title: "x", testField: "t", secretField: "s", status: "unlocked" };
      const filtered = await rbac.filterRecordFields(
        viewOnlyClaims,
        "dummy_record",
        "dummy_record.view",
        raw,
        ["testField", "secretField"],
        fullAccessUserId
      );
      expect(filtered).not.toBeNull();
      expect(filtered!.title).toBe("x"); // non-sensitive fields always pass through
      expect("testField" in filtered!).toBe(false);
      expect("secretField" in filtered!).toBe(false);
      expect(Object.keys(filtered!)).not.toContain("testField");
      expect(Object.keys(filtered!)).not.toContain("secretField");
    });

    it("self-service sees its own record's test_field but not another record at all", async () => {
      const ownRaw = { id: ownRecordId, title: "mine", testField: "t", secretField: "s", status: "unlocked" };
      const ownFiltered = await rbac.filterRecordFields(
        selfServiceClaims,
        "dummy_record",
        "dummy_record.view",
        ownRaw,
        ["testField", "secretField"],
        selfServiceUserId
      );
      expect(ownFiltered).not.toBeNull();
      expect(ownFiltered!.testField).toBe("t");
      expect("secretField" in ownFiltered!).toBe(false);

      const othersRaw = { id: othersRecordId, title: "not mine", testField: "t", secretField: "s", status: "unlocked" };
      const othersFiltered = await rbac.filterRecordFields(
        selfServiceClaims,
        "dummy_record",
        "dummy_record.view",
        othersRaw,
        ["testField", "secretField"],
        fullAccessUserId
      );
      expect(othersFiltered).toBeNull();
    });

    it("a user with no role assignment cannot see the record at all", async () => {
      const raw = { id: ownRecordId, title: "mine", testField: "t", secretField: "s", status: "unlocked" };
      const filtered = await rbac.filterRecordFields(
        strangerClaims,
        "dummy_record",
        "dummy_record.view",
        raw,
        ["testField", "secretField"],
        selfServiceUserId
      );
      expect(filtered).toBeNull();
    });
  });
});
