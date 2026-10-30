// Page shell: <head> metadata, header with mega menus, footer, search dialog.
import { site } from "../site.config.mjs";
import { icon } from "./icons.mjs";
import { esc, brandLink, jsonLd } from "./ui.mjs";
import { flags } from "../content/flags.mjs";
import { modules, moduleGroups, groupBlurb, modulePath, solutions, industries, services, solutionPath, industryPath, servicePath, pakistan } from "../content/catalog.mjs";

const menuLink = (href, name, note, ico) =>
  `<a class="mm-link" href="${href}">${ico ? `<span class="mm-ico">${icon(ico)}</span>` : ""}<span><strong>${esc(name)}</strong>${note ? `<small>${esc(note)}</small>` : ""}</span></a>`;

const productsMenu = () => `<div class="mega mega-wide" id="menu-products" role="group" aria-label="Products">
  <div class="mega-lead"><a class="mm-feature" href="/platform/"><strong>Complete HRMS</strong><small>All ${modules.length} product areas, one connected platform</small></a>
    <a class="mm-feature alt" href="/pakistan-hrms/"><strong>HRMS for Pakistan</strong><small>Tax year, EOBI, holidays, PKR payroll</small></a></div>
  <div class="mega-cols">${moduleGroups
    .map((g) => `<div class="mega-col"><p class="mega-h">${esc(g)}</p>${modules.filter((m) => m.group === g).map((m) => menuLink(modulePath(m), m.name, "", m.icon)).join("")}</div>`)
    .join("")}</div></div>`;

const solutionsMenu = () => `<div class="mega" id="menu-solutions" role="group" aria-label="Solutions">
  <div class="mega-cols two"><div class="mega-col"><p class="mega-h">By team and size</p>${solutions.map((s) => menuLink(solutionPath(s), s.name, s.short, s.icon)).join("")}</div>
  <div class="mega-col"><p class="mega-h">By industry</p>${industries.map((s) => menuLink(industryPath(s), s.name, s.short, s.icon)).join("")}</div></div></div>`;

const servicesMenu = () => `<div class="mega" id="menu-services" role="group" aria-label="Services"><div class="mega-cols two">${services
  .map((s) => menuLink(servicePath(s), s.name, s.short, s.icon))
  .map((h) => `<div class="mega-col">${h}</div>`)
  .join("")}</div></div>`;

const resourcesMenu = () => `<div class="mega" id="menu-resources" role="group" aria-label="Resources"><div class="mega-cols two">
  <div class="mega-col">${menuLink("/resources/blog/", "Blog", "Articles on HR, payroll and attendance", "documents")}${menuLink("/resources/knowledge-center/", "HR Knowledge Center", "Guides by topic", "learning")}${menuLink("/resources/category/pakistan-payroll-guides/", "Pakistan Payroll & Compliance Guides", "Payroll, income tax and EOBI", "payroll")}</div>
  <div class="mega-col">${menuLink("/platform/", "Product Guides", "What each module does", "config")}${menuLink("/resources/faqs/", "FAQs", "Answers to common questions", "helpdesk")}${flags.caseStudies ? menuLink("/resources/case-studies/", "Case Studies", "", "recognition") : ""}${flags.webinars ? menuLink("/resources/webinars/", "Webinars", "", "surveys") : ""}</div></div></div>`;

const companyMenu = () => `<div class="mega" id="menu-company" role="group" aria-label="Company"><div class="mega-cols two">
  <div class="mega-col">${menuLink("/about/", "About AiHxM", "Who we are and why", "core-hr")}${menuLink("/trust/", "Trust Center", "What you can verify", "shield")}${menuLink("/security/", "Security & Privacy", "How data is protected", "organization")}${menuLink("/implementation/", "Implementation", "Eight phases, who does what", "config")}</div>
  <div class="mega-col">${menuLink("/pricing/", "Pricing", "How a quote is built", "compensation")}${menuLink("/playground/", "Playground", "Try it on sample data", "analytics")}${menuLink("/contact/", "Contact", "Talk to the team", "helpdesk")}</div></div></div>`;

