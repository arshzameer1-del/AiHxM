import { isIpAllowed, normalizeIp, parseIpList } from "./ip-match.util";

/**
 * Phase 2 gap-fill item #3 — IP allow/denylist. Pure-function coverage for
 * ip-match.util.ts's three exports: no DB, no app context, since none of
 * this depends on either.
 */
describe("normalizeIp", () => {
  it("strips the IPv4-mapped IPv6 prefix Express reports behind a proxy or on loopback", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("leaves a plain IPv4 address unchanged", () => {
    expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
  });

  it("leaves a real IPv6 address unchanged (deliberately out of scope, not matched)", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("parseIpList", () => {
  it("splits a comma-separated list and trims whitespace", () => {
    expect(parseIpList("10.0.0.1, 10.0.0.2 ,10.0.0.3")).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  it("drops blank entries from empty, trailing, or doubled commas", () => {
    expect(parseIpList("")).toEqual([]);
    expect(parseIpList("10.0.0.1,")).toEqual(["10.0.0.1"]);
    expect(parseIpList("10.0.0.1,,10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(parseIpList("   ")).toEqual([]);
  });
});

describe("isIpAllowed", () => {
  it("allows any IP when both lists are empty (default, backward-compatible behavior)", () => {
    expect(isIpAllowed("203.0.113.9", [], [])).toBe(true);
  });

  it("allows an IP not on the denylist when the allowlist is empty", () => {
    expect(isIpAllowed("203.0.113.9", [], ["10.0.0.0/24"])).toBe(true);
  });

  it("blocks an IP that matches a bare-address denylist entry", () => {
    expect(isIpAllowed("203.0.113.9", [], ["203.0.113.9"])).toBe(false);
  });

  it("blocks an IP inside a CIDR denylist range", () => {
    expect(isIpAllowed("10.0.0.42", [], ["10.0.0.0/24"])).toBe(false);
  });

  it("does not block an IP just outside a CIDR denylist range", () => {
    expect(isIpAllowed("10.0.1.42", [], ["10.0.0.0/24"])).toBe(true);
  });

  it("restricts to only the allowlist when the allowlist is non-empty", () => {
    expect(isIpAllowed("192.168.1.5", ["192.168.1.0/24"], [])).toBe(true);
    expect(isIpAllowed("192.168.2.5", ["192.168.1.0/24"], [])).toBe(false);
  });

  it("has the denylist win over the allowlist for an IP on both", () => {
    expect(isIpAllowed("192.168.1.5", ["192.168.1.0/24"], ["192.168.1.5"])).toBe(false);
  });

  it("matches a bare address in an allowlist entry as a /32", () => {
    expect(isIpAllowed("192.168.1.5", ["192.168.1.5"], [])).toBe(true);
    expect(isIpAllowed("192.168.1.6", ["192.168.1.5"], [])).toBe(false);
  });

  it("treats a /0 entry as matching every address", () => {
    expect(isIpAllowed("8.8.8.8", [], ["0.0.0.0/0"])).toBe(false);
  });

  it("normalizes an IPv4-mapped IPv6 client IP before matching", () => {
    expect(isIpAllowed("::ffff:10.0.0.42", [], ["10.0.0.0/24"])).toBe(false);
    expect(isIpAllowed("::ffff:192.168.1.5", ["192.168.1.0/24"], [])).toBe(true);
  });

  it("fails closed for a malformed denylist entry (never matches, so it never blocks) and fails open for a malformed allowlist entry (never restricts)", () => {
    expect(isIpAllowed("203.0.113.9", [], ["not-an-ip"])).toBe(true);
    expect(isIpAllowed("203.0.113.9", ["not-an-ip"], [])).toBe(false);
  });

  it("never matches a real IPv6 client address against IPv4 list entries (documented scope limit)", () => {
    expect(isIpAllowed("2001:db8::1", [], ["2001:db8::1"])).toBe(true);
    expect(isIpAllowed("2001:db8::1", ["2001:db8::1"], [])).toBe(false);
  });
});
