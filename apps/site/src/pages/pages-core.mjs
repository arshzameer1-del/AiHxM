// Product, hub, solution, industry, service and Pakistan pages. All content comes from src/content.
import { supportTiersBlock } from "./pages-trust.mjs";
import { site } from "../site.config.mjs";
import { icon } from "../lib/icons.mjs";
import { esc, btn, demoCta, breadcrumbs, breadcrumbLd, frame, mock, featureGrid, statusLegend, faqBlock, faqLd, cardGrid, linkCard, pairCards, steps, ticks, section, ctaBand, notice } from "../lib/ui.mjs";
import { modules, moduleGroups, groupBlurb, modulePath, parseItem, solutions, industries, services, pakistan, solutionPath, industryPath, servicePath } from "../content/catalog.mjs";
import { servicesIntro } from "../content/services.mjs";
import { flags } from "../content/flags.mjs";

const groupTone = { People: "t-purple", Time: "t-teal", Pay: "t-plum", Talent: "t-indigo", Experience: "t-magenta", Platform: "t-purple", Insight: "t-teal" };

export function modulePage(m, i, A) {
  const trail = [["Home", "/"], ["Platform", "/platform/"], [m.name, modulePath(m)]];
  const shot = m.shot ? A.shot(m.shot) : null;
  const visual = shot
    ? `<div class="hero-visual">${frame({ ...shot, alt: `The ${m.name} area of AiHxM, from a demonstration company`, eager: true })}${mock(m.mock, "overlay")}</div>`
    : `<div class="hero-visual solo"><div class="big-ico" aria-hidden="true">${icon(m.icon)}</div>${mock(m.mock)}</div>`;
  const body = `
<section class="phero ${groupTone[m.group]} ${i % 2 ? "v-b" : "v-a"}"><div class="bg-grid" aria-hidden="true"></div><div class="wrap phero-grid">
  <div class="phero-copy">${breadcrumbs(trail)}<p class="eyebrow">${esc(m.group)} · ${esc(m.name)}</p><h1>${esc(m.h1)}</h1><p class="lead">${esc(m.lede)}</p>
  <div class="btn-row">${demoCta("Book a Personalized Demo", m.interest)}${btn("#capabilities", "See capabilities", "ghost")}</div></div>
  ${visual}</div></section>
${section({ eyebrow: "The problem", title: "What this solves", body: pairCards(m.problems) })}
${section({ cls: "alt", id: "capabilities", eyebrow: "Capabilities", title: `What ${m.name} includes`, intro: "What the module covers, grouped by the job it does.", wide: true, body: featureGrid(m.caps) })}
${section({ eyebrow: "How it works", title: m.flowTitle, body: steps(m.flow, m.flowTitle) })}
${section({ cls: "alt", eyebrow: "In practice", title: "Practical use cases", body: pairCards(m.cases, "cases") })}
<section class="section"><div class="wrap two-col"><div><p class="eyebrow">Business benefits</p><h2 class="reveal">Why it matters</h2>${pairCards(m.benefits, "stack").replace("grid g3", "stack")}</div><div><p class="eyebrow">Configuration</p><h2 class="reveal">Set it up your way</h2>${ticks(m.config)}</div></div></section>
${section({ cls: "alt", eyebrow: "Related modules", title: "Works with", body: cardGrid(m.related) })}
${section({ eyebrow: "FAQs", title: `${m.name} questions`, body: faqBlock(m.faqs) })}
${ctaBand({ title: `See ${m.name} set up for your business`, text: "Book a personalised demo and we will walk through it with your own scenarios.", interest: m.interest })}`;
  return {
    path: modulePath(m),
    title: `${m.name} Software | AiHxM`,
    description: `${m.lede}`.slice(0, 158).replace(/\s+\S*$/, "") + ".",
    body,
    jsonld: [breadcrumbLd(trail, site), faqLd(m.faqs)],
  };
}

export function platformPage(A) {
  const trail = [["Home", "/"], ["Platform", "/platform/"]];
  const groups = moduleGroups
    .map((g) => section({ cls: g === moduleGroups[1] || g === moduleGroups[3] || g === moduleGroups[5] ? "alt" : "", eyebrow: g, title: groupBlurb[g], wide: true, body: cardGrid(modules.filter((m) => m.group === g).map((m) => m.slug), 3) }))
    .join("");
  return {
    path: "/platform/",
    title: "Complete HRMS Platform | HR, Payroll and Attendance Software | AiHxM",
    description: `One connected HRMS with ${modules.length} product areas: core HR, leave, attendance, payroll, workflows, recruitment, performance, talent, learning, reports and a configuration centre.`,
    body: `<section class="phero t-purple v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap phero-grid"><div class="phero-copy">${breadcrumbs(trail)}<p class="eyebrow">Complete HRMS</p><h1>One employee record. ${modules.length} connected product areas.</h1><p class="lead">AiHxM brings the whole employee lifecycle into one platform. Change a fact once and leave, attendance, payroll, approvals and reports all see it.</p><div class="btn-row">${demoCta()}${btn("/pakistan-hrms/", "HRMS for Pakistan", "ghost")}</div></div><div class="hero-visual">${frame({ ...A.shot("employees"), alt: "The AiHxM employee workspace from a demonstration company", eager: true })}</div></div></section>
${groups}${ctaBand()}`,
    jsonld: [breadcrumbLd(trail, site), { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "AiHxM", applicationCategory: "BusinessApplication", operatingSystem: "Web", description: site.description }],
  };
}

