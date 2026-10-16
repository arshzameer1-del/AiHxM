import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync } from "crypto";
import type { PoolClient } from "pg";

/**
 * Gap Register SEC-02/03/04 — application-level ENVELOPE encryption with
 * BLIND INDEXES (decision recorded by Kumail, 2026-10).
 *
 *   master key (env FIELD_ENCRYPTION_KEY)           -- never stored in the DB
 *     └─ wraps a random 32-byte key per tenant      -- table tenant_data_keys
 *          purpose 'dek'  : AES-256-GCM field encryption (rotatable by version)
 *          purpose 'bidx' : HMAC key for blind indexes   (stable; never rotated)
 *
 * Ciphertext format (single text value, safe to store in an existing text
 * column):   enc:v1:<keyVersion>:<iv b64url>:<tag b64url>:<ciphertext b64url>
 * `decrypt()` PASSES THROUGH any value without the `enc:v1:` prefix, so
 * legacy plaintext rows keep working while the resumable backfill converts
 * them (register A2 rule 1: additive, no big-bang).
 *
 * AAD is the company id: a ciphertext copied into another tenant's row fails
 * authentication. (It is deliberately NOT bound to table/column so a value
 * can be legitimately copied, e.g. employee -> payslip snapshot.)
 *
 * Why a blind index: AES-GCM with random IVs makes equal plaintexts differ,
 * so duplicate detection / lookup by CNIC cannot use the ciphertext. The blind
 * index is HMAC-SHA256(per-tenant bidx key, normalised value): deterministic
 * per tenant, useless without the key, different across tenants.
 *
 * Master-key rotation: set FIELD_ENCRYPTION_KEY to the new key and move the
 * old one to FIELD_ENCRYPTION_KEY_PREVIOUS; rewrapMasterKeys() re-wraps the
 * tenant keys, after which the previous key can be removed. Losing every copy
 * of the master key makes the data unrecoverable -- back it up separately
 * from the database.
 */

const PREFIX = "enc:v1:";
const DEV_FALLBACK_PASSPHRASE = "aihxm-dev-only-field-encryption-key-do-not-use-in-production";
const KEY_SALT = "aihxm-field-crypto-master-v1";
const CACHE_TTL_MS = 10 * 60 * 1000;

type KeyRing = { id: string; key: Buffer }[];
type TenantKeys = {
  loadedAt: number;
  dek: Map<number, Buffer>;
  activeDekVersion: number;
  bidx: Buffer | null;
};

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function deriveMaster(passphrase: string): Buffer {
  return scryptSync(passphrase, KEY_SALT, 32);
}

/** current key first. Throws (fail closed) in production when unset. */
function keyRing(): KeyRing {
  const ring: KeyRing = [];
  let current = process.env.FIELD_ENCRYPTION_KEY;
  if (!current) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FIELD_ENCRYPTION_KEY is not set: refusing to encrypt or decrypt sensitive fields");
    }
    current = DEV_FALLBACK_PASSPHRASE;
  }
  const cur = deriveMaster(current);
  ring.push({ id: keyId(cur), key: cur });
  const prev = process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
  if (prev) {
    const p = deriveMaster(prev);
    ring.push({ id: keyId(p), key: p });
  }
  return ring;
}

function wrap(raw: Buffer, master: { id: string; key: Buffer }): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", master.key, iv);
  const ct = Buffer.concat([c.update(raw), c.final()]);
  return `${master.id}.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("hex")}`;
}

function unwrap(wrapped: string, ring: KeyRing): Buffer {
  const [id, hex] = wrapped.split(".");
  const master = ring.find((k) => k.id === id);
  if (!master) throw new Error("FIELD_KEY_UNAVAILABLE: no master key matches this wrapped tenant key");
  const env = Buffer.from(hex, "hex");
  const d = createDecipheriv("aes-256-gcm", master.key, env.subarray(0, 12));
  d.setAuthTag(env.subarray(12, 28));
  try {
    return Buffer.concat([d.update(env.subarray(28)), d.final()]);
  } catch {
    throw new Error("FIELD_KEY_UNWRAP_FAILED");
  }
}

