/**
 * A company's own web address: acme.aihxm.com instead of aihxm.com/acme/login.
 *
 * The first label of the host names the company, exactly like the slug in /:companySlug/login, so both addresses open
 * the same company sign-in page. Labels the platform itself uses (app, api, www, qa ...) never name a company; the API
 * keeps the same names out of reach when a company is created (CompaniesService RESERVED_SLUGS).
 */

/** Hosts that belong to the platform, not to a company. Keep in step with RESERVED_SLUGS in companies.service.ts. */
export const PLATFORM_HOST_LABELS: ReadonlySet<string> = new Set([
  "app",
  "api",
  "www",
  "admin",
  "platform",
  "public",
  "assets",
  "static",
  "qa",
  "staging",
  "dev",
  "sandbox",
  "mail",
  "status",
  "docs",
  "help",
  "blog",
]);

const SLUG_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The domains whose first label is a company. `localhost` lets a developer try acme.localhost:5173. */
export function tenantBaseDomains(configured?: string): string[] {
  const list = (configured ?? "aihxm.com")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^\.+/, ""))
    .filter(Boolean);
  return Array.from(new Set([...list, "localhost"]));
}

/** The company slug a host name stands for, or null for the plain app / marketing / platform hosts. */
export function tenantSlugFromHost(hostname: string, baseDomains: string[] = tenantBaseDomains()): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  for (const base of baseDomains) {
    if (!host.endsWith(`.${base}`)) continue;
    const labels = host.slice(0, -(base.length + 1)).split(".");
    // Only acme.aihxm.com counts; a.b.aihxm.com is not a company address.
    if (labels.length !== 1) return null;
    const label = labels[0];
    if (!SLUG_LABEL.test(label) || PLATFORM_HOST_LABELS.has(label)) return null;
    return label;
  }
  return null;
}

/** The company named by this browser's address bar, or null. */
export function hostTenantSlug(): string | null {
  if (typeof window === "undefined") return null;
  const configured = (import.meta.env?.VITE_TENANT_BASE_DOMAIN as string | undefined) || undefined;
  return tenantSlugFromHost(window.location.hostname, tenantBaseDomains(configured));
}
