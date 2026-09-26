import { randomBytes } from "crypto";
import {
  decryptExportPayload,
  encryptExportPayload,
  generateTenantKey,
  unwrapTenantKey,
  wrapTenantKey,
} from "./export-crypto";

/**
 * Pure-function tests for Phase 2 gap-fill item #6's encryption envelope
 * — no Postgres/HTTP needed, same idiom as ../auth/ip-match.util.spec.ts.
 * data-exports.e2e.spec.ts covers this wired end to end through the real
 * HTTP surface and real file storage; this covers the crypto itself in
 * isolation, including cases that would be awkward to provoke over HTTP
 * (a corrupted envelope, an empty payload, a changed server key).
 */
describe("export-crypto", () => {
  const originalKey = process.env.EXPORT_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.EXPORT_ENCRYPTION_KEY = "unit-test-export-encryption-key-32chars-min";
  });

  afterAll(() => {
    process.env.EXPORT_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips a real payload with no password (server-key mode)", () => {
    const plaintext = Buffer.from("id,name\n1,Sam Staff\n", "utf8");
    const envelope = encryptExportPayload(plaintext);
    expect(envelope[0]).toBe(0); // mode byte: 0 = server-key
    const decrypted = decryptExportPayload(envelope);
    expect(decrypted.toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("round-trips a real payload with a password (password mode)", () => {
    const plaintext = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const envelope = encryptExportPayload(plaintext, "correct-horse-battery");
    expect(envelope[0]).toBe(1); // mode byte: 1 = password-keyed
    const decrypted = decryptExportPayload(envelope, "correct-horse-battery");
    expect(decrypted.toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("produces a genuinely different ciphertext each time, even for the same plaintext and password (fresh iv/salt)", () => {
    const plaintext = Buffer.from("same content every time", "utf8");
    const first = encryptExportPayload(plaintext, "same-password-123");
    const second = encryptExportPayload(plaintext, "same-password-123");
    expect(first.equals(second)).toBe(false);
    // ...but both still decrypt to the same plaintext.
    expect(decryptExportPayload(first, "same-password-123").toString("utf8")).toBe("same content every time");
    expect(decryptExportPayload(second, "same-password-123").toString("utf8")).toBe("same content every time");
  });

  it("refuses to decrypt password-mode ciphertext with no password given", () => {
    const envelope = encryptExportPayload(Buffer.from("secret"), "the-password");
    expect(() => decryptExportPayload(envelope)).toThrow("PASSWORD_REQUIRED");
  });

  it("refuses to decrypt password-mode ciphertext with the wrong password", () => {
    const envelope = encryptExportPayload(Buffer.from("secret"), "the-real-password");
    expect(() => decryptExportPayload(envelope, "a-wrong-guess")).toThrow("INCORRECT_PASSWORD");
  });

  it("server-key mode is unaffected by ANY password being passed to decrypt (a caller can't accidentally weaken it)", () => {
    const envelope = encryptExportPayload(Buffer.from("server-keyed content"));
    // No real download flow would ever pass a password for a
    // non-password-protected export, but the function itself shouldn't
    // silently do something different if one is passed anyway — mode 0
    // always uses the server key regardless.
    const decrypted = decryptExportPayload(envelope, "irrelevant");
    expect(decrypted.toString("utf8")).toBe("server-keyed content");
  });

  it("fails closed if the server key changes between encrypt and decrypt", () => {
    const envelope = encryptExportPayload(Buffer.from("encrypted under the old key"));
    process.env.EXPORT_ENCRYPTION_KEY = "a-totally-different-key-32chars-min-here";
    expect(() => decryptExportPayload(envelope)).toThrow("DECRYPTION_FAILED");
  });

  it("throws clearly if EXPORT_ENCRYPTION_KEY isn't set at all", () => {
    delete process.env.EXPORT_ENCRYPTION_KEY;
    expect(() => encryptExportPayload(Buffer.from("x"))).toThrow("EXPORT_ENCRYPTION_KEY is not set");
  });

  it("round-trips an empty payload without error", () => {
    const envelope = encryptExportPayload(Buffer.alloc(0), "a-password-1234");
    const decrypted = decryptExportPayload(envelope, "a-password-1234");
    expect(decrypted.byteLength).toBe(0);
  });

  /**
   * Phase 3 item #5 — mode 2 (tenant-dedicated key). Unlike modes 0/1,
   * the key is supplied by the caller (DataExportsService, via
   * TenantExportKeyService) as raw bytes — this module never derives it
   * and never touches the database.
   */
  describe("mode 2 — tenant key", () => {
    it("round-trips a real payload with a given tenant key buffer", () => {
      const tenantKey = generateTenantKey();
      const plaintext = Buffer.from("id,name\n1,Sam Staff\n", "utf8");
      const envelope = encryptExportPayload(plaintext, undefined, tenantKey);
      expect(envelope[0]).toBe(2); // mode byte: 2 = tenant-key
      const decrypted = decryptExportPayload(envelope, undefined, tenantKey);
      expect(decrypted.toString("utf8")).toBe(plaintext.toString("utf8"));
    });

    it("fails closed with DECRYPTION_FAILED when decrypted with a different tenant key buffer", () => {
      const tenantKey = generateTenantKey();
      const wrongKey = generateTenantKey();
      const envelope = encryptExportPayload(Buffer.from("secret tenant data"), undefined, tenantKey);
      expect(() => decryptExportPayload(envelope, undefined, wrongKey)).toThrow("DECRYPTION_FAILED");
    });

    it("refuses to decrypt mode-2 ciphertext with no tenant key given at all", () => {
      const tenantKey = generateTenantKey();
      const envelope = encryptExportPayload(Buffer.from("secret"), undefined, tenantKey);
      expect(() => decryptExportPayload(envelope)).toThrow("TENANT_KEY_REQUIRED");
    });

    it("an explicit password still takes priority over a tenant key when both are supplied to encrypt", () => {
      const tenantKey = generateTenantKey();
      const envelope = encryptExportPayload(Buffer.from("payload"), "a-real-password", tenantKey);
      expect(envelope[0]).toBe(1); // password mode wins, per encryptExportPayload's own precedence
    });

    it("produces a genuinely different ciphertext each time for the same plaintext and tenant key (fresh iv)", () => {
      const tenantKey = generateTenantKey();
      const plaintext = Buffer.from("same content every time", "utf8");
      const first = encryptExportPayload(plaintext, undefined, tenantKey);
      const second = encryptExportPayload(plaintext, undefined, tenantKey);
      expect(first.equals(second)).toBe(false);
      expect(decryptExportPayload(first, undefined, tenantKey).toString("utf8")).toBe("same content every time");
      expect(decryptExportPayload(second, undefined, tenantKey).toString("utf8")).toBe("same content every time");
    });
  });

  /**
   * Phase 3 item #5 — the wrap/unwrap helpers TenantExportKeyService uses
   * to persist a tenant's key under the platform's own server key.
   */
  describe("wrapTenantKey / unwrapTenantKey", () => {
    it("round-trips a raw tenant key through wrap/unwrap", () => {
      const rawKey = generateTenantKey();
      const wrapped = wrapTenantKey(rawKey);
      expect(unwrapTenantKey(wrapped).equals(rawKey)).toBe(true);
    });

    it("the wrapped form never contains the raw key's own hex or base64 representation", () => {
      const rawKey = generateTenantKey();
      const wrapped = wrapTenantKey(rawKey);
      expect(wrapped).not.toContain(rawKey.toString("hex"));
      expect(wrapped).not.toBe(rawKey.toString("hex"));
    });

    it("produces a genuinely different wrapped value each time for the same raw key (fresh iv)", () => {
      const rawKey = generateTenantKey();
      expect(wrapTenantKey(rawKey)).not.toBe(wrapTenantKey(rawKey));
    });

    it("fails closed if the server key changes between wrap and unwrap", () => {
      const rawKey = generateTenantKey();
      const wrapped = wrapTenantKey(rawKey);
      process.env.EXPORT_ENCRYPTION_KEY = "a-totally-different-key-32chars-min-here";
      expect(() => unwrapTenantKey(wrapped)).toThrow("DECRYPTION_FAILED");
    });

    it("generateTenantKey always returns a fresh, 32-byte key", () => {
      const a = generateTenantKey();
      const b = generateTenantKey();
      expect(a.byteLength).toBe(32);
      expect(a.equals(b)).toBe(false);
      expect(a.equals(randomBytes(32))).toBe(false);
    });
  });
});