const topItems = [
  ["Products", "menu-products", productsMenu, "/platform/"],
  ["Solutions", "menu-solutions", solutionsMenu, "/solutions/"],
  ["Services", "menu-services", servicesMenu, "/services/"],
  ["Resources", "menu-resources", resourcesMenu, "/resources/"],
  ["Company", "menu-company", companyMenu, "/about/"],
];

function header(path) {
  const desktop = topItems
    .map(([label, id, build, href]) => {
      const cur = path.startsWith(href) ? ' aria-current="true"' : "";
      return `<li class="has-mega"><button type="button" class="nav-link" aria-expanded="false" aria-controls="${id}"${cur}>${label}<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>${build()}</li>`;
    })
    .join("");
  const mobile = topItems
    .map(([label, , , href]) => {
      let links = "";
      if (label === "Products") links = [`<a href="/platform/">Complete HRMS</a>`, `<a href="/pakistan-hrms/">HRMS for Pakistan</a>`, ...modules.map((m) => `<a href="${modulePath(m)}">${esc(m.name)}</a>`)].join("");
      if (label === "Solutions") links = [...solutions.map((s) => `<a href="${solutionPath(s)}">${esc(s.name)}</a>`), ...industries.map((s) => `<a href="${industryPath(s)}">${esc(s.name)}</a>`)].join("");
      if (label === "Services") links = services.map((s) => `<a href="${servicePath(s)}">${esc(s.name)}</a>`).join("");
      if (label === "Resources") links = `<a href="/resources/blog/">Blog</a><a href="/resources/knowledge-center/">HR Knowledge Center</a><a href="/resources/category/pakistan-payroll-guides/">Pakistan Payroll & Compliance Guides</a><a href="/resources/faqs/">FAQs</a>`;
      if (label === "Company") links = `<a href="/about/">About AiHxM</a><a href="/trust/">Trust Center</a><a href="/security/">Security & Privacy</a><a href="/pricing/">Pricing</a><a href="/implementation/">Implementation</a><a href="/playground/">Playground</a><a href="/contact/">Contact</a>`;
      return `<details class="m-group"><summary>${label}</summary><div>${links}</div></details>`;
    })
    .join("");
  return `<header class="site-header" id="site-header"><div class="wrap bar">
    ${brandLink("h")}
    <nav class="main-nav" aria-label="Main"><ul>${desktop}</ul></nav>
    <div class="actions">
      <button type="button" class="icon-btn" id="search-open" aria-label="Search the site" aria-haspopup="dialog">${icon("search")}</button>
      <a class="login" href="${site.appUrl}/login">Login</a>
      <a class="btn btn-primary btn-sm" href="/book-a-demo/">Book a Demo</a>
      <button type="button" class="menu-btn" id="menu-toggle" aria-expanded="false" aria-controls="mobile-nav" aria-label="Menu"><span></span><span></span><span></span></button>
    </div></div>
    <nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">${mobile}<div class="m-actions"><a class="btn btn-primary" href="/book-a-demo/">Book a Demo</a><a class="btn btn-ghost" href="${site.appUrl}/login">Login</a></div></nav></header>
  <dialog id="search-dialog" class="search-dialog" aria-label="Search"><form method="dialog" class="search-form"><label for="search-input" class="sr">Search the site</label><input id="search-input" type="search" placeholder="Search modules, guides and services" autocomplete="off"><button class="btn btn-ghost btn-sm" value="close">Close</button></form><ul id="search-results" class="search-results" aria-live="polite"></ul></dialog>`;
}

