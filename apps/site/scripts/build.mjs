// Static build, no dependencies. `node scripts/build.mjs` writes ./dist.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { site } from "../src/site.config.mjs";
import { renderPage } from "../src/lib/layout.mjs";
import { esc } from "../src/lib/ui.mjs";
import { modules, solutions, industries, services, pakistan, articles } from "../src/content/catalog.mjs";
import home from "../src/pages/home.mjs";
import * as core from "../src/pages/pages-core.mjs";
import * as ps from "../src/pages/pages-site.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

// Every file gets a content hash in its name, so it can be cached for a year.
const registry = new Map();
function addAsset(absPath, name) {
  if (registry.has(absPath)) return registry.get(absPath);
  const buf = readFileSync(absPath);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const url = `/assets/${name}.${hash}${extname(absPath)}`;
  writeFileSync(join(dist, url), buf);
  registry.set(absPath, url);
  return url;
}

const dims = JSON.parse(readFileSync(join(src, "assets/screens/dims.json"), "utf8"));
const font = addAsset(join(src, "assets/fonts/dm-sans-var.woff2"), "dm-sans-var");
// Icon motion: each "@IA@ .selector{animation:ia-x ...}" rule runs once when its section scrolls in (.in) and again on hover or
// keyboard focus of the card it sits in. A hover rule needs a differently named (identical) keyframe so the browser restarts it.
const HOSTS = ":is(.card,.mm-link,.tile,.life-btn,.plain,.sec-item):is(:hover,:focus-visible)";
function expandMotion(text) {
  let out = text.replace(/^@IA@ (.+?)\{animation:(ia-[\w-]+)(.*)\}$/gm, (_, sel, name, rest) => `.in ${sel}{animation:${name}${rest}}\n${HOSTS} ${sel}{animation:${name}-h${rest}}`);
  out = out.replace(/^@keyframes (ia-[\w-]+)\{(.*)\}$/gm, (m, name, body) => `${m}\n@keyframes ${name}-h{${body}}`);
  return out;
}
const css = expandMotion(readFileSync(join(src, "styles.css"), "utf8")).replace("/assets/fonts/dm-sans-var.woff2", font);
const cssHash = createHash("sha256").update(css).digest("hex").slice(0, 10);
writeFileSync(join(dist, `assets/site.${cssHash}.css`), css);
const jsBuf = readFileSync(join(src, "app.js"));
const jsHash = createHash("sha256").update(jsBuf).digest("hex").slice(0, 10);
writeFileSync(join(dist, `assets/app.${jsHash}.js`), jsBuf);

const shared = {
  css: `/assets/site.${cssHash}.css`,
  js: `/assets/app.${jsHash}.js`,
  font,
  favicon: addAsset(join(src, "assets/brand/favicon-32.png"), "favicon"),
  touch: addAsset(join(src, "assets/brand/apple-touch-icon.png"), "apple-touch-icon"),
  logo: addAsset(join(src, "assets/brand/logo-512.png"), "aihxm-logo"),
  og: addAsset(join(src, "assets/og-default.png"), "og-default"),
};
const A = {
  ...shared,
  shot(name) {
    if (!dims[name]) throw new Error(`Unknown screenshot: ${name}`);
    const [w, h] = dims[name];
    return { img: addAsset(join(src, `assets/screens/${name}.webp`), name), w, h };
  },
};

// ---- the page registry ----
const pages = [
  home(A),
  core.platformPage(A),
  ...modules.map((m, i) => core.modulePage(m, i, A)),
  core.solutionsHub(),
  ...solutions.map((s) => core.solutionPageFor(s, A)),
  core.industriesHub(),
  ...industries.map((s) => core.industryPageFor(s, A)),
  core.servicesHub(),
  ...services.map((s) => core.servicePageFor(s)),
  ...pakistan.map((p) => core.pakistanPageFor(p, A)),
  ps.resourcesHub(),
  ps.blogIndex(),
  ...articles.map((a) => ps.articlePage(a)),
  ...ps.categoryKeys().map((k) => ps.categoryPageFor(k)),
  ps.knowledgeCenter(),
  ps.faqPage(),
  ps.pricingPage(),
  ps.integrationsPage(),
  ps.aboutPage(),
  ps.contactPage(),
  ps.demoPage(),
  ps.securityPage(),
  ps.privacyPage(),
  ps.termsPage(),
];

