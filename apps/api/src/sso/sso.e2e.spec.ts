import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { randomUUID } from "crypto";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { OidcSsoConfig } from "@aihxm/shared-types";
import { MockOidcIssuer } from "./test-mock-oidc-issuer";

// Swaps the real (pure-ESM) `openid-client` package for a hand-written
// stand-in that talks the exact same protocol to `MockOidcIssuer` over
// real HTTP — see `test-openid-client-stub.ts`'s own doc comment for why
// this is a Jest-loader limitation, not a gap in what this test actually
// verifies about `SsoService`.
jest.mock("./openid-client-loader", () => ({
  // `require` (not `import`) is what a `jest.mock` factory needs — it has
  // to hand back the module synchronously, before this file's own
  // imports even finish resolving (Jest hoists `jest.mock` calls above
  // them). This is the one narrow, well-understood exception to this
  // codebase's usual ESM-import style, scoped to this single line.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadOpenidClient: () => Promise.resolve(require("./test-openid-client-stub")),
}));

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "sso-e2e-fixtures",
};

/**
 * The real HTTP surface (`sso.controller.ts`) driven end to end against a
 * genuine local OpenID Provider (`MockOidcIssuer`) — real discovery, real
 * PKCE, a real RS256-signed ID token checked against a real JWKS, and a
 * real token exchange, with only the identity-provider side of the
 * protocol standing in for a real IdP like Okta or Azure AD.
 *
 * Supertest only drives requests against THIS app's own HTTP server, so
 * the redirect chain (this app -> mock IdP -> this app again) is chased
 * by hand: `GET /auth/sso/:slug/login` returns the mock IdP's
 * authorization URL as a `Location` header (never followed automatically —
 * supertest's default is not to follow redirects), a plain `fetch` with
 * `redirect: "manual"` hits that URL for real (it's the mock issuer's own
 * real listening port), and the `code`/`state` it redirects back with are
 * then handed to `GET /auth/sso/callback` as this app would receive them
 * from any real browser.
 */
