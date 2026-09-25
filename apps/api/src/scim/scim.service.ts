import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import type { RequestClaims } from "../database/tenant-context";
import type { GenerateScimTokenResponse, ScimProvisioningStatus, SsoRoleResolutionConfig } from "@aihxm/shared-types";
import { normalizeEmail } from "../auth/email.util";
import { SsoService, apiBaseUrl, unusablePasswordPlaceholder } from "../sso/sso.service";
import { SCIM_SERVICE_CLAIMS, hashScimToken } from "./scim-auth.guard";

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

// Deliberately narrow: real-world SCIM traffic this codebase actually
// needs to handle — Okta's and Azure AD's own "does this user already
// exist" pre-create check — is always a single equality clause against
// one attribute. RFC 7644's full filter grammar (boolean combinators,
// substring/comparison operators, parentheses) is a real parser to write
// and a real one to get subtly wrong; supporting only this one, extremely
// common form and failing loud (400, not a silent no-op) on anything else
// is the same kind of deliberate, documented scope narrowing slice 2 made
// for SP-initiated request signing — a real, additive follow-up if a
// tenant's IdP ever sends something richer.
const FILTER_PATTERN = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

function parseSimpleEqFilter(filter: string): { attribute: string; value: string } {
  const match = FILTER_PATTERN.exec(filter);
  if (!match) {
    throw new BadRequestException(
      'Unsupported filter expression. Only \'<attribute> eq "<value>"\' is supported (attribute: userName, externalId, or emails.value).'
    );
  }
  return { attribute: match[1].toLowerCase(), value: match[2].replace(/\\"/g, '"') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toScimUser(row: any, baseUrl: string): Record<string, unknown> {
  const hasName = Boolean(row.given_name || row.family_name);
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    externalId: row.external_id ?? undefined,
    userName: row.email,
    name: hasName ? { givenName: row.given_name ?? undefined, familyName: row.family_name ?? undefined } : undefined,
    emails: [{ value: row.email, type: "work", primary: true }],
    active: row.status === "active",
    meta: { resourceType: "User", location: `${baseUrl}/Users/${row.id}` },
  };
}

type ExtractedUserFields = {
  email: string;
  externalId?: string;
  givenName?: string;
  familyName?: string;
  active?: boolean;
};

/**
 * Phase 3 item #1, slice 3 — SCIM 2.0 inbound provisioning. Where slices 1
 * (OIDC) and 2 (SAML) let a tenant's people AUTHENTICATE through their own
 * identity provider, this service lets that same IdP proactively manage
 * PORTAL ACCESS: create a login the moment someone is added, and — the
 * single most valuable real-world behavior — disable it the moment someone
 * is removed, without waiting for them to attempt a login again.
 *
 * Deliberate scope boundary, worth stating plainly: SCIM here manages
 * LOGIN/ACCESS, never HR employee records. Creating a SCIM user never
 * fabricates an `employees` row (headcount, compensation, personal data) —
 * that stays a deliberate HR action inside AIHXM itself, the same
 * "record the human action, don't automate a legally sensitive operation"
 * principle migration 0057_data_subject_requests.sql already established.
 * When the SCIM-supplied email matches an EXISTING tenant member (an
 * employee or admin HR already created, with a real role assignment),
 * Create links to that account instead of duplicating it — the identical
 * email-matching logic `SsoService.provisionAndIssueToken()` already uses
 * for JIT login, reused here rather than re-implemented.
 *
 * Also deliberately out of this slice: the SCIM Groups resource (push
 * group membership -> `roleMapping`) — every SCIM-created user gets
 * `tenant_integrations.config.defaultRoleKey` via
 * `SsoService.resolveRoleKey([], config)`, the exact same call OIDC/SAML
 * JIT provisioning makes with an empty groups array when no group claim
 * matches. A real, additive follow-up if a tenant ever needs it.
 */
@Injectable()
export class ScimService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessionSecurity: SessionSecurityService,
    private readonly ssoService: SsoService
  ) {}

  private scimBaseUrl(companySlug: string): string {
    return `${apiBaseUrl()}/scim/v2/${companySlug}`;
  }

  // ---------------------------------------------------------------------
  // Platform-Admin-facing token management (ScimAdminController)
  // ---------------------------------------------------------------------

  async getStatus(claims: RequestClaims, companyId: string): Promise<ScimProvisioningStatus> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT c.slug, ti.scim_enabled, ti.scim_bearer_token_hash
         FROM companies c
         LEFT JOIN tenant_integrations ti ON ti.company_id = c.id AND ti.provider_key = 'sso'
         WHERE c.id = $1`,
        [companyId]
      );
      if (result.rowCount === 0) throw new NotFoundException("Company not found");
      const row = result.rows[0];
      return {
        enabled: Boolean(row.scim_enabled),
        hasToken: Boolean(row.scim_bearer_token_hash),
        baseUrl: this.scimBaseUrl(row.slug),
      };
    });
  }

  /**
   * Generates (or rotates) this tenant's SCIM bearer token — same
   * "show plaintext exactly once, never retrievable again" pattern as
   * `IntegrationsService.rotateSecret()`. Unlike that method's 7-day
   * grace period, rotating here invalidates the previous token
   * IMMEDIATELY: this credential controls provisioning of tenant portal
   * access, and an overlapping-validity window is a real risk here that
   * it isn't for a device API key or a webhook signature. Works even if
   * the tenant's `sso` integration row has never been touched before —
   * SCIM can be the only sso-family feature a tenant ever turns on.
   */
  async generateToken(claims: RequestClaims, companyId: string): Promise<GenerateScimTokenResponse> {
    return this.db.withClaims(claims, async (client) => {
      const companyResult = await client.query<{ slug: string }>("SELECT slug FROM companies WHERE id = $1", [
        companyId,
      ]);
      if (companyResult.rowCount === 0) throw new NotFoundException("Company not found");
      const slug = companyResult.rows[0].slug;

      const token = `scim_${randomBytes(32).toString("hex")}`;
      const tokenHash = hashScimToken(token);

      await client.query(
        `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, scim_enabled, scim_bearer_token_hash, updated_by)
         VALUES ($1, 'sso', false, '{}'::jsonb, true, $2, $3)
         ON CONFLICT (company_id, provider_key)
         DO UPDATE SET scim_enabled = true, scim_bearer_token_hash = EXCLUDED.scim_bearer_token_hash,
                       updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, tokenHash, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "scim.token_generated",
        target: "sso",
        metadata: {},
      });

      return { token, baseUrl: this.scimBaseUrl(slug) };
    });
  }

  /**
   * Disabling clears the stored hash outright (never just flips
   * `scim_enabled` off while leaving the credential dormant) — a
   * deliberate safety-over-convenience choice: re-enabling requires
   * generating a fresh token, rather than a disabled integration quietly
   * keeping a live, still-valid bearer credential around.
   */
  async disableScim(claims: RequestClaims, companyId: string): Promise<{ enabled: boolean }> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE tenant_integrations SET scim_enabled = false, scim_bearer_token_hash = NULL, updated_by = $2, updated_at = now()
         WHERE company_id = $1 AND provider_key = 'sso'
         RETURNING company_id`,
        [companyId, claims.sub]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("SCIM has not been configured for this company");
      }
      await this.audit.record(client, claims, { companyId, action: "scim.disabled", target: "sso", metadata: {} });
      return { enabled: false };
    });
  }

  // ---------------------------------------------------------------------
  // RFC 7644 metadata endpoints — static, not tenant-specific
  // ---------------------------------------------------------------------

  serviceProviderConfig(): Record<string, unknown> {
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE_SIZE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Authenticate using the bearer token generated for this tenant in AIHXM's Integrations tab.",
          specUri: "https://tools.ietf.org/html/rfc6750",
          primary: true,
        },
      ],
    };
  }

  resourceTypes(): Record<string, unknown> {
    return {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults: 1,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          description: "AIHXM user account (portal login + role, not an HR employee record)",
          schema: SCIM_USER_SCHEMA,
        },
      ],
    };
  }

  schemas(): Record<string, unknown> {
    // Deliberately minimal — enough for an IdP's schema-discovery probe
    // during setup, not the full RFC 7643 §8.7.1 attribute catalog. The
    // attributes actually read/written are documented in this file's own
    // create/patch/replace methods.
    return {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults: 1,
      Resources: [
        {
          id: SCIM_USER_SCHEMA,
          name: "User",
          description: "AIHXM user account",
          attributes: [
            { name: "userName", type: "string", required: true, uniqueness: "server" },
            { name: "externalId", type: "string", required: false },
            {
              name: "name",
              type: "complex",
              required: false,
              subAttributes: [
                { name: "givenName", type: "string" },
                { name: "familyName", type: "string" },
              ],
            },
            {
              name: "emails",
              type: "complex",
              multiValued: true,
              required: false,
              subAttributes: [
                { name: "value", type: "string" },
                { name: "type", type: "string" },
                { name: "primary", type: "boolean" },
              ],
            },
            { name: "active", type: "boolean", required: false },
          ],
        },
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Users CRUD (the surface an IdP's SCIM connector actually drives)
  // ---------------------------------------------------------------------

  async listUsers(
    companySlug: string,
    companyId: string,
    filter: string | undefined,
    startIndexRaw: string | undefined,
    countRaw: string | undefined
  ): Promise<Record<string, unknown>> {
    const startIndex = Math.max(1, parseInt(startIndexRaw ?? "1", 10) || 1);
    const count = Math.min(
      MAX_PAGE_SIZE,
      Math.max(0, parseInt(countRaw ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
    );

    return this.db.withClaims(SCIM_SERVICE_CLAIMS, async (client) => {
      const params: unknown[] = [companyId];
      let whereExtra = "";
      if (filter) {
        const { attribute, value } = parseSimpleEqFilter(filter);
        if (attribute === "username" || attribute === "emails.value" || attribute === "emails") {
          params.push(normalizeEmail(value));
          whereExtra = ` AND ua.email = $${params.length}`;
        } else if (attribute === "externalid") {
          params.push(value);
          whereExtra = ` AND spu.external_id = $${params.length}`;
        } else {
          throw new BadRequestException(`Filtering by "${attribute}" is not supported.`);
        }
      }

      const countResult = await client.query<{ count: string }>(
        `SELECT count(*)::text FROM scim_provisioned_users spu
         JOIN user_accounts ua ON ua.id = spu.user_account_id
         WHERE spu.company_id = $1${whereExtra}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const limitParamIndex = params.length + 1;
      const offsetParamIndex = params.length + 2;
      const rows = await client.query(
        `SELECT ua.id, ua.email, ua.status, spu.external_id, spu.given_name, spu.family_name
         FROM scim_provisioned_users spu
         JOIN user_accounts ua ON ua.id = spu.user_account_id
         WHERE spu.company_id = $1${whereExtra}
         ORDER BY spu.created_at ASC
         LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
        [...params, count, startIndex - 1]
      );

      const baseUrl = this.scimBaseUrl(companySlug);
      return {
        schemas: [SCIM_LIST_RESPONSE_SCHEMA],
        totalResults: total,
        startIndex,
        itemsPerPage: rows.rows.length,
        Resources: rows.rows.map((r) => toScimUser(r, baseUrl)),
      };
    });
  }

  async getUser(companySlug: string, companyId: string, userAccountId: string): Promise<Record<string, unknown>> {
    return this.db.withClaims(SCIM_SERVICE_CLAIMS, (client) =>
      this.readUserRow(client, companyId, userAccountId, companySlug)
    );
  }

  async createUser(
    companySlug: string,
    companyId: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const { email, externalId, givenName, familyName, active } = this.extractUserFields(body);

    return this.db.withClaims(SCIM_SERVICE_CLAIMS, async (client) => {
      const existingAccount = await client.query<{ id: string }>("SELECT id FROM user_accounts WHERE email = $1", [
        email,
      ]);

      let userAccountId: string;
      let linkedExisting = false;

      if ((existingAccount.rowCount ?? 0) > 0) {
        userAccountId = existingAccount.rows[0].id;

        // Mirrors SsoService.provisionAndIssueToken()'s own account-linking
        // scope check: this email belongs to a real member of THIS tenant
        // (an employee or admin HR already created), or it belongs to some
        // other account entirely (a different tenant, a Platform Admin's
        // own login) and must be refused rather than silently hijacked.
        const isMember = await client.query(
          `SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2
           UNION
           SELECT 1 FROM company_admins WHERE user_account_id = $1 AND company_id = $2`,
          [userAccountId, companyId]
        );
        if ((isMember.rowCount ?? 0) === 0) {
          throw new ConflictException(
            `The email "${email}" is already associated with a different AIHXM account. Contact your administrator.`
          );
        }

        const alreadyProvisioned = await client.query(
          "SELECT 1 FROM scim_provisioned_users WHERE company_id = $1 AND user_account_id = $2",
          [companyId, userAccountId]
        );
        if ((alreadyProvisioned.rowCount ?? 0) > 0) {
          throw new ConflictException(`A SCIM user with userName "${email}" already exists.`);
        }
        linkedExisting = true;
      } else {
        const configResult = await client.query<{ config: SsoRoleResolutionConfig }>(
          "SELECT config FROM tenant_integrations WHERE company_id = $1 AND provider_key = 'sso'",
          [companyId]
        );
        const config: SsoRoleResolutionConfig = configResult.rows[0]?.config ?? {};
        const roleKey = this.ssoService.resolveRoleKey([], config);
        const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE key = $1", [roleKey]);
        if ((role.rowCount ?? 0) === 0) {
          throw new BadRequestException(`This company's SCIM role mapping refers to an unknown role "${roleKey}"`);
        }

        const created = await client.query<{ id: string }>(
          `INSERT INTO user_accounts (email, password_hash, auth_provider, mfa_enabled)
           VALUES ($1, $2, 'sso', true) RETURNING id`,
          [email, unusablePasswordPlaceholder()]
        );
        userAccountId = created.rows[0].id;
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      }

      await client.query(
        `INSERT INTO scim_provisioned_users (company_id, user_account_id, external_id, given_name, family_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, userAccountId, externalId ?? null, givenName ?? null, familyName ?? null]
      );

      if (active === false) {
        await this.setAccountActive(client, userAccountId, false, companyId);
      }

      await this.audit.record(client, SCIM_SERVICE_CLAIMS, {
        companyId,
        action: linkedExisting ? "scim.user_linked" : "scim.user_provisioned",
        target: userAccountId,
        metadata: { externalId: externalId ?? null },
      });

      return this.readUserRow(client, companyId, userAccountId, companySlug);
    });
  }

  async replaceUser(
    companySlug: string,
    companyId: string,
    userAccountId: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const { email, externalId, givenName, familyName, active } = this.extractUserFields(body);

    return this.db.withClaims(SCIM_SERVICE_CLAIMS, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM scim_provisioned_users WHERE company_id = $1 AND user_account_id = $2`,
        [companyId, userAccountId]
      );
      if (existing.rowCount === 0) throw new NotFoundException("User not found");

      await this.updateEmail(client, userAccountId, email);
      await client.query(
        `UPDATE scim_provisioned_users SET external_id = $3, given_name = $4, family_name = $5, updated_at = now()
         WHERE company_id = $1 AND user_account_id = $2`,
        [companyId, userAccountId, externalId ?? null, givenName ?? null, familyName ?? null]
      );
      // SCIM's own default for an omitted `active` on a full replace is
      // true — a PUT is a full-state replace, not a partial patch.
      await this.setAccountActive(client, userAccountId, active ?? true, companyId);

      await this.audit.record(client, SCIM_SERVICE_CLAIMS, {
        companyId,
        action: "scim.user_replaced",
        target: userAccountId,
        metadata: {},
      });

      return this.readUserRow(client, companyId, userAccountId, companySlug);
    });
  }

  async patchUser(
    companySlug: string,
    companyId: string,
    userAccountId: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const operations = Array.isArray(body.Operations) ? (body.Operations as Array<Record<string, unknown>>) : undefined;
    if (!operations || operations.length === 0) {
      throw new BadRequestException("A PATCH request must include a non-empty Operations array.");
    }

    return this.db.withClaims(SCIM_SERVICE_CLAIMS, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM scim_provisioned_users WHERE company_id = $1 AND user_account_id = $2`,
        [companyId, userAccountId]
      );
      if (existing.rowCount === 0) throw new NotFoundException("User not found");

      for (const operation of operations) {
        await this.applyPatchOperation(client, companyId, userAccountId, operation);
      }

      await this.audit.record(client, SCIM_SERVICE_CLAIMS, {
        companyId,
        action: "scim.user_patched",
        target: userAccountId,
        metadata: { operationCount: operations.length },
      });

      return this.readUserRow(client, companyId, userAccountId, companySlug);
    });
  }

  /** SCIM DELETE deprovisions — it never destroys the account, its role, or any HR data (see class doc comment). */
  async deleteUser(companyId: string, userAccountId: string): Promise<void> {
    await this.db.withClaims(SCIM_SERVICE_CLAIMS, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM scim_provisioned_users WHERE company_id = $1 AND user_account_id = $2`,
        [companyId, userAccountId]
      );
      if (existing.rowCount === 0) throw new NotFoundException("User not found");

      await this.setAccountActive(client, userAccountId, false, companyId);

      await this.audit.record(client, SCIM_SERVICE_CLAIMS, {
        companyId,
        action: "scim.user_deprovisioned",
        target: userAccountId,
        metadata: {},
      });
    });
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  private extractUserFields(body: Record<string, unknown>): ExtractedUserFields {
    const userName = typeof body.userName === "string" ? body.userName : undefined;
    const emailsArr = Array.isArray(body.emails) ? (body.emails as Array<Record<string, unknown>>) : [];
    const primaryEmailEntry = emailsArr.find((e) => e?.primary === true) ?? emailsArr[0];
    const primaryEmail = typeof primaryEmailEntry?.value === "string" ? primaryEmailEntry.value : undefined;
    const candidate = userName && userName.includes("@") ? userName : primaryEmail;

    if (!candidate || !candidate.includes("@")) {
      throw new BadRequestException("A userName or email attribute is required and must be a valid email address.");
    }
    const email = normalizeEmail(candidate);

    const externalId = typeof body.externalId === "string" ? body.externalId : undefined;
    const nameObj = (body.name ?? {}) as Record<string, unknown>;
    const givenName = typeof nameObj.givenName === "string" ? nameObj.givenName : undefined;
    const familyName = typeof nameObj.familyName === "string" ? nameObj.familyName : undefined;
    const active = typeof body.active === "boolean" ? body.active : undefined;

    return { email, externalId, givenName, familyName, active };
  }

  private async readUserRow(
    client: PoolClient,
    companyId: string,
    userAccountId: string,
    companySlug: string
  ): Promise<Record<string, unknown>> {
    const result = await client.query(
      `SELECT ua.id, ua.email, ua.status, spu.external_id, spu.given_name, spu.family_name
       FROM scim_provisioned_users spu
       JOIN user_accounts ua ON ua.id = spu.user_account_id
       WHERE spu.company_id = $1 AND spu.user_account_id = $2`,
      [companyId, userAccountId]
    );
    if (result.rowCount === 0) {
      throw new NotFoundException("User not found");
    }
    return toScimUser(result.rows[0], this.scimBaseUrl(companySlug));
  }

  /**
   * Deprovisioning's entire value proposition is IMMEDIATE access loss,
   * not just a blocked future login attempt — so deactivating here also
   * force-ends any session already open in someone's browser (the same
   * `user_sessions.revoked_at` mechanism/cache-invalidation
   * `SessionsService.revokeAllForUser()` uses for "Force Logout"; queried
   * directly rather than imported, the same "duplicated rather than
   * imported, since the query is cheap and importing would mean a whole
   * extra module dependency" reasoning `CompaniesService.getDeletionImpact
   * ()` already used for `UsageService`'s query). This is a genuine
   * improvement over the existing manual "Lock" admin action
   * (`CompaniesService`), which does not force-end sessions today — not
   * fixed here, to keep this slice scoped to SCIM's own surface, but worth
   * the identical small fix there as a real, separate follow-up.
   */
  private async setAccountActive(
    client: PoolClient,
    userAccountId: string,
    active: boolean,
    _companyId: string
  ): Promise<void> {
    await client.query("UPDATE user_accounts SET status = $2, updated_at = now() WHERE id = $1", [
      userAccountId,
      active ? "active" : "locked",
    ]);
    if (!active) {
      const revoked = await client.query<{ id: string }>(
        `UPDATE user_sessions SET revoked_at = now(), revoked_by = 'scim-service' WHERE user_account_id = $1 AND revoked_at IS NULL RETURNING id`,
        [userAccountId]
      );
      for (const row of revoked.rows) {
        await this.sessionSecurity.invalidateSessionCache(row.id);
      }
    }
  }

  private async updateEmail(client: PoolClient, userAccountId: string, newEmail: string): Promise<void> {
    const clash = await client.query("SELECT 1 FROM user_accounts WHERE email = $1 AND id <> $2", [
      newEmail,
      userAccountId,
    ]);
    if ((clash.rowCount ?? 0) > 0) {
      throw new ConflictException(`"${newEmail}" is already in use by a different account.`);
    }
    await client.query("UPDATE user_accounts SET email = $2, updated_at = now() WHERE id = $1", [
      userAccountId,
      newEmail,
    ]);
  }

  private async applyPatchOperation(
    client: PoolClient,
    companyId: string,
    userAccountId: string,
    operation: Record<string, unknown>
  ): Promise<void> {
    const op = typeof operation.op === "string" ? operation.op.toLowerCase() : "";
    if (op !== "replace" && op !== "add") {
      throw new BadRequestException(`Unsupported PATCH operation "${operation.op}". Only "replace"/"add" are supported.`);
    }
    const path = typeof operation.path === "string" ? operation.path.toLowerCase() : undefined;
    const value = operation.value;

    if (path) {
      await this.applyPatchValue(client, companyId, userAccountId, path, value);
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        await this.applyPatchValue(client, companyId, userAccountId, key.toLowerCase(), v);
      }
      return;
    }
    throw new BadRequestException('A PATCH operation must include either a "path" or an object "value".');
  }

  private async applyPatchValue(
    client: PoolClient,
    companyId: string,
    userAccountId: string,
    path: string,
    value: unknown
  ): Promise<void> {
    switch (path) {
      case "active": {
        if (typeof value !== "boolean") throw new BadRequestException('"active" must be a boolean.');
        await this.setAccountActive(client, userAccountId, value, companyId);
        return;
      }
      case "username": {
        if (typeof value !== "string" || !value.includes("@")) {
          throw new BadRequestException('"userName" must be a valid email address.');
        }
        await this.updateEmail(client, userAccountId, normalizeEmail(value));
        return;
      }
      case "externalid": {
        await client.query(
          "UPDATE scim_provisioned_users SET external_id = $3, updated_at = now() WHERE company_id = $1 AND user_account_id = $2",
          [companyId, userAccountId, typeof value === "string" ? value : null]
        );
        return;
      }
      case "name.givenname": {
        await client.query(
          "UPDATE scim_provisioned_users SET given_name = $3, updated_at = now() WHERE company_id = $1 AND user_account_id = $2",
          [companyId, userAccountId, typeof value === "string" ? value : null]
        );
        return;
      }
      case "name.familyname": {
        await client.query(
          "UPDATE scim_provisioned_users SET family_name = $3, updated_at = now() WHERE company_id = $1 AND user_account_id = $2",
          [companyId, userAccountId, typeof value === "string" ? value : null]
        );
        return;
      }
      case "name": {
        if (value && typeof value === "object") {
          const nameObj = value as Record<string, unknown>;
          if ("givenName" in nameObj) {
            await this.applyPatchValue(client, companyId, userAccountId, "name.givenname", nameObj.givenName);
          }
          if ("familyName" in nameObj) {
            await this.applyPatchValue(client, companyId, userAccountId, "name.familyname", nameObj.familyName);
          }
          return;
        }
        throw new BadRequestException('"name" must be an object.');
      }
      default:
        throw new BadRequestException(`Unsupported PATCH attribute "${path}".`);
    }
  }
}