export class FieldCrypto {
  private cache = new Map<string, TenantKeys>();

  /** True when this tenant's keys are already loaded and fresh, so `warm()` would not query. */
  isWarm(companyId: string): boolean {
    const hit = this.cache.get(companyId);
    return Boolean(hit && Date.now() - hit.loadedAt < CACHE_TTL_MS);
  }

  /** For tests. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Loads (creating on first use) the tenant's keys into the in-process
   * cache so encrypt/decrypt/blindIndex can then be SYNCHRONOUS. Called
   * centrally from runInTenantContext, so service code never has to.
   * Cheap on a cache hit (no query).
   */
  async warm(client: PoolClient, companyId: string): Promise<void> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return;
    const ring = keyRing();

    let rows = (await client.query("SELECT purpose, key_version, wrapped_key, status FROM tenant_data_keys WHERE company_id = $1", [companyId])).rows;
    if (!rows.some((r) => r.purpose === "dek" && r.status === "active") || !rows.some((r) => r.purpose === "bidx")) {
      // Lazily create. ON CONFLICT DO NOTHING makes concurrent first-requests safe;
      // we re-read afterwards so every process converges on the winner's keys.
      await client.query(
        `INSERT INTO tenant_data_keys (company_id, purpose, key_version, wrapped_key, status)
         SELECT $1, 'dek', 1, $2, 'active'
          WHERE NOT EXISTS (SELECT 1 FROM tenant_data_keys WHERE company_id = $1 AND purpose = 'dek')
         ON CONFLICT DO NOTHING`,
        [companyId, wrap(randomBytes(32), ring[0])]
      );
      await client.query(
        `INSERT INTO tenant_data_keys (company_id, purpose, key_version, wrapped_key, status)
         VALUES ($1, 'bidx', 1, $2, 'active') ON CONFLICT DO NOTHING`,
        [companyId, wrap(randomBytes(32), ring[0])]
      );
      rows = (await client.query("SELECT purpose, key_version, wrapped_key, status FROM tenant_data_keys WHERE company_id = $1", [companyId])).rows;
    }

