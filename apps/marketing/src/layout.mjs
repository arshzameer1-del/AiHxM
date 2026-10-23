import { site, nav, footerColumns } from "./site.config.mjs";

export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The real AiHxM mark (same drawing as apps/web/src/components/AihxmLogo.tsx): blue-to-violet square, three-node lattice. */
export const logoMark = (id = "m") => `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><defs><linearGradient id="g-${id}" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g-${id})"/><g stroke="#fff" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="21" x2="16" y2="11"/><line x1="16" y1="11" x2="22" y2="21"/><line x1="10" y1="21" x2="22" y2="21"/></g><circle cx="16" cy="11" r="2.6" fill="#fff"/><circle cx="10" cy="21" r="2.6" fill="#fff"/><circle cx="22" cy="21" r="2.6" fill="#fff"/></svg>`;

export const brandLink = (id) => `<a class="brand" href="/" aria-label="AI HXM home">${logoMark(id)}<span>AI HXM</span></a>`;

/** Honest capability status. Every feature the site names carries one of these. */
export const STATUS = {
  ok: ["Available", "ok"],
  part: ["Partly built", "part"],
  setup: ["Needs your setup", "setup"],
  no: ["Not built yet", "no"],
};
export const chip = (key) => `<span class="chip ${STATUS[key][1]}">${STATUS[key][0]}</span>`;

export const statusLegend = () =>
  `<ul class="legend" aria-label="What the status labels mean"><li>${chip("ok")}<span>works in the product today</span></li><li>${chip("setup")}<span>works once your company enters its own data</span></li><li>${chip("part")}<span>some of it works</span></li><li>${chip("no")}<span>on our list, not in the product</span></li></ul>`;

/** items: [title, description, statusKey] */
export const featureList = (items) =>
  `<ul class="features">${items
    .map(
      ([t, d, s]) =>
        `<li><div><strong>${esc(t)}</strong>${d ? `<span class="d">${esc(d)}</span>` : ""}</div>${s ? chip(s) : ""}</li>`
    )
    .join("")}</ul>`;

export const ticks = (items) => `<ul class="ticks">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

/** A real product screenshot in a window frame. `img` is the URL returned by the asset registry. */
export const frame = ({ img, w, h, alt, caption, url = "app.aihxm.com", eager = false }) =>
  `<figure class="frame"><div class="frame-bar" aria-hidden="true"><i></i><i></i><i></i><span>${esc(url)}</span></div><img src="${img}" width="${w}" height="${h}" alt="${esc(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;

export const ctaBand = ({
  title = "See it with your own numbers",
  text = "Book a personalised demo and we will walk through payroll, attendance and approvals using your company's setup.",
} = {}) =>
  `<section class="section"><div class="wrap"><div class="cta-band"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div><div class="btn-row"><a class="btn btn-light" href="/book-a-demo/">Book a Personalized Demo</a><a class="btn btn-ghost btn-on-navy" href="/platform/">Explore the Platform</a></div></div></div></section>`;

const navHtml = (path) => {
  const items = nav
    .map((n) => {
      const cur = path === n.href || (n.href !== "/" && path.startsWith(n.href) && !n.children) ? ' aria-current="page"' : "";
      if (!n.children) return `<li><a class="nav-link" href="${n.href}"${cur}>${esc(n.label)}</a></li>`;
      const inSection = path.startsWith("/platform/") ? ' aria-current="page"' : "";
      return `<li class="has-menu"><a class="nav-link" href="${n.href}"${inSection}>${esc(n.label)} <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></a><div class="menu">${n.children
        .map((c) => `<a href="${c.href}">${esc(c.label)}<small>${esc(c.note)}</small></a>`)
        .join("")}</div></li>`;
    })
    .join("");
  return `<nav class="main-nav" id="main-nav" aria-label="Main"><ul>${items}</ul></nav>`;
};

export const breadcrumbs = (trail) =>
  `<nav class="crumbs" aria-label="Breadcrumb">${trail
    .map(([label, href], i) => (i === trail.length - 1 ? `<span aria-current="page">${esc(label)}</span>` : `<a href="${href}">${esc(label)}</a>`))
    .join(" / ")}</nav>`;

export const pageHero = ({ trail, title, lead, actions = true }) =>
  `<section class="page-hero"><div class="wrap">${trail ? breadcrumbs(trail) : ""}<h1>${esc(title)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : ""}${
    actions
      ? `<div class="btn-row"><a class="btn btn-primary" href="/book-a-demo/">Book a Personalized Demo</a><a class="btn btn-ghost" href="/platform/">Explore the Platform</a></div>`
      : ""
  }</div></section>`;

const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;

/**
 * Wraps a page body in the shared shell and builds head metadata.
 * `assets` is the asset registry's url lookup (css, js, favicon, og image).
 */
export function renderPage(page, assets) {
  const url = site.url + page.path;
  const title = page.path === "/" ? `${site.name}: ${site.tagline}` : `${page.title} | ${site.name}`;
  const desc = page.description;
  const robots = site.indexable && !page.noindex ? "index, follow" : "noindex, nofollow";
  const ld = [];
  if (page.path === "/") {
    ld.push({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: site.name,
      url: site.url,
      logo: site.url + assets.logo,
      ...(site.contactEmail ? { email: site.contactEmail } : {}),
    });
    ld.push({ "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: site.url });
    ld.push({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: site.name,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web browser (installable on Android and iPhone)",
      description: site.description,
      url: site.url,
    });
  } else if (page.trail) {
    ld.push({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: page.trail.map(([name, href], i) => ({
        "@type": "ListItem",
        position: i + 1,
        name,
        item: site.url + (href || page.path),
      })),
    });
  }
  if (page.faq) {
    ld.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })),
    });
  }
  const ogImg = site.url + assets.og;
  const ctaPath = page.path === "/book-a-demo/";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="#0b1220">
<link rel="canonical" href="${url}">
<link rel="icon" href="${assets.favicon}" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${assets.touch}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${site.name}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${ogImg}">
<link rel="preload" href="${assets.fontBody}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${assets.fontDisplay}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${assets.css}">
${ld.map(jsonLd).join("\n")}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header" id="site-header">
<div class="wrap header-row">
${brandLink("h")}
${navHtml(page.path)}
<div class="header-cta"><a class="btn btn-ghost btn-sm" href="${site.appUrl}/login">Sign in</a>${ctaPath ? "" : `<a class="btn btn-primary btn-sm" href="/book-a-demo/">Book a Personalized Demo</a>`}</div>
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav" id="menu-toggle">Menu</button>
</div>
</header>
<main id="main">
${page.body}
</main>
<footer class="site-footer">
<div class="wrap">
<div class="footer-grid">
<div class="footer-brand">${brandLink("f")}<p>${esc(site.description)}</p>${
    site.contactEmail ? `<p><a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a></p>` : `<p><a href="/book-a-demo/">Book a demo</a> to talk to the team.</p>`
  }</div>
${footerColumns
  .map((c) => `<div><h3>${esc(c.title)}</h3><ul>${c.links.map(([l, h]) => `<li><a href="${h}">${esc(l)}</a></li>`).join("")}</ul></div>`)
  .join("")}
</div>
<div class="footer-bottom"><span>&copy; ${new Date().getFullYear()} ${esc(site.legalName)}. All rights reserved.</span><span><a href="${site.appUrl}/login">Sign in to your company</a> &middot; <a href="/privacy/">Privacy notice</a></span></div>
</div>
</footer>
<script src="${assets.js}" defer></script>
</body>
</html>
`;
}
