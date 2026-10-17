import * as jwt from "jsonwebtoken";

/**
 * The signed-in person behind a request, or null for anything else (no token, a bad or expired token, a login-step
 * ticket). Only a genuine session token counts: it is checked against JWT_SECRET here, never trusted as sent.
 *
 * Used to throttle a signed-in person by themselves instead of by network address: a whole office shares one address,
 * and the app now reads several screens' data in the background, so an address-wide limit of 100 requests a minute
 * would lock a handful of colleagues out together. Anyone who is not signed in stays on the strict per-address limit.
 */
export function sessionSubject(req: { headers?: Record<string, unknown> } | undefined): string | null {
  const header = req?.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(header.slice("Bearer ".length), secret) as Record<string, unknown>;
    if (payload.typ !== undefined) return null; // a login-step ticket, not a session
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string") return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Requests per minute for a signed-in person (the per-address limit for everyone else is 100). */
export const SIGNED_IN_LIMIT_PER_MINUTE = 1200;
