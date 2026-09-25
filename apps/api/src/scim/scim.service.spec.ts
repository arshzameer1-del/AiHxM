import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { ScimService } from "./scim.service";
import { hashScimToken } from "./scim-auth.guard";
import { SsoService } from "../sso/sso.service";
import { AuthService } from "../auth/auth.service";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import { DatabaseService } from "../database/database.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";
import { PG_POOL } from "../database/pg-pool.token";
import type { RequestClaims } from "../database/tenant-context";

/**
 * `ScimService`'s CRUD methods exercised directly against the real
 * database with synthetic company/account fixtures — no HTTP, no
 * `ScimAuthGuard` involved. `scim.e2e.spec.ts` is what drives the real
 * bearer-token-authenticated HTTP surface end to end, the same split
 * `sso.service.spec.ts`/`sso.e2e.spec.ts` already established for OIDC/SAML.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "scim-service-spec-fixtures",
};

describe("ScimService", () => {
  let service: ScimService;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ScimService,
        SsoService,
        AuthService,
        AuditService,
        DatabaseService,
        EntitlementsService,
        MailerService,
        SessionSecurityService,
        CacheService,
        { provide: PG_POOL, useValue: pool },
      ],
    }).compile();

    service = module.get<ScimService>(ScimService);
  });

  afterAll(async () => {
    await pool.end();
  });

  function uniqueSlug(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function createCompany(defaultRoleKey?: string): Promise<{ companyId: string; slug: string }> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const slug = uniqueSlug("scim-spec-co");
      const companyResult = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`SCIM Spec Co ${slug}`, slug]
      );
      const companyId = companyResult.rows[0].id as string;
      await client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, scim_enabled, updated_by)
         VALUES ($1, 'sso', false, $2::jsonb, true, 'scim-spec-fixtures')`,
        [companyId, JSON.stringify(defaultRoleKey ? { defaultRoleKey } : {})]
      );
      return { companyId, slug };
    });
  }

  async function createLocalTenantAccount(companyId: string, email: string, roleKey = "hr_admin"): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query<{ id: string }>(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'scim-spec-not-a-real-hash') RETURNING id",
        [email]
      );
      const userAccountId = account.rows[0].id;
      const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, role.rows[0].id]
      );
      return userAccountId;
    });
  }

  async function getUserAccount(id: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("SELECT id, email, status, auth_provider FROM user_accounts WHERE id = $1", [
        id,
      ]);
      return result.rows[0];
    });
  }

  async function getRoleKeyForAssignment(userAccountId: string, companyId: string): Promise<string | undefined> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `SELECT r.key FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id
         WHERE ura.user_account_id = $1 AND ura.company_id = $2`,
        [userAccountId, companyId]
      );
      return result.rows[0]?.key;
    });
  }

  async function createActiveSession(userAccountId: string, companyId: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO user_sessions (user_account_id, company_id, is_platform_admin, expires_at)
         VALUES ($1, $2, false, now() + interval '1 hour') RETURNING id`,
        [userAccountId, companyId]
      );
      return result.rows[0].id;
    });
  }

  describe("createUser", () => {
    it("provisions a brand-new account with the config's default role", async () => {
      const { companyId, slug } = await createCompany("employee_self_service");
      const email = `new-${randomUUID()}@example.com`;

      const resource = await service.createUser(slug, companyId, { userName: email });

      expect(resource.userName).toBe(email);
      expect(resource.active).toBe(true);
      expect(resource.id).toBeTruthy();

      const account = await getUserAccount(resource.id as string);
      expect(account.email).toBe(email);
      expect(account.auth_provider).toBe("sso");
      expect(await getRoleKeyForAssignment(resource.id as string, companyId)).toBe("employee_self_service");
    });

    it("links to an existing tenant member by email instead of duplicating the account or changing their role", async () => {
      const { companyId, slug } = await createCompany();
      const email = `existing-${randomUUID()}@example.com`;
      const existingId = await createLocalTenantAccount(companyId, email, "hr_admin");

      const resource = await service.createUser(slug, companyId, { userName: email });

      expect(resource.id).toBe(existingId);
      expect(await getRoleKeyForAssignment(existingId, companyId)).toBe("hr_admin");
      const account = await getUserAccount(existingId);
      expect(account.auth_provider).toBe("local");
    });

    it("creates the account inactive when active: false is sent on create", async () => {
      const { companyId, slug } = await createCompany();
      const email = `inactive-${randomUUID()}@example.com`;

      const resource = await service.createUser(slug, companyId, { userName: email, active: false });

      expect(resource.active).toBe(false);
      const account = await getUserAccount(resource.id as string);
      expect(account.status).toBe("locked");
    });

    it("stores externalId and name, echoing them back on the created resource", async () => {
      const { companyId, slug } = await createCompany();
      const email = `named-${randomUUID()}@example.com`;
      const externalId = `idp-${randomUUID()}`;

      const resource = await service.createUser(slug, companyId, {
        userName: email,
        externalId,
        name: { givenName: "Ada", familyName: "Lovelace" },
      });

      expect(resource.externalId).toBe(externalId);
      expect(resource.name).toEqual({ givenName: "Ada", familyName: "Lovelace" });
    });

    it("rejects a body with no email-shaped userName or emails entry", async () => {
      const { companyId, slug } = await createCompany();
      await expect(service.createUser(slug, companyId, { userName: "not-an-email" })).rejects.toThrow(
        BadRequestException
      );
    });

    it("rejects an email that already belongs to an account outside this tenant", async () => {
      const { companyId: otherCompanyId } = await createCompany();
      const email = `cross-tenant-${randomUUID()}@example.com`;
      await createLocalTenantAccount(otherCompanyId, email);

      const { companyId, slug } = await createCompany();
      await expect(service.createUser(slug, companyId, { userName: email })).rejects.toThrow(ConflictException);
    });

    it("rejects creating the same userName twice for the same tenant", async () => {
      const { companyId, slug } = await createCompany();
      const email = `dup-${randomUUID()}@example.com`;
      await service.createUser(slug, companyId, { userName: email });
      await expect(service.createUser(slug, companyId, { userName: email })).rejects.toThrow(ConflictException);
    });

    it("rejects a defaultRoleKey that doesn't match any real role", async () => {
      const { companyId, slug } = await createCompany("not_a_real_role");
      await expect(
        service.createUser(slug, companyId, { userName: `bad-role-${randomUUID()}@example.com` })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getUser / listUsers", () => {
    it("finds a provisioned user by filter=userName eq \"...\"", async () => {
      const { companyId, slug } = await createCompany();
      const email = `filter-${randomUUID()}@example.com`;
      const created = await service.createUser(slug, companyId, { userName: email });

      const list = await service.listUsers(slug, companyId, `userName eq "${email}"`, undefined, undefined);
      expect(list.totalResults).toBe(1);
      expect((list.Resources as Array<Record<string, unknown>>)[0].id).toBe(created.id);
    });

    it("returns zero results for a userName no SCIM user has been provisioned for yet", async () => {
      const { companyId, slug } = await createCompany();
      const list = await service.listUsers(slug, companyId, `userName eq "nobody-${randomUUID()}@example.com"`, undefined, undefined);
      expect(list.totalResults).toBe(0);
    });

    it("rejects an unsupported filter expression rather than silently ignoring it", async () => {
      const { companyId, slug } = await createCompany();
      await expect(service.listUsers(slug, companyId, "userName pr", undefined, undefined)).rejects.toThrow(
        BadRequestException
      );
    });

    it("404s for a user id that belongs to a different tenant", async () => {
      const companyA = await createCompany();
      const companyB = await createCompany();
      const created = await service.createUser(companyA.slug, companyA.companyId, {
        userName: `isolated-${randomUUID()}@example.com`,
      });

      await expect(service.getUser(companyB.slug, companyB.companyId, created.id as string)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("patchUser", () => {
    it("deactivates via a path-based replace of active, and revokes any active session", async () => {
      const { companyId, slug } = await createCompany();
      const created = await service.createUser(slug, companyId, {
        userName: `patch-deactivate-${randomUUID()}@example.com`,
      });
      const sessionId = await createActiveSession(created.id as string, companyId);

      const patched = await service.patchUser(slug, companyId, created.id as string, {
        Operations: [{ op: "replace", path: "active", value: false }],
      });

      expect(patched.active).toBe(false);
      const account = await getUserAccount(created.id as string);
      expect(account.status).toBe("locked");

      const session = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT revoked_at FROM user_sessions WHERE id = $1", [sessionId])
      );
      expect(session.rows[0].revoked_at).not.toBeNull();
    });

    it("reactivates via the valueless-path form ({op, value: {active: true}})", async () => {
      const { companyId, slug } = await createCompany();
      const created = await service.createUser(slug, companyId, {
        userName: `patch-reactivate-${randomUUID()}@example.com`,
        active: false,
      });

      const patched = await service.patchUser(slug, companyId, created.id as string, {
        Operations: [{ op: "replace", value: { active: true } }],
      });

      expect(patched.active).toBe(true);
    });

    it("updates externalId and name via PATCH", async () => {
      const { companyId, slug } = await createCompany();
      const created = await service.createUser(slug, companyId, {
        userName: `patch-name-${randomUUID()}@example.com`,
      });

      const patched = await service.patchUser(slug, companyId, created.id as string, {
        Operations: [
          { op: "replace", path: "externalId", value: "new-external-id" },
          { op: "replace", path: "name.givenName", value: "Grace" },
        ],
      });

      expect(patched.externalId).toBe("new-external-id");
      expect((patched.name as Record<string, unknown>).givenName).toBe("Grace");
    });

    it("rejects an unsupported PATCH path rather than silently no-op'ing", async () => {
      const { companyId, slug } = await createCompany();
      const created = await service.createUser(slug, companyId, {
        userName: `patch-unsupported-${randomUUID()}@example.com`,
      });
      await expect(
        service.patchUser(slug, companyId, created.id as string, {
          Operations: [{ op: "replace", path: "nickName", value: "nope" }],
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("404s patching a user id this tenant never provisioned", async () => {
      const { companyId, slug } = await createCompany();
      await expect(
        service.patchUser(slug, companyId, randomUUID(), { Operations: [{ op: "replace", path: "active", value: false }] })
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("replaceUser (PUT)", () => {
    it("replaces name/externalId/active in one call", async () => {
      const { companyId, slug } = await createCompany();
      const created = await service.createUser(slug, companyId, {
        userName: `put-${randomUUID()}@example.com`,
      });

      const replaced = await service.replaceUser(slug, companyId, created.id as string, {
        userName: created.userName as string,
        externalId: "put-external-id",
        name: { givenName: "Put", familyName: "Replace" },
        active: false,
      });

      expect(replaced.externalId).toBe("put-external-id");
      expect(replaced.active).toBe(false);
      const account = await getUserAccount(created.id as string);
      expect(account.status).toBe("locked");
    });
  });

  describe("deleteUser", () => {
    it("deactivates the account without deleting it or its role assignment", async () => {
      const { companyId, slug } = await createCompany();
      const created = await service.createUser(slug, companyId, {
        userName: `delete-${randomUUID()}@example.com`,
      });

      await service.deleteUser(companyId, created.id as string);

      const account = await getUserAccount(created.id as string);
      expect(account).toBeTruthy();
      expect(account.status).toBe("locked");
      expect(await getRoleKeyForAssignment(created.id as string, companyId)).toBeTruthy();
    });

    it("404s deleting a user id this tenant never provisioned", async () => {
      const { companyId } = await createCompany();
      await expect(service.deleteUser(companyId, randomUUID())).rejects.toThrow(NotFoundException);
    });
  });

  describe("admin token management", () => {
    it("generateToken enables SCIM and returns a token whose hash matches what's stored", async () => {
      const { companyId } = await createCompany();
      const { token } = await service.generateToken(FIXTURE_CLAIMS, companyId);

      const status = await service.getStatus(FIXTURE_CLAIMS, companyId);
      expect(status.enabled).toBe(true);
      expect(status.hasToken).toBe(true);

      const stored = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT scim_bearer_token_hash FROM tenant_integrations WHERE company_id = $1 AND provider_key = 'sso'", [
          companyId,
        ])
      );
      expect(stored.rows[0].scim_bearer_token_hash).toBe(hashScimToken(token));
    });

    it("works even when the tenant has never configured an sso integration row at all", async () => {
      const companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const slug = uniqueSlug("scim-spec-bare-co");
        const result = await client.query(
          "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
          [`SCIM Bare Co ${slug}`, slug]
        );
        return result.rows[0].id as string;
      });

      const { token } = await service.generateToken(FIXTURE_CLAIMS, companyId);
      expect(token).toBeTruthy();
      const status = await service.getStatus(FIXTURE_CLAIMS, companyId);
      expect(status.enabled).toBe(true);
    });

    it("disableScim clears both the enabled flag and the stored hash", async () => {
      const { companyId } = await createCompany();
      await service.generateToken(FIXTURE_CLAIMS, companyId);

      await service.disableScim(FIXTURE_CLAIMS, companyId);

      const status = await service.getStatus(FIXTURE_CLAIMS, companyId);
      expect(status.enabled).toBe(false);
      expect(status.hasToken).toBe(false);
    });
  });
});
