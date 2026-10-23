/**
 * CORS_ORIGIN is a comma-separated list of exact web origins. One entry may carry a wildcard host label so every
 * company address under the platform domain is allowed without listing each one: `https://*.aihxm.com`.
 *
 * The `*` stands for exactly one DNS label (acme.aihxm.com yes; aihxm.com, a.b.aihxm.com and acme.aihxm.com.evil.io no)
 * and the scheme and port must match, so a wildcard never opens a wider door than the exact entries do.
 */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseCorsOrigins(raw: string | undefined, fallback = "http://localhost:5173"): string[] {
  return (raw ?? fallback)
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function isOriginAllowed(origin: string, allowed: string[]): boolean {
  const candidate = origin.trim().replace(/\/+$/, "");
  for (const entry of allowed) {
    if (entry === candidate) return true;
    if (!entry.includes("*.")) continue;
    // Only a leading `*.` host label is a wildcard; anything else stays literal.
    const m = /^(https?:\/\/)\*\.(.+)$/.exec(entry);
    if (!m) continue;
    const re = new RegExp(`^${escapeRegExp(m[1])}${LABEL}\\.${escapeRegExp(m[2])}$`, "i");
    if (re.test(candidate)) return true;
  }
  return false;
}
