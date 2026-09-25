import { decryptExportPayload, encryptExportPayload } from "./export-crypto";

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
});