const seen = new Set();
for (const p of pages) {
  if (seen.has(p.path)) throw new Error(`Duplicate page path: ${p.path}`);
  seen.add(p.path);
}

function writePage(path, html) {
  const dir = path === "/" ? dist : join(dist, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}
for (const p of pages) writePage(p.path, renderPage(p, shared));
writeFileSync(join(dist, "404.html"), renderPage(ps.notFound(), shared));

// ---- search index (used by the site search dialog) ----
const kind = (path) =>
  path.startsWith("/platform/") ? "Product" : path.startsWith("/solutions/") ? "Solution" : path.startsWith("/industries/") ? "Industry" : path.startsWith("/services/") ? "Service" : path.startsWith("/pakistan-hrms/") ? "Pakistan" : path.startsWith("/resources/blog/") ? "Article" : path.startsWith("/resources/") ? "Resource" : "Page";
const searchable = pages.filter((p) => !p.noindex && !["/privacy/", "/terms/"].includes(p.path) && !p.path.includes("/category/"));
writeFileSync(join(dist, "search-index.json"), JSON.stringify(searchable.map((p) => ({ t: p.title.replace(/ \| AiHxM$/, ""), u: p.path, d: p.description, k: kind(p.path) }))));

// ---- SEO files ----
const indexable = pages.filter((p) => !p.noindex);
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexable.map((p) => `  <url><loc>${esc(site.url + p.path)}</loc><lastmod>${site.publishedOn}</lastmod></url>`).join("\n")}\n</urlset>\n`
);
writeFileSync(
  join(dist, "robots.txt"),
  site.indexable ? `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n` : `# Preview build: search engines are asked to stay away until MARKETING_INDEXABLE=true is set for the real launch.\nUser-agent: *\nDisallow: /\n`
);
writeFileSync(
  join(dist, "llms.txt"),
  `# ${site.name}\n\n> ${site.description}\n\nWhere a capability is partly built, needs the customer's own setup, or is not built yet, the site says so. Prices are given on request.\n\n## Pages\n\n${indexable.map((p) => `- [${p.title}](${site.url}${p.path}): ${p.description}`).join("\n")}\n`
);

// ---- Cloudflare Pages headers ----
const apiOrigin = new URL(site.apiUrl).origin;
// The one inline script (adds the "js" class so below-the-fold reveal can start) is allowed by its hash, not by 'unsafe-inline'.
const jsClassHash = createHash("sha256").update('document.documentElement.classList.add("js")').digest("base64");
writeFileSync(
  join(dist, "_headers"),
  `# Cloudflare Pages response headers for the brand website.
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000
  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-${jsClassHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${apiOrigin}; form-action 'self'; frame-ancestors 'none'; base-uri 'self'
`
);
// Only paths that are not pages on this site are redirected. Old app addresses on the apex move to the app host.
writeFileSync(
  join(dist, "_redirects"),
  `/login  ${site.appUrl}/login  301
/signup  ${site.appUrl}/signup  301
/reset-password  ${site.appUrl}/reset-password  301
/sso/*  ${site.appUrl}/sso/:splat  301
/app  ${site.appUrl}/app  301
/app/*  ${site.appUrl}/app/:splat  301
/companies/*  ${site.appUrl}/companies/:splat  301
/:slug/login  ${site.appUrl}/:slug/login  301
`
);

console.log(`Built ${pages.length} pages + 404 into ${dist}`);
console.log(`Indexable: ${site.indexable}  |  Site URL: ${site.url}  |  API: ${site.apiUrl}`);
if (!existsSync(join(dist, "index.html"))) process.exit(1);
