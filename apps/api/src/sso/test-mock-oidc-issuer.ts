import * as http from "http";
import type { AddressInfo } from "net";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "crypto";

/**
 * A genuine, minimal OpenID Provider used ONLY by `sso.e2e.spec.ts` — a
 * real HTTP server implementing just enough of OIDC discovery,
 * authorization, and token exchange (including real PKCE verification and
 * a real RS256-signed ID token checked against a real JWKS) for
 * `SsoService`'s actual `openid-client` calls to succeed end to end. This
 * is deliberately NOT a stub of `SsoService`'s own code — it's an
 * independent implementation of the other side of the protocol, so the
 * e2e test proves this codebase's OIDC client code interoperates with a
 * real (if minimal) IdP, not just with itself.
 *
 * Runs over plain HTTP — see `SsoService.buildClient()`'s doc comment on
 * why that's safe for this test only (never in production).
 */
export type MockIdentity = {
  subject: string;
  email?: string;
  groups?: string[];
};

type PendingCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  identity: MockIdentity;
};

export class MockOidcIssuer {
  private server: http.Server;
  baseUrl = "";
  clientId = "mock-client-id";
  clientSecret = "mock-client-secret";
  /** What the NEXT successful /authorize call binds the issued code to — set this before driving a login. */
  nextIdentity: MockIdentity = { subject: randomUUID(), email: "default@example.com" };
  groupsClaim = "groups";

  private readonly codes = new Map<string, PendingCode>();
  private readonly kid = "mock-oidc-issuer-key-1";
  private readonly privateKey: string;
  private readonly jwk: Record<string, unknown>;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    this.jwk = { ...publicJwk, kid: this.kid, use: "sig", alg: "RS256" };

    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", this.baseUrl || "http://localhost");
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      this.sendJson(res, 200, {
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        jwks_uri: `${this.baseUrl}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        scopes_supported: ["openid", "email", "profile"],
        claims_supported: ["sub", "email", this.groupsClaim],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      this.sendJson(res, 200, { keys: [this.jwk] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      this.handleAuthorize(url, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      this.handleToken(req, res);
      return;
    }
    res.writeHead(404).end("not found");
  }

  /**
   * Auto-approves every request (there's no real end user or consent
   * screen to drive here) and immediately 302s back to `redirect_uri`
   * with a fresh, single-use authorization code bound to this request's
   * `code_challenge`/`nonce`/`client_id` — exactly what `SsoService`'s
   * `authorizationCodeGrant` call later verifies against.
   */
  private handleAuthorize(url: URL, res: http.ServerResponse): void {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";

    if (clientId !== this.clientId) {
      res.writeHead(400).end("unknown client_id");
      return;
    }

    const code = randomBytes(24).toString("hex");
    this.codes.set(code, { clientId, redirectUri, codeChallenge, nonce, identity: this.nextIdentity });

    const location = new URL(redirectUri);
    location.searchParams.set("code", code);
    location.searchParams.set("state", state);
    res.writeHead(302, { Location: location.href }).end();
  }

  private async handleToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const params = new URLSearchParams(body);
    const code = params.get("code") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";
    const clientId = params.get("client_id") ?? "";
    const clientSecret = params.get("client_secret") ?? "";

    const pending = this.codes.get(code);
    if (!pending) {
      this.sendJson(res, 400, { error: "invalid_grant", error_description: "unknown or already-used code" });
      return;
    }
    // Single-use — a real IdP never lets the same code be redeemed twice.
    this.codes.delete(code);

    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      this.sendJson(res, 401, { error: "invalid_client" });
      return;
    }

    const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    if (expectedChallenge !== pending.codeChallenge) {
      this.sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    const idToken = this.signIdToken(pending);
    this.sendJson(res, 200, {
      access_token: randomBytes(16).toString("hex"),
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
    });
  }

  private signIdToken(pending: PendingCode): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: this.kid };
    const payload: Record<string, unknown> = {
      iss: this.baseUrl,
      sub: pending.identity.subject,
      aud: pending.clientId,
      exp: now + 300,
      iat: now,
      nonce: pending.nonce,
    };
    if (pending.identity.email) payload.email = pending.identity.email;
    if (pending.identity.groups) payload[this.groupsClaim] = pending.identity.groups;

    const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
    res.end(json);
  }
}
