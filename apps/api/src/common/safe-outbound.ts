import dns, { lookup as dnsLookup } from "dns";
import { isIP } from "net";
import https from "https";
import http from "http";

/**
 * Outbound calls to an address a tenant admin typed in (webhooks) must never reach the server's own network: localhost,
 * private ranges, the cloud metadata address (169.254.169.254) and so on. This module gives two things:
 *
 * - `assertSafeOutboundUrl(url)` for save-time validation (https only, no credentials in the URL, a normal port, host is not a
 *   private IP and every address it resolves to is public).
 * - `safePost(...)`, which sends the request itself and checks the address it is ABOUT TO CONNECT TO (so a host name that
 *   changes its answer between the check and the call cannot slip through), and never follows redirects.
 *
 * Tests and local development can point at 127.0.0.1 with OUTBOUND_ALLOW_PRIVATE=true; the flag is ignored in production.
 */

export class UnsafeOutboundUrlError extends Error {}

const ALLOWED_PORTS = new Set([443, 8443]);

function privateAllowed(): boolean {
  return process.env.OUTBOUND_ALLOW_PRIVATE === "true" && process.env.NODE_ENV !== "production";
}

export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7)) || !/^\d+\.\d+\.\d+\.\d+$/.test(x.slice(7));
    return x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
  }
  return true; // not an IP at all: never treat as safe
}

function parseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeOutboundUrlError("The address is not a valid URL.");
  }
  if (u.username || u.password) throw new UnsafeOutboundUrlError("The address must not contain a user name or password.");
  if (privateAllowed()) {
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeOutboundUrlError("Only http(s) addresses are allowed.");
    return u;
  }
  if (u.protocol !== "https:") throw new UnsafeOutboundUrlError("The address must start with https://.");
  const port = u.port ? Number(u.port) : 443;
  if (!ALLOWED_PORTS.has(port)) throw new UnsafeOutboundUrlError("The address must use the standard https port (443 or 8443).");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeOutboundUrlError("The address points at a private network.");
  }
  if (isIP(host) && isPrivateAddress(host)) throw new UnsafeOutboundUrlError("The address points at a private network.");
  return u;
}

function resolveAll(host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address))));
  });
}

/** Throws UnsafeOutboundUrlError (with a message safe to show an admin) when the URL may not be called. */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  const u = parseUrl(raw);
  if (privateAllowed()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return u;
  let addrs: string[];
  try {
    addrs = await resolveAll(host);
  } catch {
    throw new UnsafeOutboundUrlError("The address could not be found (DNS lookup failed).");
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new UnsafeOutboundUrlError("The address points at a private network.");
  return u;
}

export type SafePostResult = { status: number; ok: boolean };

export async function safePost(
  raw: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<SafePostResult> {
  const u = parseUrl(raw);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise<SafePostResult>((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        timeout: timeoutMs,
        // Checked at connect time, against the address actually used.
        lookup: ((hostname: string, options: dns.LookupOptions, callback: (...a: unknown[]) => void) => {
          dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err);
            if (!privateAllowed() && addresses.some((a) => isPrivateAddress(a.address))) {
              return callback(new UnsafeOutboundUrlError("The address points at a private network."));
            }
            const first = addresses[0];
            if (options.all) return callback(null, addresses);
            callback(null, first.address, first.family);
          });
        }) as never,
      },
      (res) => {
        res.resume(); // we only need the status; never follow redirects
        res.on("end", () => resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300 }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
