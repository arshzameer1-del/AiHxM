import { createHash } from "crypto";

/**
 * Sign-in steps are limited per person-being-signed-in-to, not per network address alone: a whole Pakistan office (or a
 * mobile carrier) shares one public address, so a per-address limit of 10 a minute would stop colleagues from signing in at
 * shift start. Each (address, account) pair still gets a strict limit, so guessing one account's password or code is slow,
 * and a separate broad per-address cap (see AUTH_IP_LIMIT_PER_MINUTE) stops one address from sweeping many accounts.
 */
export const AUTH_ACCOUNT_LIMIT_PER_MINUTE = 10;
export const AUTH_IP_LIMIT_PER_MINUTE = 300;

function digest(v: string): string {
  return createHash("sha256").update(v.trim().toLowerCase()).digest("hex").slice(0, 24);
}

type ReqLike = { ip?: string; body?: Record<string, unknown> };

/** Tracker for the login-step routes: address + the account (or login ticket) the request is about. */
export function authAccountTracker(req: ReqLike): string {
  const b = req.body ?? {};
  const who =
    typeof b.email === "string" ? `e:${b.email}`
    : typeof b.employeeNumber === "string" ? `n:${String(b.companySlug ?? "")}/${b.employeeNumber}`
    : typeof b.mfaTicket === "string" ? `t:${b.mfaTicket}`
    : "anon";
  return `auth:${req.ip}:${digest(who)}`;
}

export function isAuthStepPath(path: string | undefined): boolean {
  return !!path && /^\/auth\/(login|mfa|password-reset|step-up)/.test(path);
}
