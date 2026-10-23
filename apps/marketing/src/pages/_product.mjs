import { pageHero, featureList, frame, statusLegend, ctaBand, esc } from "../layout.mjs";

/**
 * Shared template for the product pages.
 * spec: { path, name, title, description, h1, lead, shot?, shotAlt?, shotCaption?, intro?, sections: [{ title, intro?, items: [[title, desc, status]] }],
 *         connects?: [string], note?: { title, html }, related: [[label, href]], interest }
 */
export function productPage(A, spec) {
  const shot = spec.shot ? A.shot(spec.shot) : null;
  const trail = [
    ["Home", "/"],
    ["Platform", "/platform/"],
    [spec.name, spec.path],
  ];
  const sections = spec.sections
    .map(
      (s, i) => `<section class="section${i % 2 === 0 ? "" : " soft"}"><div class="wrap">
<div class="split${i % 2 === 1 ? " flip" : ""}">
  <div><h2>${esc(s.title)}</h2>${s.intro ? `<p class="lead">${esc(s.intro)}</p>` : ""}</div>
  <div>${featureList(s.items)}</div>
</div></div></section>`
    )
    .join("");
  const body = `
${pageHero({ trail, title: spec.h1, lead: spec.lead })}
${
  shot
    ? `<section class="section"><div class="wrap">${frame({ ...shot, alt: spec.shotAlt, caption: spec.shotCaption })}</div></section>`
    : ""
}
<section class="section${shot ? " soft" : ""}"><div class="wrap narrow">${statusLegend()}${
    spec.intro ? `<div class="prose">${spec.intro}</div>` : ""
  }${
    spec.connects
      ? `<h2>How it connects to the rest</h2><ul class="ticks">${spec.connects.map((c) => `<li>${c}</li>`).join("")}</ul>`
      : ""
  }${
    spec.note ? `<div class="callout warn"><p class="callout-title">${esc(spec.note.title)}</p>${spec.note.html}</div>` : ""
  }</div></section>
${sections}
<section class="section"><div class="wrap narrow"><h3>Related</h3><p>${spec.related
    .map(([l, h]) => `<a href="${h}">${esc(l)}</a>`)
    .join(" &middot; ")} &middot; <a href="/book-a-demo/?interest=${spec.interest}">Ask about ${esc(spec.name.toLowerCase())} in a demo</a></p></div></section>
${ctaBand({})}
`;
  return { path: spec.path, title: spec.title, description: spec.description, trail, body };
}
