export type EnvReport = { errors: string[]; warnings: string[] };

/**
 * Checks the settings the API cannot work without, at start-up, so a mis-configured deploy refuses to boot (and the
 * platform keeps the previous version) instead of starting "healthy" and failing every request later.
 * `errors` stop a production start; `warnings` are logged (a feature will be off, e.g. no e-mail).
 */
export function checkRuntimeEnv(env: NodeJS.ProcessEnv): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === "production";
  const has = (k: string) => typeof env[k] === "string" && env[k]!.trim().length > 0;

  if (!has("APP_DATABASE_URL")) errors.push("APP_DATABASE_URL is not set (the database connection for the running API).");
  if (!has("JWT_SECRET")) errors.push("JWT_SECRET is not set (signs every login session).");
  else if (production && env.JWT_SECRET!.length < 32) errors.push("JWT_SECRET is shorter than 32 characters.");

  if (production) {
    for (const k of ["MFA_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEY"]) if (!has(k)) errors.push(`${k} is not set (encrypts MFA secrets / personal data).`);
    if (!has("CORS_ORIGIN")) errors.push("CORS_ORIGIN is not set (the web app's address); browsers would be refused.");
    if (!has("APP_BASE_URL")) warnings.push("APP_BASE_URL is not set: links in e-mails and invitations will be wrong.");
    if (!has("SMTP_HOST")) warnings.push("SMTP_HOST is not set: password-reset and notification e-mail is off.");
    if (!has("EXPORT_ENCRYPTION_KEY")) warnings.push("EXPORT_ENCRYPTION_KEY is not set: tenant data exports cannot be encrypted.");
    if (!has("REDIS_URL")) warnings.push("REDIS_URL is not set: cache and rate limits are per process (fine for one instance only).");
    if (!has("SUPABASE_URL") && !has("FILE_STORAGE_LOCAL_DIR")) warnings.push("No file storage configured (SUPABASE_URL / FILE_STORAGE_LOCAL_DIR): uploads use the local disk.");
  }
  return { errors, warnings };
}
