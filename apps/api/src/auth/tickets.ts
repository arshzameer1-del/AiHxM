import * as jwt from "jsonwebtoken";

/**
 * Short-lived, single-purpose JWTs used to carry state between the two
 * steps of login (password check, then MFA) without a server-side
 * session table. `typ: "mfa_ticket"` keeps these from ever being mistaken
 * for a real session token even by accident — PlatformAdminGuard only
 * accepts a payload with `is_platform_admin === true`, which a ticket
 * never has, but this makes the distinction explicit rather than
 * incidental.
 */
export type MfaTicketPurpose = "mfa_enroll" | "mfa_verify";

export type MfaTicketPayload = {
  typ: "mfa_ticket";
  purpose: MfaTicketPurpose;
  userAccountId: string;
};

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

export function signMfaTicket(purpose: MfaTicketPurpose, userAccountId: string): string {
  const payload: MfaTicketPayload = { typ: "mfa_ticket", purpose, userAccountId };
  return jwt.sign(payload, secret(), { expiresIn: "5m" });
}

export function verifyMfaTicket(token: string, expectedPurpose: MfaTicketPurpose): MfaTicketPayload {
  let decoded: MfaTicketPayload;
  try {
    decoded = jwt.verify(token, secret()) as MfaTicketPayload;
  } catch {
    throw new Error("Ticket is invalid or expired");
  }
  if (decoded.typ !== "mfa_ticket" || decoded.purpose !== expectedPurpose) {
    throw new Error("Ticket is not valid for this operation");
  }
  return decoded;
}

/**
 * Phase 3 item #1 — carries an in-progress OIDC login's PKCE/nonce state
 * across the redirect to the IdP and back, without a server-side session
 * table. This ticket's own signed, compact JWT string doubles as the
 * OAuth `state` parameter sent to the IdP — the IdP is required to echo
 * `state` back unchanged on the callback, so verifying it here both
 * confirms the callback wasn't forged (a stranger can't produce a validly
 * signed ticket) AND recovers the exact PKCE code_verifier/nonce this
 * login attempt started with, in one step. Same "short-lived, single-
 * purpose, no DB row needed" shape as an MfaTicket, deliberately kept as
 * a separate type rather than overloading MfaTicketPurpose — a step-up or
 * MFA ticket accidentally accepted here (or vice versa) should fail
 * closed on `typ` alone, before ever reaching field-shape assumptions.
 */
export type SsoStateTicketPayload = {
  typ: "sso_state_ticket";
  companyId: string;
  companySlug: string;
  codeVerifier: string;
  nonce: string;
  /** Where the browser should land after a successful/failed login. */
  returnOrigin: string;
};

export function signSsoStateTicket(payload: Omit<SsoStateTicketPayload, "typ">): string {
  const full: SsoStateTicketPayload = { typ: "sso_state_ticket", ...payload };
  // 10 minutes — generous enough for a real IdP login prompt (a password
  // + their own MFA), short enough that a state value intercepted from
  // browser history is worthless shortly after.
  return jwt.sign(full, secret(), { expiresIn: "10m" });
}

export function verifySsoStateTicket(token: string): SsoStateTicketPayload {
  let decoded: SsoStateTicketPayload;
  try {
    decoded = jwt.verify(token, secret()) as SsoStateTicketPayload;
  } catch {
    throw new Error("Login session expired or invalid. Please try signing in again.");
  }
  if (decoded.typ !== "sso_state_ticket") {
    throw new Error("Ticket is not valid for this operation");
  }
  return decoded;
}
