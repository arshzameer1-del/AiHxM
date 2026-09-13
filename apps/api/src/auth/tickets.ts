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
