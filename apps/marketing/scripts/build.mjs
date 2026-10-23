// Static site build: no dependencies. `node scripts/build.mjs` writes ./dist.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { site } from "../src/site.config.mjs";
import { renderPage, esc } from "../src/layout.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");
const webPublic = resolve(root, "..", "web", "public");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

// ---- asset registry: every file gets a content hash in its name, so it can be cached for a year ----
const registry = new Map();
function addAsset(absPath, name) {
  if (registry.has(absPath)) return registry.get(absPath);
  const buf = readFileSync(absPath);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const ext = extname(absPath);
  const url = `/assets/${name}.${hash}${ext}`;
  writeFileSync(join(dist, url), buf);
  registry.set(absPath, url);
  return url;
}
const baseName = (p) => p.split("/").pop().replace(/\.[^.]+$/, "");

const dims = JSON.parse(readFileSync(join(src, "assets/screens/dims.json"), "utf8"));
const fontBody = addAsset(join(src, "assets/fonts/inter-var.woff2"), "inter-var");
const fontDisplay = addAsset(join(src, "assets/fonts/bricolage-var.woff2"), "bricolage-var");

let css = readFileSync(join(src, "styles.css"), "utf8")
  .replace("/assets/fonts/inter-var.woff2", fontBody)
  .replace("/assets/fonts/bricolage-var.woff2", fontDisplay);
const cssHash = createHash("sha256").update(css).digest("hex").slice(0, 10);
writeFileSync(join(dist, `assets/site.${cssHash}.css`), css);
const jsBuf = readFileSync(join(src, "app.js"));
const jsHash = createHash("sha256").update(jsBuf).digest("hex").slice(0, 10);
writeFileSync(join(dist, `assets/app.${jsHash}.js`), jsBuf);

const shared = {
  css: `/assets/site.${cssHash}.css`,
  js: `/assets/app.${jsHash}.js`,
  fontBody,
  fontDisplay,
  favicon: addAsset(join(webPublic, "favicon-32.png"), "favicon"),
  touch: addAsset(join(webPublic, "apple-touch-icon.png"), "apple-touch-icon"),
  logo: addAsset(join(webPublic, "icons/icon-512.png"), "aihxm-logo"),
  og: addAsset(join(src, "assets/og-default.png"), "og-default"),
};

/** Page helpers: `shot("payroll")` returns { img, w, h } for a real product screenshot. */
const A = {
  ...shared,
  shot(name) {
    const [w, h] = dims[name];
    return { img: addAsset(join(src, `assets/screens/${name}.webp`), name), w, h };
  },
};

// ---- pages ----
const pageFiles = [
  "home",
  "platform",
  "core-hr",
  "payroll",
  "attendance",
  "leave",
  "talent",
  "workflows",
  "self-service",
  "reporting",
  "pakistan-payroll",
  "industries",
  "pricing",
  "security",
  "integrations",
  "about",
  "book-a-demo",
  "resources",
  "contact",
  "privacy",
];
const pages = [];
for (const f of pageFiles) {
  const mod = await import(`../src/pages/${f}.mjs`);
  pages.push(mod.default(A));
}

function writePage(path, html) {
  const dir = path === "/" ? dist : join(dist, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}
for (const p of pages) writePage(p.path, renderPage(p, { ...shared }));

// 404 (never indexed)
const notFound = renderPage(
  {
    path: "/404.html",
    title: "Page not found",
    description: "This page does not exist. Try the platform overview, or book a personalised demo and tell us what you were looking for.",
    noindex: true,
    body: `<section class="section"><div class="wrap narrow"><h1>That page is not here</h1><p class="lead">The link may be old or mistyped. Try the platform overview, or tell us what you were looking for.</p><div class="btn-row"><a class="btn btn-primary" href="/">Go to the home page</a><a class="btn btn-ghost" href="/book-a-demo/">Book a Personalized Demo</a></div></div></section>`,
  },
  { ...shared }
);
writeFileSync(join(dist, "404.html"), notFound);

// ---- SEO files ----
const indexable = pages.filter((p) => !p.noindex);
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexable
    .map((p) => `  <url><loc>${esc(site.url + p.path)}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`
);
writeFileSync(
  join(dist, "robots.txt"),
  site.indexable
    ? `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`
    : `# Preview build: search engines are asked to stay away until MARKETING_INDEXABLE=true is set for the real launch.\nUser-agent: *\nDisallow: /\n`
);
writeFileSync(
  join(dist, "llms.txt"),
  `# ${site.name}\n\n> ${site.description}\n\nAiHxM is built for Pakistani businesses. Where a capability is partly built, needs the customer's own setup, or is not built yet, the site says so. Prices are given on request.\n\n## Pages\n\n${indexable
    .map((p) => `- [${p.title}](${site.url}${p.path}): ${p.description}`)
    .join("\n")}\n`
);

// ---- Cloudflare Pages: headers and redirects ----
const apiOrigin = new URL(site.apiUrl).origin;
writeFileSync(
  join(dist, "_headers"),
  `# Cloudflare Pages response headers for the marketing site.
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${apiOrigin}; form-action 'self'; frame-ancestors 'none'; base-uri 'self'
`
);
// aihxm.com used to BE the app. Old links (emails, per-company sign-in addresses, bookmarks) keep working by moving to app.aihxm.com.
const app = site.appUrl;
writeFileSync(
  join(dist, "_redirects"),
  `# Old app addresses on aihxm.com now live on ${app}. Query strings (for example reset-password tokens) are kept by Cloudflare Pages.
/login  ${app}/login  301
/signup  ${app}/signup  301
/reset-password  ${app}/reset-password  301
/sso/*  ${app}/sso/:splat  301
/app  ${app}/app  301
/app/*  ${app}/app/:splat  301
/companies/*  ${app}/companies/:splat  301
/audit-log  ${app}/audit-log  301
/platform-admins  ${app}/platform-admins  301
/platform-branding  ${app}/platform-branding  301
/demo-requests  ${app}/demo-requests  301
/:slug/login  ${app}/:slug/login  301
`
);

console.log(`Built ${pages.length} pages + 404 into ${dist}`);
console.log(`Indexable: ${site.indexable}  |  Site URL: ${site.url}  |  API: ${site.apiUrl}`);
if (!existsSync(join(dist, "index.html"))) process.exit(1);