const footerCols = () => [
  { title: "Products", links: [["Complete HRMS", "/platform/"], ...modules.slice(0, 8).map((m) => [m.name, modulePath(m)]), ["All products", "/platform/"]] },
  { title: "Solutions", links: [...solutions.slice(0, 6).map((s) => [s.name, solutionPath(s)]), ["Industries", "/industries/"], ["HRMS for Pakistan", "/pakistan-hrms/"]] },
  { title: "Services", links: [...services.map((s) => [s.name, servicePath(s)])] },
  { title: "Resources", links: [["Blog", "/resources/blog/"], ["HR Knowledge Center", "/resources/knowledge-center/"], ["Pakistan Payroll Guides", "/resources/category/pakistan-payroll-guides/"], ["FAQs", "/resources/faqs/"], ["Integrations", "/integrations/"], ["Pricing", "/pricing/"], ["Implementation", "/implementation/"]] },
  { title: "Company", links: [["About AiHxM", "/about/"], ["Trust Center", "/trust/"], ["Playground", "/playground/"], ["Contact", "/contact/"], ["Security", "/security/"], ["Privacy Policy", "/privacy/"], ["Terms of Service", "/terms/"], ["Login", `${site.appUrl}/login`], ["Book a Demo", "/book-a-demo/"]] },
];

function footer() {
  const contact = [site.contactEmail ? `<a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>` : "", site.contactPhone ? `<a href="tel:${esc(site.contactPhone.replace(/[^+\d]/g, ""))}">${esc(site.contactPhone)}</a>` : "", site.whatsapp ? `<a href="https://wa.me/${site.whatsapp}" rel="noopener">WhatsApp</a>` : ""].filter(Boolean);
  return `<footer class="site-footer"><div class="wrap">
    <div class="foot-top"><div class="foot-brand">${brandLink("f", "on-dark")}<p>${esc(site.tagline)}. One connected platform for people, payroll and performance.</p>${contact.length ? `<p class="foot-contact">${contact.join(" · ")}</p>` : `<p class="foot-contact"><a href="/contact/">Contact the team</a></p>`}</div>
    <div class="foot-cols">${footerCols().map((c) => `<div><h2>${esc(c.title)}</h2><ul>${c.links.map(([l, h]) => `<li><a href="${esc(h)}">${esc(l)}</a></li>`).join("")}</ul></div>`).join("")}</div></div>
    ${site.social.length ? `<ul class="social">${site.social.map(([n, u]) => `<li><a href="${esc(u)}" rel="noopener">${esc(n)}</a></li>`).join("")}</ul>` : ""}
    <p class="foot-bottom">© ${new Date().getFullYear()} ${esc(site.legalName)}. All rights reserved.</p></div></footer>`;
}

// Floating helper: a "back to top" button. It stays hidden until app.js shows it.
const floating = () => `<button type="button" class="to-top" id="to-top" aria-label="Back to top" hidden>${icon("arrow")}</button>`;

export function renderPage(p, shared) {
  const url = site.url + p.path;
  const robots = p.noindex || !site.indexable ? '<meta name="robots" content="noindex, nofollow">' : "";
  const title = p.title.includes("AiHxM") || p.title.includes("AiHxM") ? p.title : `${p.title} | AiHxM`;
  const ogImg = site.url + shared.og;
  const ld = [{ "@context": "https://schema.org", "@type": "Organization", name: site.name, url: site.url, logo: site.url + shared.logo, description: site.description }, ...(p.jsonld || [])];
  return `<!doctype html>
<html lang="en-PK"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(p.description)}">${robots}
<link rel="canonical" href="${esc(url)}"><meta name="theme-color" content="#6c5e98">
<meta property="og:type" content="${p.ogType || "website"}"><meta property="og:site_name" content="${esc(site.name)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(p.description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(ogImg)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(p.description)}">
<link rel="icon" href="${shared.favicon}" type="image/png"><link rel="apple-touch-icon" href="${shared.touch}">
<link rel="preload" href="${shared.font}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${shared.css}">${ld.map(jsonLd).join("")}
</head><body><script>document.documentElement.classList.add("js")</script>
<a class="skip" href="#main">Skip to content</a>
<div class="read-bar" id="read-bar" aria-hidden="true"><i></i></div>
${header(p.path)}
<main id="main">${p.body}</main>
${footer()}
${floating()}
<script src="${shared.js}" defer></script>${(p.scripts || []).map((u) => `<script src="${u}" defer></script>`).join("")}</body></html>`;
}
