// Checks the built site in ./dist: metadata, headings, images, links, forbidden content. Exits 1 on any failure.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const problems = [];
const fail = (page, msg) => problems.push(`${page}: ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const htmlFiles = walk(dist).filter((f) => f.endsWith(".html"));
const pagePath = (f) => "/" + f.slice(dist.length + 1).replace(/index\.html$/, "").replace(/\/$/, "") + (f.endsWith("404.html") ? "" : "/");
const known = new Set(htmlFiles.map((f) => (f.endsWith("404.html") ? "/404.html" : pagePath(f).replace(/^\/\/$/, "/"))));
known.add("/");

const titles = new Map();
const descs = new Map();
let linkCount = 0;

for (const f of htmlFiles) {
  const html = readFileSync(f, "utf8");
  const page = f.slice(dist.length);
  const is404 = f.endsWith("404.html");
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!title) fail(page, "missing <title>");
  else {
    if (title.length > 70) fail(page, `title too long (${title.length}): ${title}`);
    if (titles.has(title)) fail(page, `duplicate title with ${titles.get(title)}`);
    titles.set(title, page);
  }
  if (!desc) fail(page, "missing meta description");
  else {
    if (desc.length < 60 || desc.length > 190) fail(page, `description length ${desc.length}`);
    if (descs.has(desc) && !is404) fail(page, `duplicate description with ${descs.get(desc)}`);
    descs.set(desc, page);
  }
  if (!/<link rel="canonical" href="https?:\/\/[^"]+">/.test(html)) fail(page, "missing canonical");
  if (!/<meta property="og:image" content="https?:\/\//.test(html)) fail(page, "missing og:image");
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) fail(page, `expected 1 <h1>, found ${h1}`);
  if (/<html lang="en">/.test(html) === false) fail(page, "missing html lang");
  if (/<script(?![^>]*(src=|type="application\/ld\+json"))[^>]*>/.test(html)) fail(page, "inline script (blocked by CSP)");
  if (/\sstyle="/.test(html)) fail(page, "inline style attribute (blocked by CSP)");
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt="[^"]+"/.test(m[0])) fail(page, `image without alt: ${m[0].slice(0, 80)}`);
    if (!/\swidth="\d+"/.test(m[0]) || !/\sheight="\d+"/.test(m[0])) fail(page, "image without width/height");
  }
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/type="(hidden|submit)"/.test(attrs)) continue;
    const id = (attrs.match(/\sid="([^"]+)"/) || [])[1];
    if (!id) fail(page, `form control without id: ${m[0].slice(0, 60)}`);
    else if (!new RegExp(`for="${id}"`).test(html) && !new RegExp(`<label[^>]*>\\s*<input[^>]*id="${id}"`).test(html))
      fail(page, `control #${id} has no label`);
  }
  if (/lorem ipsum|TODO|hello@aihxm\.com|example@|\bTBD\b/i.test(html)) fail(page, "placeholder text found");
  for (const m of html.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:)/.test(u)) continue;
    linkCount++;
    if (u.startsWith("/")) {
      const isAsset = u.startsWith("/assets/") || /\.(xml|txt|png|webp|ico|svg)$/.test(u);
      if (isAsset) {
        if (!existsSync(join(dist, u))) fail(page, `missing asset ${u}`);
      } else if (!known.has(u)) fail(page, `broken internal link ${u}`);
    }
  }
}
for (const must of ["sitemap.xml", "robots.txt", "llms.txt", "_headers", "_redirects", "404.html"]) {
  if (!existsSync(join(dist, must))) problems.push(`missing ${must}`);
}
const sitemap = readFileSync(join(dist, "sitemap.xml"), "utf8");
if ((sitemap.match(/<loc>/g) || []).length !== htmlFiles.length - 1) problems.push("sitemap URL count does not match pages");

console.log(`Checked ${htmlFiles.length} HTML files, ${linkCount} internal references.`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("All checks passed.");
