import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { AuthService } from "../auth/auth.service";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { OidcSsoConfig, PublicSsoStatus } from "@aihxm/shared-types";
import { normalizeEmail } from "../auth/email.util";
import { signSsoStateTicket, verifySsoStateTicket } from "../auth/tickets";
import { loadOpenidClient } from "./openid-client-loader";

/** Never carries a real user's claims — see tenant-context.ts's doc comment on `is_service`. */
const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "sso-service" };

// Not a real password anyone could ever authenticate with — bcrypt-shaped
// but derived from cryptographically random bytes never persisted
// anywhere else, and never returned from any endpoint. `user_accounts.
// password_hash` stays NOT NULL for every row (a deliberate choice — see
// migration 0059's header comment — over making the column nullable and
// touching every existing read of it), so an 'sso' account needs SOME
// value here that can never validate against ANY real password.
function unusablePasswordPlaceholder(): string {
  return `sso-only:${randomBytes(32).toString("hex")}`;
}

// The API's OWN public URL — needed here for the first time in this
// codebase because it's what has to be registered as this integration's
// "Redirect URI" with every tenant's IdP; nothing before this ever needed
// to construct a fully-qualified link back to the API itself (the
// frontend/Netlify proxy pattern meant the API never had to know its own
// external address). `RENDER_EXTERNAL_URL` is set automatically by Render
// for every deployed service — zero configuration needed in the common
// case; `API_BASE_URL` is the explicit override for local dev, tests, or
// a non-Render host.
function apiBaseUrl(): string {
  const base = process.env.RENDER_EXTERNAL_URL ?? process.env.API_BASE_URL ?? "http://localhost:4000";
  return base.replace(/\/+$/, "");
}

// The frontend's own URL — this is exactly what APP_BASE_URL already
// means elsewhere in this file's sibling (AuthService's password-reset
// link), so it's reused as-is rather than introducing a second env var
// for the same concept under a different name.
function frontendOrigin(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
}

/**
 * Phase 3 item #1 (slice 1 of 3 — see the roadmap doc's Phase 3 entry) —
 * OpenID Connect as a Relying Party. SAML 2.0 support and SCIM inbound
 * provisioning are separate, later slices; this is deliberately scoped to
 * OIDC only, the more broadly applicable of the two for a product with no
 * SAML-only enterprise customer yet.
 *
 * The whole flow is stateless on this side — no server-side session table
 * for an in-progress login — because the PKCE code_verifier and OIDC
 * nonce travel inside `SsoStateTicketPayload`, a short-lived signed JWT
 * that doubles as the OAuth `state` parameter (see tickets.ts's doc
 * comment on it).
 */
