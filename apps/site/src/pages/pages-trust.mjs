// Trust, security, pricing structure, implementation, support, Pakistan payroll service and the public playground.
import { site } from "../site.config.mjs";
import { icon } from "../lib/icons.mjs";
import { esc, escBrand, btn, breadcrumbs, breadcrumbLd, section, ctaBand, notice, chip, steps, ticks, statusLegend, pairCards } from "../lib/ui.mjs";
import { modules, modulePath, moduleItems, parseItem } from "../content/catalog.mjs";
import { STATUS, STATUS_ORDER, flags } from "../content/flags.mjs";
import { integrationGroups } from "../content/misc.mjs";
import { securityMatrix, SEC_STATE, customerResponsibilities, verifyGuide, caseStudies, caseStudyTemplate, companyFacts } from "../content/trust.mjs";
import { priceModels, planModules, planNames, employeeBands, approvedPrices, hostingOptions, quoteWorkflow, phases, packages, supportTiers } from "../content/commercial.mjs";
import { pkWorkstreams, pkLimits } from "../content/pkimpl.mjs";

const hero = (trail, eyebrow, h1, lede, tone = "t-purple", extra = "") =>
  `<section class="phero ${tone} v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap narrow">${breadcrumbs(trail)}<p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(h1)}</h1><p class="lead">${esc(lede)}</p>${extra}</div></section>`;
const table = ({ caption, head, rows, cls = "" }) =>
  `<div class="tbl-wrap reveal" tabindex="0" role="region" aria-label="${esc(caption)}"><table class="tbl ${cls}${cls.includes("tbl-num") ? "" : " tbl-stack"}"><caption class="sr">${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${escBrand(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td data-label="${esc(head[i])}">${c}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
const secChip = (k) => `<span class="chip ${SEC_STATE[k].tone}">${SEC_STATE[k].label}</span>`;

// ---------- Trust Center ----------
export function trustCenter() {
  const trail = [["Home", "/"], ["Trust Center", "/trust/"]];
  const tiles = [
    ["/security/", "Security", "What protects your data, what you control and what is agreed per customer.", "shield"],
    ["/pricing/", "Pricing structure", "How a quote is built, what is priced separately, and the enterprise quotation steps.", "compensation"],
    ["/implementation/", "Implementation", "Eight phases, with what AiHxM does and what you do in each.", "config"],
    ["/services/support/", "Support tiers", "How support is organised, in tiers agreed in your contract.", "helpdesk"],
    ["/playground/", "Public playground", "Try the product flow on fictional data. Nothing is saved or sent.", "analytics"],
  ];
  const facts = companyFacts(site);
  return { path: "/trust/", title: "Trust Center | AiHxM", description: "What a careful buyer can check about AiHxM: security, pricing structure, implementation, support, the public playground and how to verify the product before buying.",
    body: `${hero(trail, "Trust Center", "Check us before you commit", "Software that holds your people and payroll data deserves a careful look. This page gathers how you can check AiHxM before you commit.", "t-plum")}