function audiencePage({ item, kind, path, parent, parentPath, A }) {
  const trail = [["Home", "/"], [parent, parentPath], [item.name, path]];
  const isInd = kind === "industry";
  const body = `
<section class="phero ${isInd ? "t-teal" : "t-indigo"} v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap phero-grid"><div class="phero-copy">${breadcrumbs(trail)}<p class="eyebrow">${isInd ? "Industry" : "Solution"} · ${esc(item.name)}</p><h1>${esc(item.h1)}</h1><p class="lead">${esc(item.lede)}</p><div class="btn-row">${demoCta()}</div></div><div class="hero-visual solo"><div class="big-ico" aria-hidden="true">${icon(item.icon)}</div></div></div></section>
${section({ eyebrow: isInd ? "Typical challenges" : "The challenge", title: isInd ? `What ${item.name.toLowerCase()} teams deal with` : "What gets in the way", body: isInd ? ticks(item.problems) : pairCards(item.challenges) })}
${section({ cls: "alt", eyebrow: "How AiHxM helps", title: "Capabilities that apply", body: isInd ? ticks(item.help) : pairCards(item.how) })}
${section({ eyebrow: "Modules to start with", title: "Where to begin", body: cardGrid(item.modules, item.modules.length > 3 ? 4 : 3) })}
${item.note ? section({ body: notice(`<strong>Good to know.</strong> ${esc(item.note)}`) }) : ""}
${isInd ? section({ cls: "alt", body: notice("AiHxM is a general HR platform. This page describes how its existing capabilities apply to the industry; it does not describe industry-specific functionality.") }) : ""}
${ctaBand({ title: `See how AiHxM fits ${item.name.toLowerCase()}` })}`;
  return { path, title: `${item.name} HR and Payroll Software | AiHxM`, description: item.lede.slice(0, 158).replace(/\s+\S*$/, "") + ".", body, jsonld: [breadcrumbLd(trail, site)] };
}

export const solutionPageFor = (s, A) => audiencePage({ item: s, kind: "solution", path: solutionPath(s), parent: "Solutions", parentPath: "/solutions/", A });
export const industryPageFor = (s, A) => audiencePage({ item: s, kind: "industry", path: industryPath(s), parent: "Industries", parentPath: "/industries/", A });

const hubCards = (items, hrefOf) => `<div class="grid g3">${items.map((s) => `<a class="card tilt reveal" href="${hrefOf(s)}"><span class="card-ico">${icon(s.icon)}</span><h3>${esc(s.name)}</h3><p>${esc(s.short)}</p><span class="more">Learn more ${icon("arrow")}</span></a>`).join("")}</div>`;

