// The registry: every page the site can link to, resolved from the content files. Pages and menus read from here so a new
// module, article or service appears in navigation, cards, related links, sitemap and search without editing templates.
import a from "./modules-a.mjs";
import b from "./modules-b.mjs";
import c from "./modules-c.mjs";
import { solutions, industries } from "./audiences.mjs";
import { services } from "./services.mjs";
import { pakistan } from "./pakistan.mjs";
import { articles, categories } from "./articles.mjs";
import { flags, statusOf } from "./flags.mjs";

export const modules = [...a, ...b, ...c];
export const moduleGroups = ["People", "Time", "Pay", "Talent", "Experience", "Platform", "Insight"];
export const groupBlurb = {
  People: "Records, structure and the employee journey",
  Time: "Leave, attendance and working time",
  Pay: "Payroll, compensation and money in and out",
  Talent: "Hiring, performance, skills and learning",
  Experience: "Self-service, engagement and support",
  Platform: "Workflows, documents and configuration",
  Insight: "Reports and analytics",
};

export const modulePath = (m) => `/platform/${m.slug}/`;
export const solutionPath = (s) => `/solutions/${s.slug}/`;
export const industryPath = (s) => `/industries/${s.slug}/`;
export const servicePath = (s) => `/services/${s.slug}/`;
export const articlePath = (s) => `/resources/blog/${s.slug}/`;
export const categoryPath = (k) => `/resources/category/${k}/`;

/** "Name|setup" -> { name, status } with the central release overrides applied. */
export function parseItem(s) {
  const [name, declared] = s.split("|");
  return { name, status: statusOf(name, declared || "available") };
}

const registry = new Map();
for (const m of modules) registry.set(m.slug, { href: modulePath(m), name: m.name, icon: m.icon, short: m.short });
for (const s of services) registry.set(s.slug, { href: servicePath(s), name: s.name, icon: s.icon, short: s.short });
for (const p of pakistan) registry.set(p.slug, { href: p.path, name: p.name, icon: p.icon, short: p.lede.slice(0, 110) });
for (const s of solutions) registry.set(s.slug, { href: solutionPath(s), name: s.name, icon: s.icon, short: s.short });
for (const s of industries) registry.set(`ind-${s.slug}`, { href: industryPath(s), name: s.name, icon: s.icon, short: s.short });
export function resolve(slug) {
  const r = registry.get(slug);
  if (!r) throw new Error(`Unknown link target: ${slug}`);
  return r;
}

export const moduleBySlug = (slug) => modules.find((m) => m.slug === slug);
export const categoryName = (k) => (categories.find((c) => c[0] === k) || [k, k])[1];

/** All items on a module page, parsed. */
export const moduleItems = (m) => m.caps.flatMap((g) => g.items.map(parseItem));

export { solutions, industries, services, pakistan, articles, categories, flags };
