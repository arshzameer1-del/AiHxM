import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const SERVER_KEY_SALT = "aihxm-export-server-key-v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PASSWORD_SALT_LENGTH = 16;

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
 * Phase 2 gap-fill item #6 — at-rest encryption for tenant data exports,
 * closing the honesty gap DataExportsService's own former header comment
 * flagged ("no at-rest encryption layer to hang a real 'encrypted' claim
 * on yet"). AES-256-GCM either way; the only difference between the two
 * modes is where the key comes from:
 *
 *  - No password supplied (the default): keyed from EXPORT_ENCRYPTION_KEY,
 *    a server-held passphrase — protects the file at rest (e.g. a stolen
 *    Supabase Storage object, or a compromised FileStorageService
 *    credential) with no burden on the requester, exactly like this
 *    file's sibling (mfa-secret-crypto.ts) already does for TOTP secrets.
 *  - A password IS supplied (the "password-protection" option the
 *    roadmap names explicitly): keyed from THAT password via scrypt with
 *    a fresh random salt per export. The plaintext is then recoverable
 *    ONLY by whoever knows the password — not even a Platform Admin who
 *    holds the server's own EXPORT_ENCRYPTION_KEY can decrypt it without
 *    also being told the password out of band. The password itself is
 *    never persisted anywhere, not even hashed, in either this module or
 *    the `tenant_data_exports` row — same guarantee as a real
 *    password-protected zip file.
 *
 * Format written to storage — a single self-describing envelope, so
 * decryptExportPayload() needs nothing from the database except whether a
 * password will be required at all (`tenant_data_exports.is_password_protected`,
 * kept only so the API/UI can ask for one before attempting a download):
 *   [1-byte mode][16-byte salt if mode=1][12-byte iv][16-byte authTag][ciphertext]
 */
export function encryptExportPayload(plaintext: Buffer, password?: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  let key: Buffer;
  let modeByte: Buffer;
  let salt: Buffer | null = null;
  if (password) {
    salt = randomBytes(PASSWORD_SALT_LENGTH);
    key = scryptSync(password, salt, 32);
    modeByte = Buffer.from([1]);
  } else {
    key = deriveServerKey();
    modeByte = Buffer.from([0]);
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([modeByte, salt ?? Buffer.alloc(0), iv, authTag, ciphertext]);
}

export function decryptExportPayload(envelope: Buffer, password?: string): Buffer {
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
    // file AND a wrong password (they're indistinguishable from the
    // ciphertext alone) — for mode 1 the far more likely real-world cause
    // is a mistyped password, so that's what the caller sees.
    throw new Error(mode === 1 ? "INCORRECT_PASSWORD" : "DECRYPTION_FAILED");
  }
}