export function solutionsHub() {
  const trail = [["Home", "/"], ["Solutions", "/solutions/"]];
  return { path: "/solutions/", title: "HR Software Solutions for Every Team and Business Size | AiHxM", description: "How AiHxM fits small and medium businesses, large enterprises, HR, finance and payroll teams, growing organisations and multi-location companies.",
    body: `<section class="phero t-indigo v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap narrow">${breadcrumbs(trail)}<p class="eyebrow">Solutions</p><h1>HR that fits the way your organisation is built</h1><p class="lead">Different sizes and different teams need different starting points. Pick the one that sounds like you.</p></div></section>${section({ wide: true, srTitle: "Solutions by team and size", body: hubCards(solutions, solutionPath) })}${section({ cls: "alt", eyebrow: "By industry", title: "Industry perspectives", wide: true, body: hubCards(industries, industryPath) })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}
export function industriesHub() {
  const trail = [["Home", "/"], ["Industries", "/industries/"]];
  return { path: "/industries/", title: "HR Software by Industry | Manufacturing, Healthcare, Retail and More | AiHxM", description: "How AiHxM's HR, payroll and attendance capabilities apply to manufacturing, healthcare, retail, IT, construction, professional services, education and hospitality.",
    body: `<section class="phero t-teal v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap narrow">${breadcrumbs(trail)}<p class="eyebrow">Industries</p><h1>The same platform, applied to your industry's HR problems</h1><p class="lead">Each page explains the HR challenges common in the industry and which AiHxM capabilities apply. AiHxM is a general platform; it does not claim industry-specific modules.</p></div></section>${section({ wide: true, srTitle: "Industries", body: hubCards(industries, industryPath) })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function servicesHub() {
  const trail = [["Home", "/"], ["Services", "/services/"]];
  return { path: "/services/", title: "HR Implementation, Payroll Consulting, Migration, Training and Support | AiHxM", description: "Professional services around AiHxM: HRMS and payroll implementation, data migration, HR and payroll consulting, integration, training and support.",
    body: `<section class="phero t-plum v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap narrow">${breadcrumbs(trail)}<p class="eyebrow">Services</p><h1>A platform, supported by people who help you use it</h1><p class="lead">${esc(servicesIntro)}</p></div></section>${section({ wide: true, eyebrow: "Product and services", title: "Two different things", intro: "The product is the software your team uses every day. Services are the project and advisory work around it. They are separate, so you can take the software with or without help.", body: hubCards(services, servicePath) })}${section({ cls: "alt", eyebrow: "How an engagement runs", title: "Discover, configure, migrate, train, launch, support", body: steps([["Discover", "We learn how your business works."], ["Configure", "Your setup is built."], ["Migrate", "Your data comes across."], ["Train", "Each group learns what it needs."], ["Launch", "You go live."], ["Support", "Help continues after launch."]], "Engagement stages") })}${ctaBand({ title: "Tell us what you need", text: "Describe your situation and we will suggest a sensible scope." })}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function servicePageFor(s) {
  const trail = [["Home", "/"], ["Services", "/services/"], [s.name, servicePath(s)]];
  return { path: servicePath(s), title: `${s.name} | AiHxM Services`, description: s.lede.slice(0, 158).replace(/\s+\S*$/, "") + ".",
    body: `<section class="phero t-plum v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap phero-grid"><div class="phero-copy">${breadcrumbs(trail)}<p class="eyebrow">Services · ${esc(s.name)}</p><h1>${esc(s.h1)}</h1><p class="lead">${esc(s.lede)}</p><div class="btn-row">${btn("/book-a-demo/?type=consultation", "Request a Consultation", "primary")}${btn("/services/", "All services", "ghost")}</div></div><div class="hero-visual solo"><div class="big-ico" aria-hidden="true">${icon(s.icon)}</div></div></div></section>
${section({ eyebrow: "What this covers", title: "Activities in this service", body: ticks(s.items) })}
${section({ cls: "alt", eyebrow: "How it runs", title: "Typical stages", body: steps(s.steps, "Service stages") })}
${s.slug === "support" ? supportTiersBlock() : ""}
${section({ eyebrow: "Related", title: "Related product areas", body: cardGrid(s.related) })}
${section({ cls: "alt", body: notice(`<strong>Scope and fees.</strong> ${esc(servicesIntro)}`) })}
${ctaBand({ title: "Talk to us about this service", text: "Tell us about your organisation and what you want to achieve." })}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function pakistanPageFor(p, A) {
  const hub = p.slug === "pakistan-hrms";
  const trail = hub ? [["Home", "/"], [p.name, p.path]] : [["Home", "/"], ["HRMS for Pakistan", "/pakistan-hrms/"], [p.name, p.path]];
  const shot = p.slug === "pakistan-payroll" ? A.shot("payroll") : hub ? A.shot("employees") : null;
  const body = `
<section class="phero t-plum v-a pk-hero"><div class="bg-grid" aria-hidden="true"></div><div class="wrap phero-grid"><div class="phero-copy">${breadcrumbs(trail)}<p class="eyebrow">Pakistan · ${esc(p.name)}</p><h1>${esc(p.h1)}</h1><p class="lead">${esc(p.lede)}</p><div class="btn-row">${demoCta("Book a Personalized Demo", "pakistan-payroll")}${p.module ? btn(`/platform/${p.module}/`, `${modules.find((m) => m.slug === p.module).name} module`, "ghost") : ""}</div></div>${shot ? `<div class="hero-visual">${frame({ ...shot, alt: "A demonstration-company screen from AiHxM", eager: true })}</div>` : `<div class="hero-visual solo"><div class="big-ico" aria-hidden="true">${icon(p.icon)}</div></div>`}</div></section>
${p.blocks.map((b, i) => section({ cls: i % 2 ? "alt" : "", eyebrow: "In the product", title: b.t, body: ticks(b.items) })).join("")}
${p.slug === "pakistan-payroll" ? section({ eyebrow: "Implementation", title: "Setting it up properly", body: `<p class="lead reveal">Payroll is where mistakes are expensive. See how a Pakistan payroll project runs, who provides which figures and how the parallel check works.</p><div class="btn-row reveal">${btn("/pakistan-hrms/payroll-implementation/", "Pakistan payroll implementation", "primary")}</div>` }) : ""}
${p.notes ? section({ cls: "alt", eyebrow: "Scope", title: "How AiHxM fits your process", body: p.notes.map((n) => notice(esc(n))).join("") }) : ""}
${section({ eyebrow: "Keep exploring", title: "More for Pakistan", body: cardGrid(p.cards) })}
${ctaBand({ title: "Run payroll the Pakistani way", interest: "pakistan-payroll" })}`;
  return { path: p.path, title: p.title, description: p.desc, body, jsonld: [breadcrumbLd(trail, site)] };
}