${section({ wide: true, eyebrow: "Where to look", title: "Everything a buyer asks about", body: `<div class="grid g3">${tiles.map(([h, t, d, i]) => `<a class="card tilt reveal" href="${h}"><span class="card-ico">${icon(i)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p><span class="more">Open ${icon("arrow")}</span></a>`).join("")}</div>` })}
${section({ cls: "alt", id: "verify", eyebrow: "A buyer's checklist", title: "How to check AiHxM before you buy", wide: true, body: table({ caption: "How to check AiHxM before buying", head: ["You may want to", "How we help"], rows: verifyGuide.map((v) => [esc(v.ask), esc(v.today)]) }) })}
${section({ eyebrow: "The company", title: "Who is behind AiHxM", body: `<dl class="facts reveal">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${site.founder.name ? `<div class="founder reveal"><h3>${esc(site.founder.name)}${site.founder.role ? `, ${esc(site.founder.role)}` : ""}</h3>${site.founder.bio ? `<p>${esc(site.founder.bio)}</p>` : ""}</div>` : ""}<p class="lead reveal">Company registration details are shared in writing as part of any quotation.</p>` })}
${section({ cls: "alt", eyebrow: "How we work", title: "Plain language, written terms", body: pairCards([["Plain descriptions", "We describe what a module does in the words your team uses."], ["Claims we can back", "We publish only what we can stand behind, and answer security questions in writing."], ["Terms in writing", "Quotations, hosting, data location and support are agreed in writing before work starts."]]) })}
${ctaBand({ title: "Have a question we have not answered?", text: "Ask about security, hosting, data or the product. We answer in writing and say plainly when the answer is not yet.", primary: "Ask a question", primaryHref: "/contact/", second: ["/playground/", "Try the playground"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- Security (matrix) ----------
export function securityPage() {
  const trail = [["Home", "/"], ["Security & Privacy", "/security/"]];
  const rows = securityMatrix.map((m) => [esc(m.area), secChip(m.state), `${esc(m.what)}${m.note ? `<span class="cell-note">${esc(m.note)}</span>` : ""}`]);
  return { path: "/security/", title: "Security and Privacy | AiHxM", description: "How AiHxM protects employee data: tenant isolation, MFA, encryption, audit trail, access control, SSO, backups, hosting and data location, area by area.",
    body: `${hero(trail, "Security and Privacy", "Employee information, protected and controlled", "How AiHxM protects employee data, area by area, and what is set by your company or agreed in your contract.", "t-plum")}
${section({ cls: "alt", id: "matrix", wide: true, eyebrow: "Security matrix", title: "Area by area", body: table({ caption: "Security matrix", head: ["Area", "How it is handled", "What exists"], rows, cls: "tbl-sec" }) + `<ul class="legend reveal" aria-label="What the labels mean"><li><span class="chip yes">In the product</span><span>A control built into AiHxM.</span></li><li><span class="chip setup">Set by your company</span><span>A control your administrators configure.</span></li><li><span class="chip tbc">Agreed per customer</span><span>An arrangement confirmed in writing for each customer.</span></li></ul>` })}
${section({ eyebrow: "Your side", title: "What stays your responsibility", intro: "A product can only protect what it controls. These stay with your company.", wide: true, body: pairCards(customerResponsibilities) })}
${section({ cls: "alt", eyebrow: "Procurement", title: "Sending us a security questionnaire", body: `<p class="lead reveal">Send your questionnaire with a demo or consultation request. We answer it in writing.</p><div class="btn-row reveal">${btn("/book-a-demo/?type=consultation&interest=security", "Send a security question", "primary")}${btn("/trust/", "Trust Center", "ghost")}${btn("/privacy/", "Privacy Policy", "ghost")}${btn("/terms/", "Terms of Service", "ghost")}</div>` })}
${ctaBand({ title: "Questions about security?", text: "Ask during a demo or send us a message.", second: ["/trust/", "Trust Center"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- Pricing ----------
export function pricingPage() {
  const trail = [["Home", "/"], ["Pricing", "/pricing/"]];
  const priceFor = (n) => (flags.pricingPublished && approvedPrices.plans[n]) ? `${approvedPrices.plans[n].currency} ${approvedPrices.plans[n].perEmployeeMonth} per employee per month` : "Quoted for your company";
  const tiers = planNames.map((n, i) => ({ n, mods: planModules.filter((m) => m.tier === i).map((m) => m.label) }));
  const blurbs = ["Small teams starting out", "Growing companies adding payroll and approvals", "Established companies with several locations", "Complex organisations"];
  const plans = tiers.map((t, i) => `<div class="plan reveal"><h3>${esc(t.n)}</h3><p class="plan-for">${esc(blurbs[i])}</p><ul>${i ? `<li>${icon("check")}<span>Everything in ${esc(tiers[i - 1].n)}</span></li>` : ""}${t.mods.map((m) => `<li>${icon("check")}<span>${esc(m)}</span></li>`).join("")}</ul><p class="plan-price">${esc(priceFor(t.n))}</p></div>`).join("");
  return { path: "/pricing/", title: "AiHxM Pricing | How a Quote Is Built", description: "How AiHxM pricing is structured: plan tiers, per-employee and module-based subscription, implementation and migration fees, hosting and support, and the quotation steps.",
    body: `${hero(trail, "Pricing", "Know how pricing works before you ask for a number", "Prices are quoted in writing for each company. Here is exactly what goes into a quote, so nothing arrives as a surprise.", "t-plum", `<div class="btn-row">${btn("/pricing/estimator/", "Estimate my scope", "primary")}${btn("/book-a-demo/?type=quote", "Request a quote", "ghost")}</div>`)}
${section({ wide: true, eyebrow: "Plan structure", title: "Starter, Growth, Business, Enterprise", intro: "Plans group modules from the smallest company's needs to the largest. The exact contents are agreed with you.", body: `<div class="grid g4 plans">${plans}</div>` })}
${section({ cls: "alt", wide: true, eyebrow: "What is priced", title: "Six things, priced separately", intro: "A quote itemises these so you can see each one.", body: table({ caption: "What a quote contains", head: ["Item", "How it is built"], rows: priceModels.map(([a, b]) => [esc(a), esc(b)]) }) })}
${section({ id: "implementation-fees", eyebrow: "Implementation and migration", title: "Why implementation costs what it costs", body: `<div class="two-up reveal"><div><h3>Implementation</h3><p>The work depends on how many locations, policies, workflows and roles you have, whether payroll is included, and how many people you need to train. A single-site company with simple rules is a smaller project than a multi-site company with several pay structures.</p>${ticks(["Number of employees and locations", "Modules and payroll scope", "Number of workflows and policies", "Integrations such as attendance devices", "Training groups"])}</div><div><h3>Data migration</h3><p>Migration is cost-driven by the state of your data more than its size. Clean spreadsheets import quickly; scattered or inconsistent records need cleaning and review first.</p>${ticks(["Where the data lives today", "How complete and consistent it is", "How many years of history you want to keep", "How many review rounds you need"])}</div></div>` })}
${section({ cls: "alt", eyebrow: "Hosting", title: "Hosting options", wide: true, body: `<div class="grid g3 reveal">${hostingOptions.map(([t, d, p]) => `<div class="plain"><h3>${esc(t)}</h3><p>${esc(d)}</p><p><strong>${esc(p)}</strong></p></div>`).join("")}</div>` })}
${section({ eyebrow: "Support", title: "Support options", body: `<p class="lead reveal">Support is offered in tiers. Their channels, hours and response targets are set in your agreement, not promised on a web page.</p><div class="btn-row reveal">${btn("/services/support/#tiers", "See the support tiers", "ghost")}</div>` })}
${section({ cls: "alt", id: "quote-steps", eyebrow: "Enterprise and larger companies", title: "How a quotation works", body: steps(quoteWorkflow, "Quotation steps") })}
${section({ body: notice("<strong>Prices are quoted in writing for each company.</strong> Use the scope estimator to describe your company, then request a quote.") })}
${ctaBand({ title: "Get a quote for your company", text: "Tell us your size and the modules you need, or build your scope first.", primary: "Request a quote", primaryHref: "/book-a-demo/?type=quote", second: ["/pricing/estimator/", "Estimate my scope"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- Estimator ----------
export function estimatorPage(A) {
  const trail = [["Home", "/"], ["Pricing", "/pricing/"], ["Scope estimator", "/pricing/estimator/"]];
  const cfg = {
    published: Boolean(flags.pricingPublished),
    planNames, planModules, bands: employeeBands.map(([v, l, w]) => [v, l, w]),
    packages: packages.map((p) => ({ name: p.name, phases: p.phases })), phases: phases.map((p) => [p.key, p.name]),
    tiers: supportTiers.map((t) => ({ key: t.key, name: t.name })), prices: approvedPrices,
  };
  const j = esc(JSON.stringify(cfg));
  const mods = planModules.map((m) => `<label><input type="checkbox" name="mod" value="${m.key}"${m.tier === 0 ? " checked" : ""}><span>${esc(m.label)}</span></label>`).join("");
  return { path: "/pricing/estimator/", title: "Scope Estimator | AiHxM Pricing", description: "Build your AiHxM scope: employees, modules, locations, migration, implementation and support. See the plan structure that fits and send the scope with a quote request.",
    scripts: [A.estimatorJs],
    body: `${hero(trail, "Scope estimator", "Describe your company, get a scope you can send", "This builds the shape of your project, not a price. Approved prices are not published, so the result is a plan structure and a scope you can attach to a quote request.", "t-plum")}
<section class="section"><div class="wrap two-col form-col"><div class="form-card"><h2 id="est-title">Your company</h2>
<form id="estimator" class="lead-form" novalidate data-config="${j}">
<div class="row2"><div class="field"><label for="e-emp">Number of employees</label><select id="e-emp" name="emp"></select></div>
<div class="field"><label for="e-loc">Number of locations</label><input id="e-loc" name="loc" type="number" min="1" max="500" value="1" inputmode="numeric"></div></div>
<fieldset class="field"><legend>Modules you want</legend><div class="checks">${mods}</div></fieldset>
<div class="row2"><div class="field"><label for="e-pack">Implementation help</label><select id="e-pack" name="pack"><option value="">I will set it up myself</option>${packages.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("")}</select></div>
<div class="field"><label for="e-mig">Where is your employee data today?</label><select id="e-mig" name="mig"><option value="none">Nothing to migrate</option><option value="sheet">Spreadsheets</option><option value="system">Another HR or payroll system</option></select></div></div>
<div class="row2"><div class="field"><label for="e-sup">Support tier</label><select id="e-sup" name="sup"><option value="">Not decided</option>${supportTiers.map((t) => `<option value="${t.key}">${esc(t.name)}</option>`).join("")}</select></div>
<div class="field"><label for="e-par">Parallel payroll test</label><select id="e-par" name="par"><option value="auto">As recommended</option><option value="yes">Yes</option><option value="no">No</option></select></div></div>
</form></div>
<div class="form-aside"><h2>Your scope</h2><div id="est-out" class="est-out" role="status" aria-live="polite"><noscript><p>The estimator needs JavaScript. You can still <a href="/book-a-demo/?type=quote">request a quote</a> and describe your company.</p></noscript></div></div></div></section>
${section({ cls: "alt", body: notice("<strong>This is a scope, not a price.</strong> The result does not change what we will quote. The scope size is an indication of how much work is involved, and the real quotation follows a conversation with you. Nothing you enter here is sent anywhere until you choose to request a quote.") })}
${ctaBand({ title: "Want a written quote?", text: "Send your scope with a request and we will reply with questions or a quotation.", primary: "Request a quote", primaryHref: "/book-a-demo/?type=quote", second: ["/pricing/", "How pricing works"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- Implementation ----------
export function implementationPage() {
  const trail = [["Home", "/"], ["Services", "/services/"], ["Implementation", "/implementation/"]];
  const rows = phases.map((p, i) => [`<span class="ph-n">${i + 1}</span> ${esc(p.name)}<span class="cell-note">${esc(p.why)}</span>`, ticks(p.ours), ticks(p.yours), ticks(p.out)]);
  const cmp = table({ caption: "Implementation phases with responsibilities and deliverables", head: ["Phase", "AiHxM does", "You provide", "You receive"], rows, cls: "tbl-phases" });
  const pk = packages.map((p) => `<div class="plain reveal"><h3>${esc(p.name)}</h3><p>${esc(p.for)}</p><p class="plan-for">${p.phases.map((k) => esc(phases.find((x) => x.key === k).name)).join(", ")}</p></div>`).join("");
  return { path: "/implementation/", title: "Implementation | Eight Phases From Discovery to Support | AiHxM", description: "How an AiHxM implementation runs: discovery, HR configuration, employee migration, payroll setup, parallel testing, training, go-live and support, with responsibilities for each side.",
    body: `${hero(trail, "Implementation", "A project you can see the end of", "Eight phases, each with what we do, what we need from you and what you get. Timelines are set in a project plan with you, because they depend on your scope and how quickly your team can answer.", "t-indigo")}
${section({ wide: true, eyebrow: "The phases", title: "Discovery to post-launch support", body: steps(phases.map((p) => [p.name, p.why]), "Implementation phases") })}
${section({ cls: "alt", wide: true, id: "responsibilities", eyebrow: "Who does what", title: "Responsibilities and deliverables, phase by phase", body: cmp })}
${section({ wide: true, eyebrow: "Packages", title: "Choose the phases you need", intro: "Three common combinations. A package is a grouping of phases, and its scope and fee are agreed with you.", body: `<div class="grid g3">${pk}</div>` })}
${section({ cls: "alt", body: notice("<strong>Dates and fees are set in your written scope.</strong> Payroll go-live waits for your written approval after the parallel test.") + `<div class="btn-row reveal">${btn("/pakistan-hrms/payroll-implementation/", "Pakistan payroll implementation", "ghost")}${btn("/services/support/#tiers", "Support after go-live", "ghost")}${btn("/pricing/estimator/", "Estimate my scope", "ghost")}</div>` })}
${ctaBand({ title: "Plan your implementation with us", text: "Tell us about your company and we will suggest which phases you need.", primary: "Request a consultation", primaryHref: "/book-a-demo/?type=consultation&interest=implementation", second: ["/services/", "All services"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// Support tiers block used on the Support service page.
export function supportTiersBlock() {
  const cell = (v, what) => (v ? esc(v) : `<span class="muted">Defined in your agreement</span>`);
  const rows = supportTiers.map((t) => [esc(t.name), ticks(t.covers), cell(t.channels), cell(t.hours), cell(t.response)]);
  return section({ id: "tiers", cls: "alt", wide: true, eyebrow: "Support tiers", title: "Standard, Priority, Dedicated", intro: "What each tier covers. Channels, hours and response targets are set out in your agreement.", body: table({ caption: "Support tiers", head: ["Tier", "What it is meant to cover", "Channels", "Hours", "Response target"], rows, cls: "tbl-tiers" }) + notice("Support channels, hours and response targets are defined in your agreement.") });
}

// ---------- Pakistan payroll implementation ----------
export function pkImplementationPage(A) {
  const trail = [["Home", "/"], ["HRMS for Pakistan", "/pakistan-hrms/"], ["Payroll implementation", "/pakistan-hrms/payroll-implementation/"]];
  const lab = (s) => (s === "service" ? `<span class="chip setup">Service step</span>` : chip(s));
  const rows = pkWorkstreams.map((w) => [`${esc(w.name)}<span class="cell-note">${lab(w.status)}</span>`, esc(w.ours), esc(w.you), w.acct ? esc(w.acct) : "—"]);
  return { path: "/pakistan-hrms/payroll-implementation/", title: "Pakistan Payroll Implementation | Setup, Parallel Run | AiHxM", description: "How AiHxM sets up Pakistan payroll: tax year, salary structures, tax and EOBI settings from your accountant, provincial contributions, bank file, parallel testing and annual review.",
    body: `${hero(trail, "Pakistan payroll implementation", "Payroll set up for Pakistan, checked before you rely on it", "We configure the system; your accountant confirms the rules. Every rate and slab comes from you, and a parallel run proves the result before your first live month.", "t-plum", `<div class="btn-row">${btn("/book-a-demo/?type=consultation&interest=pakistan-payroll", "Request a consultation", "primary")}${btn("/implementation/", "How implementation works", "ghost")}</div>`)}
${section({ wide: true, eyebrow: "Nine workstreams", title: "From tax year to annual review", body: steps(pkWorkstreams.map((w) => [w.name, w.ours]), "Pakistan payroll workstreams") })}
${section({ cls: "alt", wide: true, id: "responsibilities", eyebrow: "Who does what", title: "AiHxM, your company and your accountant", intro: "Three parties, three jobs. The accountant column is where statutory accuracy is decided.", body: table({ caption: "Responsibilities for Pakistan payroll implementation", head: ["Workstream", "AiHxM", "Your company", "Your accountant"], rows, cls: "tbl-phases" }) })}
${section({ eyebrow: "Honest limits", title: "What this service does not do", body: pkLimits.map((n) => notice(esc(n))).join("") })}
${section({ cls: "alt", eyebrow: "Related", title: "Where to read more", body: `<div class="btn-row reveal">${btn("/pakistan-hrms/payroll/", "Pakistan payroll in the product", "ghost")}${btn("/platform/payroll/", "Payroll module", "ghost")}${btn("/services/payroll-implementation/", "Payroll implementation service", "ghost")}</div>` })}
${ctaBand({ title: "Run Pakistan payroll with a proper check", interest: "pakistan-payroll", primary: "Request a consultation", primaryHref: "/book-a-demo/?type=consultation&interest=pakistan-payroll", second: ["/pricing/estimator/", "Estimate my scope"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- Playground ----------
export function playgroundPage(A) {
  const trail = [["Home", "/"], ["Trust Center", "/trust/"], ["Playground", "/playground/"]];
  return { path: "/playground/", title: "Product Playground | Try AiHxM on Sample Data", description: "Try a leave request, manager approval, payroll calculation, payslip and analytics on fictional sample data in your browser. Nothing is saved or sent.",
    scripts: [A.playgroundJs],
    body: `${hero(trail, "Public playground", "Try the flow on fictional data", "Request leave, approve it as the manager, watch payroll change, and open the payslip. Everything runs in your browser on made-up people. Nothing is saved or sent, and no real company data is ever used.", "t-teal")}
<section class="section"><div class="wrap wide"><div id="playground" class="pg" aria-label="Product playground"><noscript><p>The playground needs JavaScript. To see the same flow, <a href="/book-a-demo/">book a demo</a>.</p></noscript></div></div></section>
${section({ cls: "alt", body: notice("<strong>Sample data only.</strong> The people, salaries and tax bands in the playground are invented for demonstration. The tax bands are <strong>not</strong> Pakistan's rates. In a real company, your accountant supplies the figures and you enter them as settings.", "warn") + `<p class="fine reveal">The playground makes no network request and keeps nothing after you leave the page.</p>` })}
${ctaBand({ title: "Want this on your own setup?", text: "A demo uses your own scenarios, not sample ones.", second: ["/trust/", "Trust Center"] })}`,
    jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- Case studies (architecture only: nothing is shown until a customer has approved a story) ----------
export const publishedCaseStudies = () => (flags.caseStudies ? caseStudies.filter((c) => c.approval && c.approval.by && c.approval.on) : []);
export function caseStudiesIndex() {
  const list = publishedCaseStudies();
  const trail = [["Home", "/"], ["Resources", "/resources/"], ["Case studies", "/resources/case-studies/"]];
  return { path: "/resources/case-studies/", title: "Customer Case Studies | AiHxM", description: "Stories from AiHxM customers, published with their approval and in their own measures.",
    body: `${hero(trail, "Case studies", "Customer stories, with their approval", "Each story names who approved it and what they allowed us to say.")}${section({ wide: true, body: `<div class="grid g3">${list.map((c) => `<a class="card tilt reveal" href="/resources/case-studies/${esc(c.slug)}/"><h3>${esc(c.company)}</h3><p>${esc(c.summary)}</p><span class="more">Read ${icon("arrow")}</span></a>`).join("")}</div>` })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}
export function caseStudyPage(c) {
  const trail = [["Home", "/"], ["Case studies", "/resources/case-studies/"], [c.company, `/resources/case-studies/${c.slug}/`]];
  return { path: `/resources/case-studies/${c.slug}/`, title: `${c.company} Case Study | AiHxM`, description: c.summary.slice(0, 158),
    body: `${hero(trail, `Case study · ${c.industry}`, c.company, c.summary)}${section({ title: "The situation", body: `<p class="lead">${esc(c.challenge)}</p>` })}${section({ cls: "alt", title: "What was set up", body: `<p class="lead">${esc(c.approach)}</p>` })}${section({ title: "What changed", body: `<p class="lead">${esc(c.outcome)}</p>${c.metrics && c.metrics.length ? ticks(c.metrics.map(([a, b]) => `${a}: ${b}`)) : ""}` })}${section({ cls: "alt", body: notice(`Published with the approval of ${esc(c.approval.by)} on ${esc(c.approval.on)}. Scope of approval: ${esc(c.approval.scope)}.`) })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}
