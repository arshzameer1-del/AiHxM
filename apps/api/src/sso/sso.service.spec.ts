import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { SsoService } from "./sso.service";
import { AuthService } from "../auth/auth.service";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import { DatabaseService } from "../database/database.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";
import { PG_POOL } from "../database/pg-pool.token";
import type { RequestClaims } from "../database/tenant-context";
import type { OidcSsoConfig, SamlSsoConfig } from "@aihxm/shared-types";

/**
 * `provisionAndIssueToken()` (the JIT-provisioning core) and
 * `getPublicStatus()`, both exercised directly against the real database
 * with synthetic, already-verified claims — no network call to an IdP,
 * no `openid-client` involved. `sso.e2e.spec.ts` is what drives the real
 * OIDC discovery/token-exchange path end to end, against a genuine local
 * mock issuer.
 */
const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "sso-service-spec-fixtures",
};

describe("SsoService", () => {
  let service: SsoService;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
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

    service = module.get<SsoService>(SsoService);
  });

  afterAll(async () => {
    await pool.end();
  });

  function uniqueSlug(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Inserts a company (and, unless `enabled: false` is passed, an enabled `sso` tenant_integrations row) directly, bypassing the Platform Admin API entirely. */
  async function createCompanyWithSso(config?: Partial<OidcSsoConfig> & { enabled?: boolean }): Promise<{
    companyId: string;
    slug: string;
  }> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const slug = uniqueSlug("sso-spec-co");
      const companyResult = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`SSO Spec Co ${slug}`, slug]
      );
      const companyId = companyResult.rows[0].id as string;

      const fullConfig: OidcSsoConfig = {
        protocol: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "spec-client-id",
        clientSecret: "spec-client-secret",
        ...config,
      };
      await client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, updated_by)
         VALUES ($1, 'sso', $2, $3::jsonb, 'sso-spec-fixtures')`,
        [companyId, config?.enabled ?? true, JSON.stringify(fullConfig)]
      );

      return { companyId, slug };
    });
  }

  /** Creates a real local (password) account already belonging to the given tenant, mirroring what a normal admin-created login looks like. */
  async function createLocalTenantAccount(companyId: string, email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query<{ id: string }>(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'sso-spec-not-a-real-hash') RETURNING id",
        [email]
      );
      const userAccountId = account.rows[0].id;
      const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, role.rows[0].id]
      );
      return userAccountId;
    });
  }

  async function getUserAccount(id: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "SELECT id, email, auth_provider, mfa_enabled FROM user_accounts WHERE id = $1",
        [id]
      );
      return result.rows[0];
    });
  }

  async function getFederatedIdentity(companyId: string, externalSubject: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "SELECT * FROM federated_identities WHERE company_id = $1 AND provider_key = 'sso' AND external_subject = $2",
        [companyId, externalSubject]
      );
      return result.rows[0];
    });
  }

  async function getRoleKeyForAssignment(userAccountId: string, companyId: string): Promise<string | undefined> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `SELECT r.key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.user_account_id = $1 AND ura.company_id = $2`,
        [userAccountId, companyId]
      );
      return result.rows[0]?.key;
    });
  }

  describe("getPublicStatus", () => {
    it("returns enabled: true for a company with SSO configured and enabled", async () => {
      const { slug } = await createCompanyWithSso({ enabled: true });
      await expect(service.getPublicStatus(slug)).resolves.toEqual({ enabled: true });
    });

    it("returns enabled: false for a company whose SSO integration is disabled", async () => {
      const { slug } = await createCompanyWithSso({ enabled: false });
      await expect(service.getPublicStatus(slug)).resolves.toEqual({ enabled: false });
    });

    it("returns enabled: false for a company with no SSO integration row at all", async () => {
      const slug = uniqueSlug("sso-spec-no-integration");
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter')", [
          `SSO Spec Co ${slug}`,
          slug,
        ])
      );
      await expect(service.getPublicStatus(slug)).resolves.toEqual({ enabled: false });
    });

    it("returns enabled: false for a slug that doesn't exist at all", async () => {
      await expect(service.getPublicStatus("no-such-company-slug")).resolves.toEqual({ enabled: false });
    });
  });

  describe("provisionAndIssueToken", () => {
    it("creates a brand-new SSO account on a first-time login, with the config's default role", async () => {
      const { companyId, slug } = await createCompanyWithSso({ defaultRoleKey: "employee_self_service" });
      const externalSubject = randomUUID();
      const email = `first-time-${externalSubject}@example.com`;

      const token = await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: email,
        groups: [],
        config: { protocol: "oidc", issuerUrl: "x", clientId: "x", clientSecret: "x", defaultRoleKey: "employee_self_service" },
      });

      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);

      const identity = await getFederatedIdentity(companyId, externalSubject);
      expect(identity).toBeTruthy();
      expect(identity.external_email).toBe(email);

      const account = await getUserAccount(identity.user_account_id);
      expect(account.email).toBe(email);
      expect(account.auth_provider).toBe("sso");
      // Mandatory-MFA is the whole rest of this app's login posture — an
      // SSO account still has mfa_enabled true, even though it never
      // actually goes through this app's own TOTP flow, so nothing else
      // that reads this column has to special-case an SSO account.
      expect(account.mfa_enabled).toBe(true);

      const roleKey = await getRoleKeyForAssignment(identity.user_account_id, companyId);
      expect(roleKey).toBe("employee_self_service");
    });

    it("uses the config's roleMapping to resolve a role from the IdP's groups claim", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      const externalSubject = randomUUID();
      const config: OidcSsoConfig = {
        protocol: "oidc",
        issuerUrl: "x",
        clientId: "x",
        clientSecret: "x",
        groupsClaim: "groups",
        roleMapping: { "idp-hr-group": "hr_admin" },
        defaultRoleKey: "employee_self_service",
      };

      const identityBefore = await getFederatedIdentity(companyId, externalSubject);
      expect(identityBefore).toBeUndefined();

      await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: `mapped-${externalSubject}@example.com`,
        groups: ["some-other-group", "idp-hr-group"],
        config,
      });

      const identity = await getFederatedIdentity(companyId, externalSubject);
      const roleKey = await getRoleKeyForAssignment(identity.user_account_id, companyId);
      expect(roleKey).toBe("hr_admin");
    });

    it("reuses the same account on a returning login for the same external subject, without creating a second one", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      const externalSubject = randomUUID();
      const email = `returning-${externalSubject}@example.com`;
      const config: OidcSsoConfig = { protocol: "oidc", issuerUrl: "x", clientId: "x", clientSecret: "x" };

      await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: email,
        groups: [],
        config,
      });
      const firstIdentity = await getFederatedIdentity(companyId, externalSubject);

      // A real second login some time later — the IdP might even report a
      // slightly different email (e.g. after the person's own rename in
      // the IdP) — last_login_at/external_email should update in place,
      // never a second user_accounts row.
      await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: `renamed-${email}`,
        groups: [],
        config,
      });

      const secondIdentity = await getFederatedIdentity(companyId, externalSubject);
      expect(secondIdentity.user_account_id).toBe(firstIdentity.user_account_id);
      expect(secondIdentity.external_email).toBe(`renamed-${email}`);
      expect(new Date(secondIdentity.last_login_at).getTime()).toBeGreaterThanOrEqual(
        new Date(firstIdentity.last_login_at).getTime()
      );

      const accountCount = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT count(*) FROM user_accounts WHERE email = $1", [email])
      );
      expect(Number(accountCount.rows[0].count)).toBe(1);
    });

    it("links to an existing account already in this tenant that matches the IdP's claimed email, instead of duplicating it", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      const email = `existing-member-${randomUUID()}@example.com`;
      const existingUserAccountId = await createLocalTenantAccount(companyId, email);
      // Give the existing account a role OTHER than the SSO config's
      // default, so the "never re-role on link" assertion below is
      // actually meaningful.
      const roleBefore = await getRoleKeyForAssignment(existingUserAccountId, companyId);
      expect(roleBefore).toBe("hr_admin");

      const externalSubject = randomUUID();
      await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: email,
        groups: ["idp-hr-group"],
        config: {
          protocol: "oidc",
          issuerUrl: "x",
          clientId: "x",
          clientSecret: "x",
          groupsClaim: "groups",
          roleMapping: { "idp-hr-group": "employee_self_service" },
        },
      });

      const identity = await getFederatedIdentity(companyId, externalSubject);
      expect(identity.user_account_id).toBe(existingUserAccountId);

      // Linking must never change auth_provider on an existing local
      // account, and must never touch its existing role assignment based
      // on the IdP's group claims — see provisionAndIssueToken's own doc
      // comment on why that's a deliberate, not-yet-implemented decision.
      const account = await getUserAccount(existingUserAccountId);
      expect(account.auth_provider).toBe("local");
      const roleAfter = await getRoleKeyForAssignment(existingUserAccountId, companyId);
      expect(roleAfter).toBe("hr_admin");
    });

    it("rejects a first-time login when the IdP shares no email at all", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      await expect(
        service.provisionAndIssueToken({
          companyId,
          companySlug: slug,
          externalSubject: randomUUID(),
          externalEmail: undefined,
          groups: [],
          config: { protocol: "oidc", issuerUrl: "x", clientId: "x", clientSecret: "x" },
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a first-time login whose claimed email already belongs to an account outside this tenant", async () => {
      const { companyId: otherCompanyId } = await createCompanyWithSso();
      const email = `cross-tenant-${randomUUID()}@example.com`;
      await createLocalTenantAccount(otherCompanyId, email);

      const { companyId, slug } = await createCompanyWithSso();
      await expect(
        service.provisionAndIssueToken({
          companyId,
          companySlug: slug,
          externalSubject: randomUUID(),
          externalEmail: email,
          groups: [],
          config: { protocol: "oidc", issuerUrl: "x", clientId: "x", clientSecret: "x" },
        })
      ).rejects.toThrow(BadRequestException);
    });

    // provisionAndIssueToken/resolveRoleKey are written once against
    // SsoIntegrationConfig — the union of OidcSsoConfig and
    // SamlSsoConfig — precisely so the JIT-provisioning logic above never
    // needs a second, near-identical copy for SAML. These two tests exist
    // to prove that generalization actually holds, not just compiles: the
    // exact same account-creation/role-mapping behavior already proven
    // above for an OidcSsoConfig also holds for a SamlSsoConfig, with
    // nothing SAML-specific about it at this layer (that specificity —
    // NameID, assertion attributes, XML-DSig — lives entirely in
    // handleSamlAcs()/buildSamlClient(), covered by sso.e2e.spec.ts's own
    // SAML suite against a genuine mock IdP).
    it("provisions a brand-new account from a SAML config exactly like an OIDC one, with the config's default role", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      const externalSubject = `saml-nameid-${randomUUID()}@example.com`;
      const email = `saml-first-time-${randomUUID()}@example.com`;
      const config: SamlSsoConfig = {
        protocol: "saml",
        idpEntityId: "https://idp.example.com/saml",
        idpSsoUrl: "https://idp.example.com/saml/sso",
        idpCertificate: "-----BEGIN CERTIFICATE-----\nspec-not-a-real-cert\n-----END CERTIFICATE-----",
        defaultRoleKey: "employee_self_service",
      };

      const token = await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: email,
        groups: [],
        config,
      });

      expect(typeof token).toBe("string");
      const identity = await getFederatedIdentity(companyId, externalSubject);
      expect(identity.external_email).toBe(email);
      const account = await getUserAccount(identity.user_account_id);
      expect(account.auth_provider).toBe("sso");
      const roleKey = await getRoleKeyForAssignment(identity.user_account_id, companyId);
      expect(roleKey).toBe("employee_self_service");
    });

    it("uses a SAML config's roleMapping to resolve a role from the assertion's groups attribute", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      const externalSubject = `saml-mapped-${randomUUID()}@example.com`;
      const config: SamlSsoConfig = {
        protocol: "saml",
        idpEntityId: "https://idp.example.com/saml",
        idpSsoUrl: "https://idp.example.com/saml/sso",
        idpCertificate: "-----BEGIN CERTIFICATE-----\nspec-not-a-real-cert\n-----END CERTIFICATE-----",
        groupsAttribute: "groups",
        roleMapping: { "idp-hr-group": "hr_admin" },
        defaultRoleKey: "employee_self_service",
      };

      await service.provisionAndIssueToken({
        companyId,
        companySlug: slug,
        externalSubject,
        externalEmail: `mapped-${randomUUID()}@example.com`,
        groups: ["idp-hr-group"],
        config,
      });

      const identity = await getFederatedIdentity(companyId, externalSubject);
      const roleKey = await getRoleKeyForAssignment(identity.user_account_id, companyId);
      expect(roleKey).toBe("hr_admin");
    });

    it("rejects a role mapping that resolves to a role key nothing recognizes", async () => {
      const { companyId, slug } = await createCompanyWithSso();
      await expect(
        service.provisionAndIssueToken({
          companyId,
          companySlug: slug,
          externalSubject: randomUUID(),
          externalEmail: `bad-role-${randomUUID()}@example.com`,
          groups: [],
          config: {
            protocol: "oidc",
            issuerUrl: "x",
            clientId: "x",
            clientSecret: "x",
            defaultRoleKey: "not_a_real_role",
          },
        })
      ).rejects.toThrow(BadRequestException);
    });
  });
});
