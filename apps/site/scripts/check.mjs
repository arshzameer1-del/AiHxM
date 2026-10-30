// Checks the built site in ./dist. Exits 1 on any failure. Run after build: `npm run test`.
//  - metadata (title, description, canonical, OG), one h1, heading order, alt text, image sizes, labelled form controls
//  - internal links, hash links, aria-controls targets, duplicate ids, JSON-LD validity, sitemap/robots/headers files
//  - content rules from the brief: no competitor names, no unproven claims, no statutory rates, no prices or support promises
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const problems = [];
const fail = (page, msg) => problems.push(`${page}: ${msg}`);
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

const htmlFiles = walk(dist).filter((f) => f.endsWith(".html"));
const pagePath = (f) => (f.endsWith("404.html") ? "/404.html" : "/" + f.slice(dist.length + 1).replace(/index\.html$/, ""));
const known = new Set(htmlFiles.map(pagePath));
const idsByPage = new Map();

// ---- content rules ----
// Names of products/companies in the same market. They must not appear anywhere public.
const COMPETITORS = ["SAP", "SuccessFactors", "Workday", "Oracle", "BambooHR", "Bamboo HR", "Zoho", "Odoo", "Gusto", "ADP", "Paychex", "Paycom", "Paylocity", "Rippling", "Deel", "Keka", "Darwinbox", "Zenefits", "Namely", "Personio", "Sage", "Greythr", "greytHR", "Freshteam", "Kissflow", "Hibob", "HiBob", "Lattice", "Culture Amp", "UKG", "Ceridian", "Dayforce", "Paycor", "TriNet", "Justworks", "Papaya Global", "Remote.com", "Cezanne", "PeopleHR", "People HR", "Sentrifugo", "OrangeHRM", "Eiger", "Horizon HR", "Humanage", "HR Pulse", "Sapphire HR", "Salaryo"];
// Third-party product names the integrations page must not use (no certified partner integrations exist).
const BRANDS = ["QuickBooks", "Xero", "Tally", "Okta", "Azure", "Entra", "Google Workspace", "Microsoft", "Slack", "Microsoft Teams", "ZKTeco", "Hikvision", "Suprema", "Salesforce", "Zapier", "Stripe", "PayPal", "HBL", "Meezan", "UBL", "MCB", "Allied Bank", "Bank Alfalah", "Standard Chartered", "Faysal", "JazzCash", "Easypaisa", "Raast", "1LINK", "1Link"];
const CLAIMS = [
  [/\bISO ?\d{4,5}\b/i, "certification number"],
  [/\bSOC ?[12]\b/i, "SOC report"],
  [/\bGDPR\b|\bHIPAA\b|\bPCI[- ]?DSS\b/i, "regulatory compliance claim"],
  [/\b(?:certified|accredited)\b(?![^<]{0,80}\b(?:no|not|nor|neither)\b)/i, "certification wording"],
  [/\bguarantee[sd]?\b/i, "guarantee"],
  [/\b99(?:\.\d+)?\s?%/, "uptime figure"],
  [/\b24\s?[/x]\s?7\b|\b24 hours?\b/i, "support hours"],
  [/\bSLA\b|service level agreement/i, "SLA"],
  [/\bfree trial\b|\bmoney[- ]back\b|\b\d+[- ]day trial\b/i, "trial or refund promise"],
  [/\b(?:Rs\.?|PKR|USD|\$|₨)\s?\d/i, "price or amount"],
  [/\b\d[\d,]*\s?(?:\/|per )(?:employee|user)\b/i, "per-employee price"],
  [/\btrusted by\b|\b\d[\d,]*\+? (?:customers|clients|companies|businesses)\b|\baward[- ]winning\b|\bnumber one\b|#1\b|\bmarket leader\b|\bbest[- ]in[- ]class\b|\bleading (?:hr|hrms|provider)/i, "unproven social proof or superlative"],
  [/\b(?:files?|filing|submits?|submission) (?:directly )?(?:with|to) (?:the )?(?:FBR|EOBI|government|tax)\b/i, "government filing claim"],
  [/\b(?:FBR|EOBI|government)[- ](?:approved|certified|endorsed|recognised|recognized)\b/i, "government approval claim"],
  [/\bAI[- ]powered\b|\bpredictive\b|\bmachine learning\b|\bchatbot\b/i, "AI/predictive claim (none exists)"],
];
// A statutory rate is a percentage or amount next to a statutory term. The site never states one.
const RATE = /\b(?:EOBI|PESSI|SESSI|WWF|WPPF|salary tax|income tax|slab|super tax|provident fund|gratuity)\b[^.<>]{0,90}\b\d+(?:\.\d+)?\s?(?:%|per ?cent|percent)/i;
const RATE_AFTER = /\b\d+(?:\.\d+)?\s?(?:%|per ?cent|percent)[^.<>]{0,60}\b(?:EOBI|PESSI|SESSI|WWF|WPPF|salary tax|income tax|slab)\b/i;

// Honest negations ("does not file with EOBI") would trip the claim scan, so exactly these sentences are set aside first.
const NEGATIONS = [/does not file with [A-Za-z ,]+?(?=[.,]|$| and )/gi, /AiHxM does not file with government bodies/gi, /no government certification is claimed/gi, /It is not a certified digital signature/gi, /none is a certified partner integration/gi, /Full SLA escalation rules are not built/gi, /no predictive analytics/gi, /Is analytics predictive\?/gi, /does not claim any third-party certification/gi];
const titles = new Map();
const descs = new Map();
let linkCount = 0;

for (const f of htmlFiles) {
  const html = readFileSync(f, "utf8");
  const page = pagePath(f);
  const is404 = page === "/404.html";
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  const visible = text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");

  // metadata
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!title) fail(page, "missing <title>");
  else {
    if (title.length > 78) fail(page, `title too long (${title.length}): ${title}`);
    if (titles.has(title)) fail(page, `duplicate title with ${titles.get(title)}`);
    titles.set(title, page);
  }
  if (!desc) fail(page, "missing meta description");
  else {
    if (desc.length < 60 || desc.length > 200) fail(page, `description length ${desc.length}`);
    if (descs.has(desc) && !is404) fail(page, `duplicate description with ${descs.get(desc)}`);
    descs.set(desc, page);
  }
  if (!/<link rel="canonical" href="https?:\/\/[^"]+">/.test(html)) fail(page, "missing canonical");
  if (!/<meta property="og:image" content="https?:\/\//.test(html)) fail(page, "missing og:image");
  if (!/<html lang="en-PK">/.test(html)) fail(page, "missing html lang");
  if (!/<meta name="viewport"/.test(html)) fail(page, "missing viewport");

  // structure
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) fail(page, `expected 1 <h1>, found ${h1}`);
  let prev = 0;
  for (const m of html.replace(/<dialog[\s\S]*?<\/dialog>/g, "").matchAll(/<h([1-6])[\s>]/g)) {
    const lvl = Number(m[1]);
    if (prev && lvl > prev + 1) fail(page, `heading level jumps from h${prev} to h${lvl}`);
    prev = lvl;
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const idSet = new Set();
  for (const id of ids) {
    if (idSet.has(id) && !/^g-/.test(id)) fail(page, `duplicate id #${id}`);
    idSet.add(id);
  }
  idsByPage.set(page, idSet);
  for (const m of html.matchAll(/aria-controls="([^"]+)"/g)) if (!idSet.has(m[1])) fail(page, `aria-controls target #${m[1]} missing`);
  for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) if (!idSet.has(m[1])) fail(page, `aria-labelledby target #${m[1]} missing`);
  if (/<script(?![^>]*(?:src=|type="application\/ld\+json"))[^>]*>(?!document\.documentElement\.classList\.add\("js"\))/.test(html)) fail(page, "unexpected inline script");
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch { fail(page, "invalid JSON-LD"); }
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt="[^"]+"/.test(m[0])) fail(page, `image without alt: ${m[0].slice(0, 80)}`);
    if (!/\swidth="\d+"/.test(m[0]) || !/\sheight="\d+"/.test(m[0])) fail(page, "image without width/height");
  }
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/type="(hidden|submit)"/.test(attrs)) continue;
    const id = (attrs.match(/\sid="([^"]+)"/) || [])[1];
    if (/name="website"/.test(attrs)) continue; // the hidden honeypot field
    if (!id && !/type="(checkbox|radio)"/.test(attrs)) fail(page, `form control without id: ${m[0].slice(0, 60)}`);
    else if (id && !new RegExp(`for="${id}"`).test(html)) fail(page, `control #${id} has no label`);
  }
  for (const m of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) if (!/rel="[^"]*noopener/.test(m[0])) fail(page, "target=_blank without noopener");

  // links
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|tel:|data:)/.test(raw)) continue;
    linkCount++;
    const [pathPart, hash] = raw.split("#");
    const [u] = pathPart.split("?");
    if (!u && hash) { if (!idSet.has(hash)) fail(page, `broken hash link #${hash}`); continue; }
    if (u.startsWith("/")) {
      if (u.startsWith("/assets/") || /\.(xml|txt|png|webp|ico|svg|json)$/.test(u)) { if (!existsSync(join(dist, u))) fail(page, `missing asset ${u}`); }
      else if (!known.has(u)) fail(page, `broken internal link ${u}`);
    }
  }

  // content rules (the 404 and legal templates are included on purpose)
  for (const w of COMPETITORS) if (new RegExp(`(?<![A-Za-z])${w.replace(/[.]/g, "\\.")}(?![A-Za-z])`, w === "SAP" || w === "ADP" || w === "UKG" ? "" : "i").test(visible + " " + (html.match(/<title>[^<]*/) || [""])[0])) fail(page, `competitor name "${w}"`);
  if (page === "/integrations/") for (const w of BRANDS) if (new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`).test(visible)) fail(page, `third-party brand "${w}" on the integrations page`);
  // Sample-data panels are labelled as fictional, so amounts inside them are not prices.
  const claimText = NEGATIONS.reduce((t, re) => t.replace(re, " "), text.replace(/<div class="mock[\s\S]*?<p class="mock-foot">[^<]*<\/p><\/div>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " "));
  for (const [re, label] of CLAIMS) {
    const mm = claimText.match(re);
    if (mm) {
      const at = claimText.search(re);
      fail(page, `${label}: "…${claimText.slice(Math.max(0, at - 50), at + 70)}…"`);
    }
  }
  // Readiness stays internal: no public page may show a development-status label or an engineering limitation.
  for (const [re, label] of [[/\b(?:in development|partially available|partly built|partially implemented|requires external integration|coming soon)\b/i, "internal status wording"], [/class="chip (?:soon|part|dev|integ)"/, "status chip"], [/\b(?:not built|not yet built|no provider is connected|is not implemented|under construction)\b/i, "engineering limitation wording"]]) {
    const mm = visible.match(re) || html.match(re);
    if (mm) fail(page, `${label}: "${mm[0]}"`);
  }
  for (const re of [RATE, RATE_AFTER]) {
    const mm = visible.match(re);
    if (mm) fail(page, `statutory rate stated: "${mm[0].slice(0, 120)}"`);
  }
  if (/lorem ipsum|\bTODO\b|\bTBD\b|example@|your@email|hello@aihxm\.com|\[(?:company|name|date)\]/i.test(visible)) fail(page, "placeholder text found");
  if (/\bDemo\b.*\bcustomers? (?:say|said)\b|\"[^\"]{20,}\"\s*[–—-]\s*[A-Z][a-z]+ [A-Z][a-z]+, /.test(visible)) fail(page, "testimonial-like text");
}

for (const must of ["sitemap.xml", "robots.txt", "llms.txt", "_headers", "_redirects", "404.html", "search-index.json"]) if (!existsSync(join(dist, must))) problems.push(`missing ${must}`);
const sitemap = readFileSync(join(dist, "sitemap.xml"), "utf8");
const locs = (sitemap.match(/<loc>/g) || []).length;
if (locs !== htmlFiles.length - 1) problems.push(`sitemap has ${locs} URLs for ${htmlFiles.length - 1} pages`);
try { JSON.parse(readFileSync(join(dist, "search-index.json"), "utf8")); } catch { problems.push("search-index.json is not valid JSON"); }
if (walk(dist).some((f) => /LAUNCH_READINESS/i.test(f))) problems.push("internal readiness register found in dist");
const headers = readFileSync(join(dist, "_headers"), "utf8");
if (!/Content-Security-Policy/.test(headers) || /script-src[^;]*unsafe-inline/.test(headers)) problems.push("CSP missing or allows inline scripts");

console.log(`Checked ${htmlFiles.length} HTML files, ${linkCount} internal references, ${titles.size} unique titles.`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("All checks passed.");
