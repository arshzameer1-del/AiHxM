import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

/**
 * At-rest encryption for TOTP secrets (AES-256-GCM). A stolen database
 * dump alone shouldn't be enough to mint valid MFA codes for every
 * account — a bare `mfa_secret` column would be exactly that.
 *
 * MFA_ENCRYPTION_KEY is a passphrase, not a raw key — scrypt derives a
 * 32-byte key from it deterministically so any string works. Losing this
 * value means every enrolled MFA secret becomes undecryptable at once
 * (equivalent to every account needing to re-enroll); rotate it
 * deliberately, not by accident.
 */
function deriveKey(): Buffer {
  const passphrase = process.env.MFA_ENCRYPTION_KEY;
  if (!passphrase) {
    throw new Error("MFA_ENCRYPTION_KEY is not set");
  }
  // Fixed salt is acceptable here: this derives one static key from one
  // static secret, not a per-user password hash — the passphrase's own
  // entropy is what matters.
  return scryptSync(passphrase, "boostfactor-mfa-secret-v1", 32);
}

export function encryptMfaSecret(plainSecret: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainSecret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

export function decryptMfaSecret(encrypted: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encrypted.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted MFA secret");
  }
  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
