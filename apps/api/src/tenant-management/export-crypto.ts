import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const SERVER_KEY_SALT = "aihxm-export-server-key-v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PASSWORD_SALT_LENGTH = 16;
const TENANT_KEY_LENGTH = 32;

/**
 * Same fixed-salt idiom as ../auth/mfa-secret-crypto.ts's own deriveKey():
 * this derives one static key from one static server-held passphrase, not
 * a per-user password hash, so the passphrase's own entropy is what
 * matters. DO NOT change this string casually — every export already
 * encrypted under the resulting key becomes permanently undecryptable if
 * it does (harmless in practice: exports expire after 72h anyway and can
 * simply be re-requested, unlike MFA secrets).
 */
function deriveServerKey(): Buffer {
  const passphrase = process.env.EXPORT_ENCRYPTION_KEY;
  if (!passphrase) {
    throw new Error("EXPORT_ENCRYPTION_KEY is not set");
  }
  return scryptSync(passphrase, SERVER_KEY_SALT, 32);
}

/**
 * Phase 3 item #5 — "Encryption & Secrets (advanced)". Genuine
 * customer-held/HSM-backed keys (AWS KMS, Azure Key Vault, GCP KMS) are
 * explicitly OUT of scope — no external integration exists in this
 * codebase and there is no customer demand signal to justify building one
 * from scratch. What these two functions provide instead is the
 * honest, proportionate interim step: a genuine per-tenant *envelope
 * encryption* key, following the exact pattern real cloud KMS products
 * use under the hood — the tenant's key material is a fresh random
 * 32-byte value, but it never sits on disk in the clear: it is itself
 * wrapped (AES-256-GCM) under this same server-held EXPORT_ENCRYPTION_KEY
 * server-key scheme, reusing `deriveServerKey()` rather than inventing a
 * second wrapping scheme. `tenant_export_encryption_keys.wrapped_key`
 * stores only the output of `wrapTenantKey()` below — never the raw key.
 *
 * This buys a real, meaningful security property over one shared global
 * export key: a tenant that opts in gets its own key, independently
 * rotatable and revocable, so a compromise of one tenant's unwrapped key
 * (e.g. a bug that logs it, or a compromised process's memory) has a
 * blast radius of exactly that tenant, not every tenant's exports. It
 * does NOT protect against a compromise of EXPORT_ENCRYPTION_KEY itself —
 * that master key can always unwrap every tenant key — which is precisely
 * the gap a true externally-held/HSM-backed key (never present on this
 * server at all) would close. That remains a real, larger, deliberately
 * out-of-scope follow-on; see TenantExportKeyService's own doc comment.
 *
 * Wrapped format: [12-byte iv][16-byte authTag][32-byte ciphertext],
 * hex-encoded for a plain `text` column.
 */
export function wrapTenantKey(rawKey: Buffer): string {
  const key = deriveServerKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(rawKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("hex");
}

export function unwrapTenantKey(wrapped: string): Buffer {
  const key = deriveServerKey();
  const envelope = Buffer.from(wrapped, "hex");
  const iv = envelope.subarray(0, IV_LENGTH);
  const authTag = envelope.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = envelope.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("DECRYPTION_FAILED");
  }
}

/** A fresh, random tenant export key — always exactly 32 bytes for AES-256. */
export function generateTenantKey(): Buffer {
  return randomBytes(TENANT_KEY_LENGTH);
}

