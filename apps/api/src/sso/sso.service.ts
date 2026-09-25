import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, randomUUID } from "crypto";
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import { AuthService } from "../auth/auth.service";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { OidcSsoConfig, SamlSsoConfig, SsoIntegrationConfig, PublicSsoStatus } from "@aihxm/shared-types";
import { normalizeEmail } from "../auth/email.util";
import {
  signSsoStateTicket,
  verifySsoStateTicket,
  signSamlStateTicket,
  verifySamlStateTicket,
} from "../auth/tickets";
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

// This SP's own SAML Entity ID / Audience — one static, deliberately
// non-resolving `urn:` value (not this API's own URL) handed to every
// tenant's IdP admin, the same "one static value, company recovered from
// signed state instead of the URL" posture `redirectUri()` already
// established for OIDC. A `urn:` value never needs to resolve — Entity
// IDs are opaque identifiers, not endpoints, and Okta/Azure AD/OneLogin
// all accept one as freely as a URL — so this deliberately isn't built
// from `apiBaseUrl()` (which WOULD change if this API ever moves off its
// current Render URL, silently invalidating every tenant's Audience
// Restriction check until they re-typed it). `SAML_SP_ENTITY_ID` exists
// only for the rare case of running more than one AIHXM environment
// against the same tenant's IdP (e.g. a staging deploy) and needing them
// to look like distinct SPs.
function samlSpEntityId(): string {
  return process.env.SAML_SP_ENTITY_ID ?? "urn:aihxm:sp";
}

function samlAcsUrl(): string {
  return `${apiBaseUrl()}/auth/sso/saml/acs`;
}

