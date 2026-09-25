import { createHash, randomBytes, createPublicKey, verify as cryptoVerify } from "crypto";

/**
 * A minimal, hand-written stand-in for the handful of `openid-client`
 * functions `SsoService` actually calls, used ONLY by `sso.e2e.spec.ts`
 * (via `jest.mock("./openid-client-loader", ...)`).
 *
 * This exists purely because of a Jest-specific limitation, not a
 * production concern: `openid-client` is pure ESM (see
 * `openid-client-loader.ts`'s own doc comment), and the `new Function(...)
 * .return import(...)` trick that lets a REAL, compiled Node process load
 * it fine (verified independently outside Jest) still trips Jest's own
 * module sandbox, which refuses any genuine dynamic `import()` unless the
 * whole test run opts into `--experimental-vm-modules` — a flag that, in
 * this exact monorepo, conflicts with the already-established
 * babel-jest workaround for otplib's own ESM dependency chain (see
 * `jest.config.js`'s `transformIgnorePatterns`), so it can't just be
 * turned on globally.
 *
 * This stub still talks real HTTP to `MockOidcIssuer` (discovery fetch,
 * PKCE challenge/verifier math, a real form-encoded token POST, and real
 * RS256 signature verification against the issuer's real JWKS) — the
 * thing this file replaces is the `openid-client` PACKAGE, not the
 * protocol work `SsoService` relies on it to do. `sso.service.spec.ts`
 * separately covers the JIT-provisioning logic with no HTTP/IdP
 * involved at all, so between the two, every piece of this feature is
 * exercised for real somewhere.
 */

export type Configuration = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  clientId: string;
  clientSecret: string;
};

export function randomPKCECodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export async function calculatePKCECodeChallenge(codeVerifier: string): Promise<string> {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}

export async function discovery(
  issuerUrl: URL,
  clientId: string,
  metadata?: { client_secret?: string }
): Promise<Configuration> {
  const res = await fetch(new URL("/.well-known/openid-configuration", issuerUrl));
  if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
  const doc = (await res.json()) as Record<string, string>;
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    clientId,
    clientSecret: metadata?.client_secret ?? "",
  };
}

export function allowInsecureRequests(): void {
  // No-op — this stub never enforces HTTPS-only in the first place;
  // present only so it satisfies the same call shape SsoService uses
  // (`{ execute: [client.allowInsecureRequests] }`) when talking to the
  // real `openid-client` package.
}

export function buildAuthorizationUrl(
  config: Configuration,
  params: Record<string, string>
): URL {
  const url = new URL(config.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function base64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function verifyIdToken(idToken: string, config: Configuration, expectedNonce: string): Promise<Record<string, unknown>> {
  const [headerB64, payloadB64, signatureB64] = idToken.split(".");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

  const jwksRes = await fetch(config.jwks_uri);
  const jwks = (await jwksRes.json()) as { keys: Array<Record<string, unknown>> };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching JWK for id_token's kid");

  const publicKey = createPublicKey({ key: jwk as unknown as Record<string, string>, format: "jwk" });
  const signingInput = `${headerB64}.${payloadB64}`;
  const valid = cryptoVerify("RSA-SHA256", Buffer.from(signingInput), publicKey, base64UrlToBuffer(signatureB64));
  if (!valid) throw new Error("id_token signature verification failed");

  if (payload.iss !== config.issuer) throw new Error("id_token issuer mismatch");
  if (payload.aud !== config.clientId) throw new Error("id_token audience mismatch");
  if (payload.nonce !== expectedNonce) throw new Error("id_token nonce mismatch");
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("id_token expired");
  }

  return payload;
}

export async function authorizationCodeGrant(
  config: Configuration,
  currentUrl: URL,
  checks: { pkceCodeVerifier: string; expectedNonce: string; expectedState: string }
): Promise<{ claims: () => Record<string, unknown> }> {
  const code = currentUrl.searchParams.get("code");
  const state = currentUrl.searchParams.get("state");
  if (state !== checks.expectedState) throw new Error("state mismatch");
  if (!code) throw new Error("Missing code");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: currentUrl.origin + currentUrl.pathname,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: checks.pkceCodeVerifier,
  });

  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const tokenResponse = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tokenResponse.id_token) {
    throw new Error(tokenResponse.error_description ?? tokenResponse.error ?? "Token exchange failed");
  }

  const claims = await verifyIdToken(tokenResponse.id_token, config, checks.expectedNonce);
  return { claims: () => claims };
}