/**
 * Phase 2 gap-fill item #6 — at-rest encryption for tenant data exports,
 * closing the honesty gap DataExportsService's own former header comment
 * flagged ("no at-rest encryption layer to hang a real 'encrypted' claim
 * on yet"). AES-256-GCM in every mode; the only difference between the
 * three is where the key comes from:
 *
 *  - No password/tenant key supplied (the default): keyed from
 *    EXPORT_ENCRYPTION_KEY, a server-held passphrase — protects the file
 *    at rest (e.g. a stolen Supabase Storage object, or a compromised
 *    FileStorageService credential) with no burden on the requester,
 *    exactly like this file's sibling (mfa-secret-crypto.ts) already does
 *    for TOTP secrets.
 *  - A password IS supplied (the "password-protection" option the
 *    roadmap names explicitly): keyed from THAT password via scrypt with
 *    a fresh random salt per export. The plaintext is then recoverable
 *    ONLY by whoever knows the password — not even a Platform Admin who
 *    holds the server's own EXPORT_ENCRYPTION_KEY can decrypt it without
 *    also being told the password out of band. The password itself is
 *    never persisted anywhere, not even hashed, in either this module or
 *    the `tenant_data_exports` row — same guarantee as a real
 *    password-protected zip file.
 *  - A tenant key IS supplied (Phase 3 item #5 — see this file's
 *    `wrapTenantKey`/`unwrapTenantKey` doc comment above and
 *    TenantExportKeyService): keyed from that tenant's own, already-
 *    unwrapped dedicated key. `DataExportsService` resolves this key —
 *    never this module — and passes it in as raw bytes; this module
 *    never touches the wrapped form or the database at all. An explicit
 *    per-export `password` always takes priority over a tenant key when
 *    both could apply — see DataExportsService.request()'s own comment
 *    on that precedence.
 *
 * Format written to storage — a single self-describing envelope, so
 * decryptExportPayload() needs nothing from the database except whether a
 * password will be required at all (`tenant_data_exports.is_password_protected`,
 * kept only so the API/UI can ask for one before attempting a download):
 *   [1-byte mode][16-byte salt if mode=1][12-byte iv][16-byte authTag][ciphertext]
 *
 * Mode 2 (tenant key) carries no extra header bytes of its own — unlike
 * mode 1's per-export salt, there is nothing envelope-specific to record:
 * the caller already knows which tenant (hence which wrapped key row) an
 * export belongs to from `tenant_data_exports.company_id`, and supplies
 * the already-unwrapped key directly.
 */
export function encryptExportPayload(plaintext: Buffer, password?: string, tenantKey?: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  let key: Buffer;
  let modeByte: Buffer;
  let salt: Buffer | null = null;
  if (password) {
    salt = randomBytes(PASSWORD_SALT_LENGTH);
    key = scryptSync(password, salt, 32);
    modeByte = Buffer.from([1]);
  } else if (tenantKey) {
    key = tenantKey;
    modeByte = Buffer.from([2]);
  } else {
    key = deriveServerKey();
    modeByte = Buffer.from([0]);
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([modeByte, salt ?? Buffer.alloc(0), iv, authTag, ciphertext]);
}

export function decryptExportPayload(envelope: Buffer, password?: string, tenantKey?: Buffer): Buffer {
  const mode = envelope[0];
  let offset = 1;
  let key: Buffer;
  if (mode === 1) {
    if (!password) {
      throw new Error("PASSWORD_REQUIRED");
    }
    const salt = envelope.subarray(offset, offset + PASSWORD_SALT_LENGTH);
    offset += PASSWORD_SALT_LENGTH;
    key = scryptSync(password, salt, 32);
  } else if (mode === 2) {
    // There is no way to tell, from the envelope alone, WHICH of a
    // tenant's key generations (current vs. still-in-grace-period
    // previous) this was encrypted under — see
    // TenantExportKeyService.resolveKeyForDecryption()'s doc comment for
    // why the caller must try both.
    if (!tenantKey) {
      throw new Error("TENANT_KEY_REQUIRED");
    }
    key = tenantKey;
  } else {
    key = deriveServerKey();
  }
  const iv = envelope.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = envelope.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = envelope.subarray(offset);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM's auth tag check fails closed for both a genuinely corrupted
    // file AND a wrong password/key (they're indistinguishable from the
    // ciphertext alone) — for mode 1 the far more likely real-world cause
    // is a mistyped password, so that's what the caller sees. Mode 2's
    // caller (DataExportsService) tries the current tenant key first,
    // then the previous one within its grace period, so a
    // DECRYPTION_FAILED here just means "try the other key, if any."
    throw new Error(mode === 1 ? "INCORRECT_PASSWORD" : "DECRYPTION_FAILED");
  }
}
