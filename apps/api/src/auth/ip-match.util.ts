/**
 * Phase 2 gap-fill item #3 — IP allow/denylist. Minimal, dependency-free
 * IPv4 CIDR matching (same "no new dependency for something this small"
 * posture as migrate.ts's own doc comment) — deliberately IPv4-only.
 * Pakistan SMB tenants overwhelmingly connect over ordinary IPv4
 * office/ISP links; a client on a real IPv6 address simply never matches
 * an entry in either list (see `isIpAllowed`'s doc comment for what that
 * means in practice), which is a documented, deliberate scope limit, not
 * an oversight.
 */

/** Express's `req.ip` reports an IPv4-mapped IPv6 client (very common
 *  behind a proxy, and for local IPv4 loopback) as `::ffff:127.0.0.1`.
 *  Normalizing this is what makes plain IPv4 allow/deny entries actually
 *  match real request IPs instead of silently never matching. */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, "");
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/** One allow/deny-list entry: a bare IPv4 address (treated as /32) or a
 *  CIDR range like "10.0.0.0/24". Malformed entries never match anything
 *  (fail closed for a denylist entry, fail open — i.e. don't block — for
 *  an allowlist entry, since `isIpAllowed` only restricts when at least
 *  one entry actually matches). */
function ipMatchesEntry(ip: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;

  const [rangeIp, prefixStr] = trimmed.split("/");
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(rangeIp);
  if (ipInt === null || rangeInt === null) return false;

  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;

  const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** Parses a comma-separated allow/deny-list setting value into entries,
 *  dropping blanks — the same shape whether the field is empty, has one
 *  entry, or several. */
export function parseIpList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The denylist is checked first and always wins: an IP on both lists is
 * blocked, which matches how "explicitly blocked" reads to an admin
 * setting these up. An empty allowlist means "any IP not denied is fine"
 * — only a NON-empty allowlist actually restricts access to its entries.
 */
export function isIpAllowed(ip: string, allowlist: string[], denylist: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (denylist.some((entry) => ipMatchesEntry(normalized, entry))) return false;
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => ipMatchesEntry(normalized, entry));
}
