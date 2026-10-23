import { isOriginAllowed, parseCorsOrigins } from "./cors-origin";

describe("CORS origin allow-list", () => {
  const allowed = parseCorsOrigins("https://aihxm.com, https://app.aihxm.com/ ,https://*.aihxm.com");

  it("keeps exact entries working and ignores a trailing slash", () => {
    expect(allowed).toEqual(["https://aihxm.com", "https://app.aihxm.com", "https://*.aihxm.com"]);
    expect(isOriginAllowed("https://aihxm.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://app.aihxm.com/", allowed)).toBe(true);
  });

  it("lets any one-label company address through the wildcard", () => {
    expect(isOriginAllowed("https://leadhcm.aihxm.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://Acme-Textiles.aihxm.com", allowed)).toBe(true);
  });

  it("does not widen the door", () => {
    for (const o of [
      "https://a.b.aihxm.com",
      "https://acme.aihxm.com.evil.io",
      "https://evilaihxm.com",
      "http://acme.aihxm.com",
      "https://acme.aihxm.com:8443",
      "https://.aihxm.com",
      "https://acme.example.com",
    ]) {
      expect(isOriginAllowed(o, allowed)).toBe(false);
    }
  });

  it("does not treat the wildcard as a regular expression", () => {
    expect(isOriginAllowed("https://acmeXaihxm.com", ["https://*.aihxm.com"])).toBe(false);
  });

  it("defaults to the local dev server only", () => {
    expect(parseCorsOrigins(undefined)).toEqual(["http://localhost:5173"]);
    expect(isOriginAllowed("https://aihxm.com", parseCorsOrigins(undefined))).toBe(false);
  });
});