    const dek = new Map<number, Buffer>();
    let active = 0;
    let bidx: Buffer | null = null;
    for (const r of rows) {
      if (r.purpose === "dek") {
        dek.set(r.key_version, unwrap(r.wrapped_key, ring));
        if (r.status === "active" && r.key_version > active) active = r.key_version;
      } else if (r.purpose === "bidx") {
        bidx = unwrap(r.wrapped_key, ring);
      }
    }
    this.cache.set(companyId, { loadedAt: Date.now(), dek, activeDekVersion: active, bidx });
  }

  private keys(companyId: string): TenantKeys {
    const k = this.cache.get(companyId);
    if (!k) {
      throw new Error(`FIELD_KEYS_NOT_LOADED: tenant keys for ${companyId} are not loaded (call fieldCrypto.warm inside a tenant transaction first)`);
    }
    return k;
  }

  /** null/undefined/"" -> null. Already-encrypted values are returned unchanged (idempotent). */
  encrypt(companyId: string, plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined || plaintext === "") return null;
    if (isEncrypted(plaintext)) return plaintext;
    const k = this.keys(companyId);
    const version = k.activeDekVersion;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k.dek.get(version)!, iv);
    c.setAAD(Buffer.from(companyId));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return `${PREFIX}${version}:${b64(iv)}:${b64(c.getAuthTag())}:${b64(ct)}`;
  }

  /** Plaintext legacy values pass through unchanged. */
  decrypt(companyId: string, value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!isEncrypted(value)) return value;
    const k = this.keys(companyId);
    const [version, iv, tag, ct] = value.slice(PREFIX.length).split(":");
    const dek = k.dek.get(Number(version));
    if (!dek) throw new Error(`FIELD_KEY_UNAVAILABLE: data key version ${version} not found`);
    const d = createDecipheriv("aes-256-gcm", dek, fromB64(iv));
    d.setAAD(Buffer.from(companyId));
    d.setAuthTag(fromB64(tag));
    try {
      return Buffer.concat([d.update(fromB64(ct)), d.final()]).toString("utf8");
    } catch {
      throw new Error("FIELD_DECRYPTION_FAILED");
    }
  }

  /**
   * Deterministic per-tenant keyed hash for equality lookups / duplicate
   * detection. `kind` separates namespaces ('cnic', 'iban', ...) so equal
   * strings in different fields do not collide. Input is normalised by the
   * caller via `normalizeForIndex`.
   */
  blindIndex(companyId: string, kind: string, value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === "") return null;
    const k = this.keys(companyId);
    if (!k.bidx) throw new Error("FIELD_KEYS_NOT_LOADED: no blind-index key");
    const sub = Buffer.from(hkdfSync("sha256", k.bidx, Buffer.alloc(0), `bidx:${kind}`, 32));
    return createHmac("sha256", sub).update(normalizeForIndex(kind, value)).digest("hex");
  }

  /** Adds a new active DEK version (existing ciphertext stays decryptable; re-encrypt via the backfill job). */
  async rotateDek(client: PoolClient, companyId: string): Promise<number> {
    await this.warm(client, companyId);
    const ring = keyRing();
    const next = this.keys(companyId).activeDekVersion + 1;
    await client.query("UPDATE tenant_data_keys SET status = 'retired' WHERE company_id = $1 AND purpose = 'dek' AND status = 'active'", [companyId]);
    await client.query(
      "INSERT INTO tenant_data_keys (company_id, purpose, key_version, wrapped_key, status) VALUES ($1, 'dek', $2, $3, 'active')",
      [companyId, next, wrap(randomBytes(32), ring[0])]
    );
    this.cache.delete(companyId);
    await this.warm(client, companyId);
    return next;
  }

  /**
   * Re-wraps every tenant key under the CURRENT master key (after master
   * rotation). Keys wrapped under a master that is in neither slot are
   * reported as `skipped` rather than aborting -- do NOT drop the previous
   * master until `skipped` is 0.
   */
  async rewrapMasterKeys(client: PoolClient): Promise<{ rewrapped: number; alreadyCurrent: number; skipped: number }> {
    const ring = keyRing();
    const rows = (await client.query("SELECT company_id, purpose, key_version, wrapped_key FROM tenant_data_keys")).rows;
    let n = 0;
    let current = 0;
    let skipped = 0;
    for (const r of rows) {
      if (r.wrapped_key.startsWith(`${ring[0].id}.`)) {
        current++;
        continue;
      }
      if (!ring.some((k) => r.wrapped_key.startsWith(`${k.id}.`))) {
        skipped++;
        continue;
      }
      const raw = unwrap(r.wrapped_key, ring);
      await client.query("UPDATE tenant_data_keys SET wrapped_key = $4 WHERE company_id = $1 AND purpose = $2 AND key_version = $3", [
        r.company_id,
        r.purpose,
        r.key_version,
        wrap(raw, ring[0]),
      ]);
      n++;
    }
    this.cache.clear();
    return { rewrapped: n, alreadyCurrent: current, skipped };
  }
}

export function normalizeForIndex(kind: string, value: string): string {
  const v = value.trim();
  if (kind === "cnic" || kind === "account_number") return v.replace(/[\s-]/g, "");
  if (kind === "iban") return v.replace(/\s/g, "").toUpperCase();
  return v.toLowerCase();
}

/** Process-wide singleton: encryption must behave identically everywhere. */
export const fieldCrypto = new FieldCrypto();