@Injectable()
export class SsoService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authService: AuthService,
    private readonly audit: AuditService
  ) {}

  /** The public, no-session "does this tenant show an SSO button" check — see PublicSsoStatus's doc comment. */
  async getPublicStatus(companySlug: string): Promise<PublicSsoStatus> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query(
        `SELECT ti.enabled
         FROM companies c
         JOIN tenant_integrations ti ON ti.company_id = c.id AND ti.provider_key = 'sso'
         WHERE c.slug = $1 AND c.status NOT IN ('archived', 'churned')`,
        [companySlug]
      );
      const row = result.rows[0];
      return { enabled: Boolean(row?.enabled) };
    });
  }

  private async loadEnabledOidcConfig(
    client: import("pg").PoolClient,
    companySlug: string
  ): Promise<{ companyId: string; config: OidcSsoConfig }> {
    const result = await client.query(
      `SELECT c.id AS company_id, ti.config
       FROM companies c
       JOIN tenant_integrations ti ON ti.company_id = c.id AND ti.provider_key = 'sso'
       WHERE c.slug = $1 AND c.status NOT IN ('archived', 'churned') AND ti.enabled = true`,
      [companySlug]
    );
    if (result.rowCount === 0) {
      throw new NotFoundException("Single sign-on is not enabled for this company");
    }
    const config = result.rows[0].config as OidcSsoConfig;
    if (config.protocol !== "oidc" || !config.issuerUrl || !config.clientId || !config.clientSecret) {
      throw new BadRequestException("This company's single sign-on configuration is incomplete");
    }
    return { companyId: result.rows[0].company_id, config };
  }

  private async buildClient(config: OidcSsoConfig) {
    const client = await loadOpenidClient();
    return client.discovery(
      new URL(config.issuerUrl),
      config.clientId,
      { client_secret: config.clientSecret },
      undefined,
      // HTTPS-only discovery/token-exchange is the correct default for
      // every real IdP (Okta, Azure AD, Google, etc.) — this is NOT an
      // admin-configurable toggle (OidcSsoConfig has no such field on
      // purpose), only ever relaxed the same way this codebase's own
      // password-reset dev-mode token already is (auth.service.ts), so
      // `sso.e2e.spec.ts` can run its discovery/token exchange against a
      // genuine local mock IdP over plain HTTP without weakening what a
      // real deployment ever accepts.
      process.env.NODE_ENV === "production" ? undefined : { execute: [client.allowInsecureRequests] }
    );
  }

  private redirectUri(): string {
    return `${apiBaseUrl()}/auth/sso/callback`;
  }

  /** `GET /auth/sso/:companySlug/login`'s implementation — returns the URL to 302 the browser to. */
  async buildAuthorizationUrl(companySlug: string): Promise<string> {
    const client = await loadOpenidClient();
    const { companyId, config } = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      this.loadEnabledOidcConfig(c, companySlug)
    );
    const configuration = await this.buildClient(config);

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const nonce = client.randomNonce();

    const stateTicket = signSsoStateTicket({
      companyId,
      companySlug,
      codeVerifier,
      nonce,
      returnOrigin: frontendOrigin(),
    });

    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri(),
      scope: config.scopes ?? "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: stateTicket,
      nonce,
    });
    return url.href;
  }

  /**
   * `GET /auth/sso/callback`'s implementation. Returns the URL to 302 the
   * browser to next — always a `frontendOrigin()/sso/complete#...` URL,
   * success or failure, so the frontend has exactly one place to render
   * either outcome rather than the API trying to render HTML itself.
   * Never throws past the caller: every failure mode here is a
   * `redirectTo` carrying `#error=...` instead, since by this point the
   * browser is mid-redirect and has nowhere sensible to show a raw HTTP
   * error response.
   */
  async handleCallback(query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<{
    redirectTo: string;
  }> {
    // An IdP-side failure (user declined consent, misconfigured client)
    // carries `error`/`error_description` instead of `code`/`state` — no
    // state ticket to recover a return origin from, so this one case
    // falls back to the platform's own default frontend origin.
    if (query.error) {
      return {
        redirectTo: `${frontendOrigin()}/sso/complete#error=${encodeURIComponent(
          query.error_description ?? query.error
        )}`,
      };
    }
    if (!query.code || !query.state) {
      return { redirectTo: `${frontendOrigin()}/sso/complete#error=${encodeURIComponent("Malformed SSO callback")}` };
    }

    let ticket;
    try {
      ticket = verifySsoStateTicket(query.state);
    } catch (err) {
      return {
        redirectTo: `${frontendOrigin()}/sso/complete#error=${encodeURIComponent((err as Error).message)}`,
      };
    }

    try {
      const client = await loadOpenidClient();
      const { config } = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
        this.loadEnabledOidcConfig(c, ticket.companySlug)
      );
      const configuration = await this.buildClient(config);

      const currentUrl = new URL(this.redirectUri());
      currentUrl.searchParams.set("code", query.code);
      currentUrl.searchParams.set("state", query.state);
      const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: ticket.codeVerifier,
        expectedNonce: ticket.nonce,
        expectedState: query.state,
      });
      const claims = tokens.claims();
      if (!claims?.sub) {
        throw new Error("The identity provider did not return a subject claim");
      }
      const email = typeof claims.email === "string" ? claims.email : undefined;

      const token = await this.provisionAndIssueToken({
        companyId: ticket.companyId,
        companySlug: ticket.companySlug,
        externalSubject: claims.sub,
        externalEmail: email,
        groups: this.extractGroups(claims, config.groupsClaim),
        config,
      });

      return { redirectTo: `${ticket.returnOrigin}/sso/complete#token=${encodeURIComponent(token)}` };
    } catch (err) {
      return {
        redirectTo: `${ticket.returnOrigin}/sso/complete#error=${encodeURIComponent(
          err instanceof Error ? err.message : "Sign-in with your identity provider failed"
        )}`,
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractGroups(claims: Record<string, any>, groupsClaim: string | undefined): string[] {
    if (!groupsClaim) return [];
    const value = claims[groupsClaim];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return [];
  }

  /**
   * The JIT-provisioning core, kept as its own method precisely so it can
   * be unit-tested with a synthetic, already-verified claims object —
   * `sso.service.spec.ts` — without ever making a real network call to an
   * IdP; `handleCallback()` above is what the real network/token-exchange
   * path calls it from, and `sso.e2e.spec.ts` exercises that path with a
   * genuine local mock IdP end to end.
   *
   * Mirrors `SignupService.signup()`'s own "new account + role assignment
   * in one transaction" shape, with one deliberate difference: an
   * EXISTING account (found by federated identity, or by email within
   * this same tenant) never has its role changed by IdP group claims on a
   * later login — only a brand-new account gets a role assigned at all.
   * Silently re-granting or revoking privileges based on IdP group
   * membership on every login is a real, well-known footgun (a person
   * temporarily removed from an IdP group for an unrelated reason
   * shouldn't lose HR Admin access mid-session, and the reverse is worse);
   * changing a federated user's role is a deliberate admin action, not an
   * automatic side effect of them logging in again.
   */
  async provisionAndIssueToken(input: {
    companyId: string;
    companySlug: string;
    externalSubject: string;
    externalEmail?: string;
    groups: string[];
    config: OidcSsoConfig;
  }): Promise<string> {
    const userAccountId = await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const existingIdentity = await client.query<{ user_account_id: string }>(
        `SELECT user_account_id FROM federated_identities
         WHERE company_id = $1 AND provider_key = 'sso' AND external_subject = $2`,
        [input.companyId, input.externalSubject]
      );
      if ((existingIdentity.rowCount ?? 0) > 0) {
        const id = existingIdentity.rows[0].user_account_id;
        await client.query(
          `UPDATE federated_identities SET last_login_at = now(), external_email = $3
           WHERE company_id = $1 AND provider_key = 'sso' AND external_subject = $2`,
          [input.companyId, input.externalSubject, input.externalEmail ?? null]
        );
        return id;
      }

      const normalizedEmail = input.externalEmail ? normalizeEmail(input.externalEmail) : null;

      // Account linking: an existing member of THIS tenant whose
      // user_accounts.email matches the IdP's claimed email gets their
      // existing account linked, rather than a confusing duplicate second
      // account for the same person. Scoped to this company via
      // user_role_assignments/company_admins, same tables
      // resolveCompanyIdForAccount already treats as the source of truth
      // for tenant membership.
      let userAccountId: string | undefined;
      if (normalizedEmail) {
        const existingAccount = await client.query<{ id: string }>(
          `SELECT ua.id FROM user_accounts ua
           WHERE ua.email = $1
             AND (
               EXISTS (SELECT 1 FROM user_role_assignments ura WHERE ura.user_account_id = ua.id AND ura.company_id = $2)
               OR EXISTS (SELECT 1 FROM company_admins ca WHERE ca.user_account_id = ua.id AND ca.company_id = $2)
             )`,
          [normalizedEmail, input.companyId]
        );
        if ((existingAccount.rowCount ?? 0) > 0) userAccountId = existingAccount.rows[0].id;
      }

      let isNewAccount = false;
      if (!userAccountId) {
        if (!normalizedEmail) {
          throw new BadRequestException(
            "Your identity provider did not share an email address, which this login needs for a first-time sign-in"
          );
        }
        const alreadyUsedElsewhere = await client.query("SELECT 1 FROM user_accounts WHERE email = $1", [
          normalizedEmail,
        ]);
        if ((alreadyUsedElsewhere.rowCount ?? 0) > 0) {
          // A real, if rare, case: this email belongs to an account that
          // exists but isn't a member of THIS tenant (e.g. a Platform
          // Admin's own login, or a different company entirely) — refuse
          // rather than silently attaching a stranger's SSO identity to
          // it.
          throw new BadRequestException(
            "This email is already associated with a different AIHXM account. Contact your administrator."
          );
        }
        const created = await client.query<{ id: string }>(
          `INSERT INTO user_accounts (email, password_hash, auth_provider, mfa_enabled)
           VALUES ($1, $2, 'sso', true)
           RETURNING id`,
          [normalizedEmail, unusablePasswordPlaceholder()]
        );
        userAccountId = created.rows[0].id;
        isNewAccount = true;
      }

      await client.query(
        `INSERT INTO federated_identities (company_id, provider_key, external_subject, external_email, user_account_id, last_login_at)
         VALUES ($1, 'sso', $2, $3, $4, now())`,
        [input.companyId, input.externalSubject, input.externalEmail ?? null, userAccountId]
      );

      if (isNewAccount) {
        const roleKey = this.resolveRoleKey(input.groups, input.config);
        const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE key = $1", [roleKey]);
        if ((role.rowCount ?? 0) === 0) {
          throw new BadRequestException(
            `This company's SSO role mapping refers to an unknown role "${roleKey}"`
          );
        }
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, input.companyId, role.rows[0].id]
        );
      }

      await this.audit.record(client, { ...SERVICE_CLAIMS, sub: userAccountId }, {
        companyId: input.companyId,
        action: isNewAccount ? "sso.jit_provisioned" : "sso.login",
        target: input.externalSubject,
        metadata: { newAccount: isNewAccount },
      });

      return userAccountId;
    });

    return this.authService.issueSessionTokenForFederatedLogin(userAccountId);
  }

  private resolveRoleKey(groups: string[], config: OidcSsoConfig): string {
    if (config.roleMapping) {
      for (const group of groups) {
        const mapped = config.roleMapping[group];
        if (mapped) return mapped;
      }
    }
    // The same default every self-signup admin's own first non-admin
    // teammate effectively starts as elsewhere in this codebase — the
    // least-privileged real role, never an implicit admin grant.
    return config.defaultRoleKey ?? "employee_self_service";
  }
}
