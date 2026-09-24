/**
 * Canonical form for every email used as an account identifier
 * (`user_accounts.email`, `company_admins.email`, `platform_admins.email`).
 *
 * None of those columns is `citext` — plain `text` with a plain `UNIQUE`
 * constraint — so Postgres compares them byte-for-byte. Without a single
 * normalization point, an email typed once with different casing than it's
 * typed again (autocapitalize, copy-pasting from an email client, a
 * Platform Admin casually typing a tenant's email while onboarding them)
 * silently fails every later `WHERE email = $1` lookup, including login
 * itself — this is exactly what happened to the first real tenant admin
 * account created through the "Create login" flow: the email the Platform
 * Admin typed into "Add Admin" and the email the tenant admin typed into
 * `/login` matched except for case, and the mismatch surfaced only as a
 * generic "Invalid email or password".
 *
 * Every site that writes an email into one of those columns, or looks one
 * up, must pass it through this function first. See migration
 * 0044_normalize_emails.sql for the one-time backfill of rows written
 * before this existed.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