/**
 * Phase 3 item #1 — SSO & Identity Federation. Slice 1 (OpenID Connect as
 * a Relying Party) and slice 2 (SAML 2.0 as a Service Provider) share this
 * one service: both are just different ways to answer the same question
 * ("who is this, and which local account/role does that map to"), so
 * `provisionAndIssueToken()`/`resolveRoleKey()` below are written once,
 * against `SsoIntegrationConfig`, and never duplicated per protocol.
 * SCIM inbound provisioning remains a separate, later slice.
 *
 * Both protocols' login flows are stateless on this side — no
 * server-side session table for an in-progress login. OIDC's PKCE
 * code_verifier and nonce travel inside `SsoStateTicketPayload`; SAML's
 * `<AuthnRequest ID>` travels inside `SamlStateTicketPayload` — both
 * short-lived signed JWTs that double as, respectively, OIDC's `state`
 * parameter and SAML's `RelayState` value (see tickets.ts's doc comments
 * on each).
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

  /**
   * Loads the `sso` integration row regardless of which protocol it's
   * configured for, and validates it's complete FOR that protocol —
   * `config.protocol` is the discriminant a real admin's saved config
   * always carries (`CompanyDetailPage.tsx`'s Integrations tab always
   * sets it; see that file's own doc comment on why), so an incomplete or
   * pre-Phase-3 row (no `protocol` at all) fails the same
   * `BadRequestException` either protocol's caller already handles.
   */
  private async loadEnabledSsoConfig(
    client: import("pg").PoolClient,
    companySlug: string
  ): Promise<{ companyId: string; config: SsoIntegrationConfig }> {
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
    const config = result.rows[0].config as SsoIntegrationConfig;
    if (config.protocol === "oidc") {
      if (!config.issuerUrl || !config.clientId || !config.clientSecret) {
        throw new BadRequestException("This company's single sign-on configuration is incomplete");
      }
    } else if (config.protocol === "saml") {
      if (!config.idpEntityId || !config.idpSsoUrl || !config.idpCertificate) {
        throw new BadRequestException("This company's single sign-on configuration is incomplete");
      }
    } else {
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

  /**
   * Builds a configured `SAML` client for one login attempt.
   * `generateUniqueId` is overridden to return the exact `requestId` the
   * caller already generated (and already put in the signed
   * `SamlStateTicketPayload`) — never the library's own default generator
   * — so the `<AuthnRequest ID>` this produces is a value `handleSamlAcs()`
   * can independently recognize later without any server-side request
   * cache (see `SamlStateTicketPayload`'s own doc comment for why).
   *
   * `wantAuthnResponseSigned: false` is the one deliberate departure from
   * this library's own (secure) defaults, and it's an interop fix, not a
   * weakening: Okta's own default SAML app configuration — the single
   * most common real IdP an SMB customer will actually have — signs only
   * the `<Assertion>`, never the enclosing `<Response>`. Leaving this at
   * the library default of `true` would reject that default Okta setup
   * outright with "Invalid document signature" before a real customer
   * ever got to try it. `wantAssertionsSigned` stays at its own secure
   * default (`true`, explicit here for clarity) — that is what actually
   * gets checked, cryptographically, against `idpCertificate`, and it is
   * never skipped.
   *
   * This SP signs no `AuthnRequest` of its own (`privateKey` is never
   * set) — HTTP-Redirect-bound, unsigned SP AuthnRequests are what every
   * major IdP's default WebSSO app configuration (Okta, Azure AD,
   * OneLogin, Google Workspace) already expects and accepts; supporting
   * SP-initiated request signing would mean generating and rotating this
   * SP's own keypair per tenant for a property almost no SMB customer's
   * IdP will ever require. A real, additive follow-up if one ever does.
   */
  private buildSamlClient(config: SamlSsoConfig, requestId: string): SAML {
    return new SAML({
      issuer: samlSpEntityId(),
      callbackUrl: samlAcsUrl(),
      entryPoint: config.idpSsoUrl,
      idpCert: config.idpCertificate,
      idpIssuer: config.idpEntityId,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.never,
      // A few seconds of real-world clock drift between this API's host
      // and a tenant's own IdP is normal, not an attack — without this,
      // `<Conditions NotBefore/NotOnOrAfter>` checks fail intermittently
      // for reasons that have nothing to do with this login actually
      // being stale or replayed.
      acceptedClockSkewMs: 5_000,
      generateUniqueId: () => requestId,
    });
  }

  /** `GET /auth/sso/:companySlug/login`'s implementation — returns the URL to 302 the browser to. */
  async buildAuthorizationUrl(companySlug: string): Promise<string> {
    const { companyId, config } = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
      this.loadEnabledSsoConfig(c, companySlug)
    );

    if (config.protocol === "saml") {
      // SAML request IDs are `xsd:ID`s (NCNames) — must start with a
      // letter or underscore, never a bare digit, which a raw UUID
      // sometimes does. The leading underscore is the same convention
      // `@node-saml/node-saml`'s own default generator uses.
      const requestId = `_${randomUUID()}`;
      const saml = this.buildSamlClient(config, requestId);
      const stateTicket = signSamlStateTicket({
        companyId,
        companySlug,
        requestId,
        returnOrigin: frontendOrigin(),
      });
      return saml.getAuthorizeUrlAsync(stateTicket, undefined, {});
    }

    const client = await loadOpenidClient();
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
      const { config: ssoConfig } = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
        this.loadEnabledSsoConfig(c, ticket.companySlug)
      );
      // This ticket only ever comes from `buildAuthorizationUrl()`'s own
      // OIDC branch, but the tenant's config is re-read fresh here (not
      // carried in the ticket) — an admin could in principle switch this
      // integration to `protocol: "saml"` in the few minutes between a
      // browser starting this login and finishing it, so this is a real,
      // if rare, case to fail closed on rather than assume away.
      if (ssoConfig.protocol !== "oidc") {
        throw new Error("This company's single sign-on configuration has changed. Please try signing in again.");
      }
      const config = ssoConfig;
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
   * `POST /auth/sso/saml/acs`'s implementation — the SAML sibling of
   * `handleCallback()` above, same "never throws past the caller, every
   * failure becomes a `#error=` redirect" posture, for the same reason
   * (by the time the IdP's own HTTP-POST-bound form has landed here, the
   * browser is mid-navigation with nowhere sensible to show a raw error).
   *
   * `RelayState` carries `SamlStateTicketPayload` exactly the way OIDC's
   * `state` carries `SsoStateTicketPayload` — see that type's own doc
   * comment for why `profile.inResponseTo` is compared against the
   * ticket's own `requestId` by hand here, rather than asking
   * `@node-saml/node-saml` to track it (`validateInResponseTo: never` in
   * `buildSamlClient()`).
   */
  async handleSamlAcs(body: { SAMLResponse?: string; RelayState?: string }): Promise<{ redirectTo: string }> {
    if (!body.SAMLResponse || !body.RelayState) {
      return {
        redirectTo: `${frontendOrigin()}/sso/complete#error=${encodeURIComponent("Malformed SAML response")}`,
      };
    }

    let ticket;
    try {
      ticket = verifySamlStateTicket(body.RelayState);
    } catch (err) {
      return {
        redirectTo: `${frontendOrigin()}/sso/complete#error=${encodeURIComponent((err as Error).message)}`,
      };
    }

    try {
      const { config: ssoConfig } = await this.db.withClaims(SERVICE_CLAIMS, (c) =>
        this.loadEnabledSsoConfig(c, ticket.companySlug)
      );
      // Same "config may have changed between login start and finish"
      // case `handleCallback()` guards against, mirrored here.
      if (ssoConfig.protocol !== "saml") {
        throw new Error("This company's single sign-on configuration has changed. Please try signing in again.");
      }
      const config = ssoConfig;
      const saml = this.buildSamlClient(config, ticket.requestId);

      // `validatePostResponseAsync` throws `SamlStatusError` itself for a
      // non-Success `<StatusCode>` (the IdP's own "access denied" /
      // "auth failed" equivalent) — caught by the same catch block below
      // as every other failure here, same as OIDC's `error`/
      // `error_description` query params becoming a `#error=` redirect.
      const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
      if (!profile?.nameID) {
        throw new Error("Your identity provider did not return a NameID");
      }
      // `profile.inResponseTo` reflects the raw `<Response InResponseTo>`
      // attribute — set unconditionally once the assertion's signature
      // has validated (see `@node-saml/node-saml`'s own
      // `processValidlySignedAssertionAsync`) — so this comparison is
      // exactly as trustworthy as OIDC's `expectedNonce` check, just done
      // by hand instead of by the library, per `validateInResponseTo`'s
      // own doc comment above.
      if (profile.inResponseTo !== ticket.requestId) {
        throw new Error("This sign-in response doesn't match the request that started it");
      }

      const token = await this.provisionAndIssueToken({
        companyId: ticket.companyId,
        companySlug: ticket.companySlug,
        externalSubject: profile.nameID,
        externalEmail: this.extractSamlEmail(profile, config),
        groups: this.extractSamlGroups(profile, config.groupsAttribute),
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

  private extractSamlGroups(profile: Profile, groupsAttribute: string | undefined): string[] {
    if (!groupsAttribute) return [];
    const value = profile[groupsAttribute];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string") return [value];
    return [];
  }

  /**
   * Most IdPs' default SAML app configuration puts the person's email
   * directly in the NameID (the library's own `DEFAULT_IDENTIFIER_FORMAT`
   * even requests exactly that format) — `config.emailAttribute` exists
   * only for the admin to point at a specific attribute URI when their
   * IdP's config doesn't, without AIHXM ever having to guess which of an
   * assertion's many possible attribute names to try.
   */
  private extractSamlEmail(profile: Profile, config: SamlSsoConfig): string | undefined {
    const fromConfiguredAttribute = config.emailAttribute ? profile[config.emailAttribute] : undefined;
    if (typeof fromConfiguredAttribute === "string" && fromConfiguredAttribute) return fromConfiguredAttribute;
    if (typeof profile.email === "string" && profile.email) return profile.email;
    if (typeof profile.mail === "string" && profile.mail) return profile.mail;
    if (profile.nameID?.includes("@")) return profile.nameID;
    return undefined;
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
    config: SsoIntegrationConfig;
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

  private resolveRoleKey(groups: string[], config: SsoIntegrationConfig): string {
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