describe("SSO OIDC HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let issuer: MockOidcIssuer;

  beforeAll(async () => {
    issuer = new MockOidcIssuer();
    await issuer.start();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await issuer.stop();
  });

  function uniqueSlug(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function createCompanyWithSso(config?: Partial<OidcSsoConfig>): Promise<{ companyId: string; slug: string }> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const slug = uniqueSlug("sso-e2e-co");
      const companyResult = await client.query(
        "INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter') RETURNING id",
        [`SSO E2E Co ${slug}`, slug]
      );
      const companyId = companyResult.rows[0].id as string;
      const fullConfig: OidcSsoConfig = {
        protocol: "oidc",
        issuerUrl: issuer.baseUrl,
        clientId: issuer.clientId,
        clientSecret: issuer.clientSecret,
        ...config,
      };
      await client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, updated_by)
         VALUES ($1, 'sso', true, $2::jsonb, 'sso-e2e-fixtures')`,
        [companyId, JSON.stringify(fullConfig)]
      );
      return { companyId, slug };
    });
  }

  /** Drives one full login: /login -> (real) mock IdP -> /callback, returning the final redirect's fragment params. */
  async function driveSsoLogin(slug: string): Promise<URLSearchParams> {
    const loginRes = await request(app.getHttpServer()).get(`/auth/sso/${slug}/login`);
    expect(loginRes.status).toBe(302);
    const authorizeUrl = loginRes.headers.location as string;

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeRes.status).toBe(302);
    const redirectBackUrl = new URL(authorizeRes.headers.get("location") as string);
    const code = redirectBackUrl.searchParams.get("code") as string;
    const state = redirectBackUrl.searchParams.get("state") as string;

    const callbackRes = await request(app.getHttpServer()).get("/auth/sso/callback").query({ code, state });
    expect(callbackRes.status).toBe(302);
    const finalUrl = new URL(callbackRes.headers.location as string);
    expect(finalUrl.pathname).toBe("/sso/complete");
    return new URLSearchParams(finalUrl.hash.replace(/^#/, ""));
  }

  it("provisions a brand-new account and returns a real, usable session token on first login", async () => {
    const { slug } = await createCompanyWithSso({ defaultRoleKey: "employee_self_service" });
    const email = `sso-e2e-new-${randomUUID()}@example.com`;
    issuer.nextIdentity = { subject: randomUUID(), email };

    const params = await driveSsoLogin(slug);
    expect(params.get("error")).toBeNull();
    const token = params.get("token");
    expect(token).toBeTruthy();

    const meRes = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.isPlatformAdmin).toBe(false);
    expect(meRes.body.companySlug).toBe(slug);
  });

  it("reuses the same session-issuing identity on a second login for the same subject", async () => {
    const { slug } = await createCompanyWithSso();
    const subject = randomUUID();
    issuer.nextIdentity = { subject, email: `sso-e2e-returning-${subject}@example.com` };

    const first = await driveSsoLogin(slug);
    const firstToken = first.get("token");
    expect(firstToken).toBeTruthy();
    const firstMe = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${firstToken}`);

    const second = await driveSsoLogin(slug);
    const secondToken = second.get("token");
    expect(secondToken).toBeTruthy();
    const secondMe = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${secondToken}`);

    // Two different session tokens for two different logins, but the
    // SAME underlying identity both times — never a second account.
    expect(secondMe.body.email).toBe(firstMe.body.email);
  });

  it("assigns the role mapped from the IdP's groups claim on first login", async () => {
    const { slug } = await createCompanyWithSso({
      groupsClaim: "groups",
      roleMapping: { "idp-hr-admins": "hr_admin" },
      defaultRoleKey: "employee_self_service",
    });
    issuer.nextIdentity = {
      subject: randomUUID(),
      email: `sso-e2e-mapped-${randomUUID()}@example.com`,
      groups: ["idp-hr-admins"],
    };

    const params = await driveSsoLogin(slug);
    const token = params.get("token");
    const meRes = await request(app.getHttpServer()).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect(meRes.body.roleKeys).toContain("hr_admin");
  });

  it("carries an IdP-side error straight through to the frontend as a #error fragment, never a raw 500", async () => {
    const callbackRes = await request(app.getHttpServer())
      .get("/auth/sso/callback")
      .query({ error: "access_denied", error_description: "User declined consent" });
    expect(callbackRes.status).toBe(302);
    const finalUrl = new URL(callbackRes.headers.location as string);
    const params = new URLSearchParams(finalUrl.hash.replace(/^#/, ""));
    expect(params.get("error")).toBe("User declined consent");
    expect(params.get("token")).toBeNull();
  });

  it("rejects a tampered state parameter with a #error fragment instead of a session", async () => {
    const { slug } = await createCompanyWithSso();
    issuer.nextIdentity = { subject: randomUUID(), email: `sso-e2e-tampered-${randomUUID()}@example.com` };

    const loginRes = await request(app.getHttpServer()).get(`/auth/sso/${slug}/login`);
    const authorizeUrl = loginRes.headers.location as string;
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const redirectBackUrl = new URL(authorizeRes.headers.get("location") as string);
    const code = redirectBackUrl.searchParams.get("code") as string;

    const callbackRes = await request(app.getHttpServer())
      .get("/auth/sso/callback")
      .query({ code, state: "this-is-not-a-real-signed-ticket" });
    expect(callbackRes.status).toBe(302);
    const finalUrl = new URL(callbackRes.headers.location as string);
    const params = new URLSearchParams(finalUrl.hash.replace(/^#/, ""));
    expect(params.get("error")).toBeTruthy();
    expect(params.get("token")).toBeNull();
  });

  it("404s the login route for a company with no SSO integration configured at all", async () => {
    const slug = uniqueSlug("sso-e2e-no-sso");
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("INSERT INTO companies (name, slug, status, package_tier) VALUES ($1, $2, 'active', 'starter')", [
        `SSO E2E Co ${slug}`,
        slug,
      ])
    );
    const res = await request(app.getHttpServer()).get(`/auth/sso/${slug}/login`);
    expect(res.status).toBe(404);
  });

  it("GET /public/tenants/:slug/sso reflects the real enabled state, no auth required", async () => {
    const { slug } = await createCompanyWithSso();
    const res = await request(app.getHttpServer()).get(`/public/tenants/${slug}/sso`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });
});
