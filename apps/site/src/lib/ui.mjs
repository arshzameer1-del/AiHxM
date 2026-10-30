// Shared building blocks. Every function returns an HTML string. Text is escaped with esc() unless a function says it takes HTML.
import { icon } from "./icons.mjs";
import { STATUS, flags } from "../content/flags.mjs";
import { resolve, parseItem } from "../content/catalog.mjs";

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const logoMark = (id = "m") => `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><defs><linearGradient id="g-${id}" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#71639e"/><stop offset="1" stop-color="#714b67"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g-${id})"/><g stroke="#fff" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="21" x2="16" y2="11"/><line x1="16" y1="11" x2="22" y2="21"/><line x1="10" y1="21" x2="22" y2="21"/></g><circle cx="16" cy="11" r="2.6" fill="#fff"/><circle cx="10" cy="21" r="2.6" fill="#fff"/><circle cx="22" cy="21" r="2.6" fill="#fff"/></svg>`;
export const brandLink = (id, cls = "") => `<a class="brand ${cls}" href="/" aria-label="AI HXM home">${logoMark(id)}<span>AI HXM</span></a>`;

export const chip = (status) => {
  const s = STATUS[status] || STATUS.available;
  return `<span class="chip ${s.tone}">${s.label}</span>`;
};

export const statusLegend = () =>
  `<ul class="legend" aria-label="What the status labels mean">${["available", "setup", "partial", ...(flags.showUpcoming ? ["upcoming"] : [])]
    .map((k) => `<li>${chip(k)}<span>${{ available: "works in the product today", setup: "works once your company enters its own data, rates or devices", partial: "some of it works", upcoming: "planned, not in the product yet" }[k]}</span></li>`)
    .join("")}</ul>`;

export const btn = (href, label, kind = "primary", extra = "") => `<a class="btn btn-${kind}" href="${esc(href)}"${extra}>${esc(label)}</a>`;
export const demoCta = (label = "Book a Personalized Demo", interest = "") => btn(`/book-a-demo/${interest ? `?interest=${encodeURIComponent(interest)}` : ""}`, label, "primary");

export const breadcrumbs = (trail) =>
  `<nav class="crumbs" aria-label="Breadcrumb"><ol>${trail.map(([label, href], i) => `<li>${href && i < trail.length - 1 ? `<a href="${href}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`}</li>`).join("")}</ol></nav>`;

export const breadcrumbLd = (trail, site) => ({
  "@context": "https://schema.org", "@type": "BreadcrumbList",
  itemListElement: trail.map(([label, href], i) => ({ "@type": "ListItem", position: i + 1, name: label, item: site.url + (href || "") })),
});

/** A small "fictional product panel": rows of label / value / optional state. Marked as sample data. */
export const mock = (m, extra = "") =>
  `<div class="mock ${extra}" role="img" aria-label="Illustration of the ${esc(m.title)} screen with sample data"><div class="mock-head"><span>${esc(m.title)}</span><i></i></div><ul>${m.rows
    .map(([a, b, tone]) => `<li><span>${esc(a)}</span>${b ? `<b${tone ? ` class="t-${tone}"` : ""}>${esc(b)}</b>` : ""}</li>`)
    .join("")}</ul><p class="mock-foot">${esc(m.foot || "Sample data")}</p></div>`;

/** A real screenshot of the product in a window frame. */
export const frame = ({ img, w, h, alt, caption, eager = false }) =>
  `<figure class="frame"><div class="frame-bar" aria-hidden="true"><i></i><i></i><i></i><span>app.aihxm.com</span></div><img src="${img}" width="${w}" height="${h}" alt="${esc(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;

export const featureGrid = (groups) =>
  `<div class="cap-groups">${groups
    .map(
      (g) => `<section class="cap-group reveal"><h3>${esc(g.t)}</h3><ul class="caps">${g.items
        .map(parseItem)
        .filter((i) => i.status !== "upcoming" || flags.showUpcoming)
        .map((i) => `<li><span class="cap-name">${esc(i.name)}</span>${i.status !== "available" ? chip(i.status) : ""}</li>`)
        .join("")}</ul></section>`
    )
    .join("")}</div>`;

export const faqBlock = (items, id = "faq") =>
  `<div class="faq" id="${id}">${items.map(([q, a]) => `<details class="reveal"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>`;

export const faqLd = (items) => ({
  "@context": "https://schema.org", "@type": "FAQPage",
  mainEntity: items.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
});

/** Card linking to a catalogue entry (module, service, solution, Pakistan page). */
export const linkCard = (slug) => {
  const r = resolve(slug);
  return `<a class="card tilt reveal" href="${r.href}"><span class="card-ico">${icon(r.icon)}</span><h3>${esc(r.name)}</h3><p>${esc(r.short)}</p><span class="more">Learn more ${icon("arrow")}</span></a>`;
};
export const cardGrid = (slugs, cols = 3) => `<div class="grid g${cols}">${slugs.map(linkCard).join("")}</div>`;

export const pairCards = (pairs, cls = "") => `<div class="grid g3 ${cls}">${pairs.map(([t, d]) => `<div class="plain reveal"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</div>`;

export const steps = (list, title) =>
  `<ol class="flow reveal" aria-label="${esc(title)}">${list.map(([t, d], i) => `<li style="--i:${i}"><span class="flow-dot">${i + 1}</span><div><strong>${esc(t)}</strong><span>${esc(d)}</span></div></li>`).join("")}</ol>`;

export const ticks = (items) => `<ul class="ticks">${items.map((i) => `<li>${icon("check")}<span>${esc(i)}</span></li>`).join("")}</ul>`;

export const section = ({ id, cls = "", eyebrow, title, srTitle, intro, body, wide = false }) =>
  `<section class="section ${cls}"${id ? ` id="${id}"` : ""}><div class="wrap${wide ? " wide" : ""}">${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ""}${title ? `<h2 class="reveal">${esc(title)}</h2>` : srTitle ? `<h2 class="sr">${esc(srTitle)}</h2>` : ""}${intro ? `<p class="lead reveal">${esc(intro)}</p>` : ""}${body || ""}</div></section>`;

export const ctaBand = ({ title = "Ready to Transform Your HR Operations?", text = "Book a personalised demo and see AiHxM set up around the way your business works.", interest = "" } = {}) =>
  `<section class="section"><div class="wrap"><div class="cta-band reveal"><div class="orb o1" aria-hidden="true"></div><div class="orb o2" aria-hidden="true"></div><div class="cta-copy"><h2>${esc(title)}</h2><p>${esc(text)}</p></div><div class="btn-row">${btn(`/book-a-demo/${interest ? `?interest=${interest}` : ""}`, "Book Your AIHXM Demo", "light")}${btn("/platform/", "Explore the Platform", "outline-light")}</div></div></div></section>`;

export const notice = (html, tone = "info") => `<aside class="notice ${tone}" role="note">${html}</aside>`;

export const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
