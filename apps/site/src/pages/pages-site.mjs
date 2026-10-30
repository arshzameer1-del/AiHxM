// Resources, conversion, trust and legal pages.
import { site } from "../site.config.mjs";
import { icon } from "../lib/icons.mjs";
import { esc, btn, breadcrumbs, breadcrumbLd, faqBlock, faqLd, cardGrid, pairCards, ticks, section, ctaBand, notice, chip, steps } from "../lib/ui.mjs";
import { articles, categories, categoryName, articlePath, categoryPath, modules } from "../content/catalog.mjs";
import { sources } from "../content/articles.mjs";
import { faqs, integrationGroups, pricingPlans, pricingFactors, securityItems, securityNotAClaim, industriesList } from "../content/misc.mjs";
import { flags } from "../content/flags.mjs";
import { resolve } from "../content/catalog.mjs";

const crumbs = (t) => t;
const hero = (trail, eyebrow, h1, lede, tone = "t-purple") =>
  `<section class="phero ${tone} v-a"><div class="bg-grid" aria-hidden="true"></div><div class="wrap narrow">${breadcrumbs(trail)}<p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(h1)}</h1><p class="lead">${esc(lede)}</p></div></section>`;

// ---------- resources ----------
const words = (a) => a.body.flatMap((b) => [...(b.p || []), ...(b.ul || []), ...(b.ol || [])]).join(" ").split(/\s+/).length;
const readTime = (a) => Math.max(2, Math.round(words(a) / 200));
const fmtDate = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const articleCard = (a) => `<a class="card tilt reveal art" href="${articlePath(a)}"><p class="art-cat">${esc(categoryName(a.cat))}</p><h3>${esc(a.title)}</h3><p>${esc(a.desc)}</p><span class="more">${readTime(a)} min read ${icon("arrow")}</span></a>`;

export function blogIndex() {
  const trail = [["Home", "/"], ["Resources", "/resources/"], ["Blog", "/resources/blog/"]];
  return { path: "/resources/blog/", title: "HR and Payroll Blog for Pakistan | AiHxM", description: "Practical articles on HR management, Pakistan payroll, salary tax, EOBI, attendance and HR automation.",
    body: `${hero(trail, "Blog", "Practical writing on HR, payroll and attendance", "Plain-language guides for HR and finance teams in Pakistan. Where an article touches statutory rules it points to the official source and never quotes rates that change.")}${section({ wide: true, srTitle: "All articles", body: `<div class="grid g3">${articles.map(articleCard).join("")}</div>` })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function articlePage(a) {
  const trail = [["Home", "/"], ["Resources", "/resources/"], ["Blog", "/resources/blog/"], [a.title, articlePath(a)]];
  const toc = a.body.map((b, i) => `<li><a href="#s${i}">${esc(b.h)}</a></li>`).join("");
  const text = a.body
    .map((b, i) => `<h2 id="s${i}">${esc(b.h)}</h2>${(b.p || []).map((p) => `<p>${esc(p)}</p>`).join("")}${b.ul ? `<ul>${b.ul.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${b.ol ? `<ol>${b.ol.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}`)
    .join("");
  const refs = (a.refs || []).length
    ? `<aside class="refs"><h2>Sources to check</h2><p>Figures and rules change. Confirm the current position with these official sources before acting.</p><ul>${a.refs.map((k) => `<li><a href="${sources[k][1]}" rel="noopener">${esc(sources[k][0])}</a></li>`).join("")}</ul></aside>`
    : "";
  const url = site.url + articlePath(a);
  const rel = a.related.map((s) => articles.find((x) => x.slug === s)).filter(Boolean);
  const share = `<ul class="share" aria-label="Share this article"><li><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" rel="noopener">LinkedIn</a></li><li><a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(a.title)}" rel="noopener">X</a></li><li><a href="mailto:?subject=${encodeURIComponent(a.title)}&body=${encodeURIComponent(url)}">Email</a></li></ul>`;
  return { path: articlePath(a), title: `${a.title} | AiHxM`, description: a.desc, ogType: "article",
    body: `<section class="phero t-purple v-a art-hero"><div class="bg-grid" aria-hidden="true"></div><div class="wrap narrow">${breadcrumbs(trail)}<p class="eyebrow"><a href="${categoryPath(a.cat)}">${esc(categoryName(a.cat))}</a></p><h1>${esc(a.title)}</h1><p class="lead">${esc(a.desc)}</p><p class="byline">By AiHxM Editorial Team · <time datetime="${site.publishedOn}">${fmtDate(site.publishedOn)}</time> · ${readTime(a)} min read</p></div></section>
<section class="section"><div class="wrap article"><aside class="toc" aria-label="Contents"><p>In this article</p><ol>${toc}</ol></aside><article class="prose">${text}${refs}<p class="related-in">Related product areas: ${(a.links || []).map((s) => `<a href="${resolve(s).href}">${esc(resolve(s).name)}</a>`).join(", ")}.</p>${share}</article></div></section>
${section({ cls: "alt", eyebrow: "Keep reading", title: "Related articles", wide: true, body: `<div class="grid g3">${rel.map(articleCard).join("")}</div>` })}${ctaBand({ title: "Put this into practice", text: "See how AiHxM handles it, with your own scenarios." })}`,
    jsonld: [breadcrumbLd(trail, site), { "@context": "https://schema.org", "@type": "Article", headline: a.title, description: a.desc, datePublished: site.publishedOn, dateModified: site.publishedOn, author: { "@type": "Organization", name: site.name }, publisher: { "@type": "Organization", name: site.name }, mainEntityOfPage: url }] };
}

const virtual = { "pakistan-payroll-guides": ["Pakistan Payroll & Compliance Guides", ["pakistan-payroll", "income-tax", "eobi"]] };
export function categoryPageFor(key) {
  const [name, keys] = virtual[key] || [categoryName(key), [key]];
  const list = articles.filter((a) => keys.includes(a.cat));
  const trail = [["Home", "/"], ["Resources", "/resources/"], [name, categoryPath(key)]];
  return { path: categoryPath(key), title: `${name} | AiHxM Resources`, description: `Articles, guides and practical explainers on ${name.toLowerCase()} for HR and finance teams in Pakistan, written by the AiHxM team.`,
    body: `${hero(trail, "Resources", name, `Articles filed under ${name}.`)}${section({ wide: true, srTitle: "Articles in this category", body: `<div class="grid g3">${list.map(articleCard).join("")}</div>` })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}
export const categoryKeys = () => [...new Set(articles.map((a) => a.cat))].concat(Object.keys(virtual));

export function knowledgeCenter() {
  const trail = [["Home", "/"], ["Resources", "/resources/"], ["HR Knowledge Center", "/resources/knowledge-center/"]];
  const groups = categories.map(([k, n]) => [k, n, articles.filter((a) => a.cat === k)]).filter(([, , l]) => l.length);
  return { path: "/resources/knowledge-center/", title: "HR Knowledge Center | Guides by Topic | AiHxM", description: "Browse AiHxM's HR and payroll guides by topic: HR management, Pakistan payroll, income tax, EOBI, attendance, employee experience and more.",
    body: `${hero(trail, "HR Knowledge Center", "Guides by topic", "Everything we have published, grouped the way HR teams look for it.")}${section({ wide: true, body: groups.map(([k, n, l]) => `<div class="kc-group reveal"><h2><a href="${categoryPath(k)}">${esc(n)}</a></h2><ul>${l.map((a) => `<li><a href="${articlePath(a)}">${esc(a.title)}</a></li>`).join("")}</ul></div>`).join("") })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function faqPage() {
  const trail = [["Home", "/"], ["Resources", "/resources/"], ["FAQs", "/resources/faqs/"]];
  return { path: "/resources/faqs/", title: "AiHxM FAQs | HRMS, Payroll, Attendance and Pricing Questions", description: "Answers about what AiHxM manages, Pakistan payroll and tax, EOBI, workflows, attendance devices, data isolation, import, demos, services and pricing.",
    body: `${hero(trail, "FAQs", "Questions we are asked most", "Answers reflect what the product does today and the approved business position.")}${section({ body: faqBlock(faqs) })}${ctaBand({ title: "Still have a question?", text: "Ask us in a demo, or send a message." })}`, jsonld: [breadcrumbLd(trail, site), faqLd(faqs)] };
}

export function resourcesHub() {
  const trail = [["Home", "/"], ["Resources", "/resources/"]];
  const tiles = [["/resources/blog/", "Blog", "Practical articles on HR, payroll and attendance.", "documents"], ["/resources/knowledge-center/", "HR Knowledge Center", "Guides grouped by topic.", "learning"], ["/resources/category/pakistan-payroll-guides/", "Pakistan Payroll & Compliance Guides", "Payroll, salary tax and EOBI in outline.", "payroll"], ["/resources/faqs/", "FAQs", "Answers to common questions.", "helpdesk"], ["/platform/", "Product Guides", "What each module does.", "config"]];
  return { path: "/resources/", title: "HR and Payroll Resources | AiHxM", description: "Articles, guides, FAQs and product guides for HR and finance teams in Pakistan.",
    body: `${hero(trail, "Resources", "Learn, compare notes, get answers", "Guides and articles from the AiHxM team, and the product guides that explain each module.")}${section({ wide: true, srTitle: "Where to start", body: `<div class="grid g3">${tiles.map(([h, t, d, i]) => `<a class="card tilt reveal" href="${h}"><span class="card-ico">${icon(i)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p><span class="more">Open ${icon("arrow")}</span></a>`).join("")}</div>` })}${section({ cls: "alt", eyebrow: "Latest", title: "Recent articles", wide: true, body: `<div class="grid g3">${articles.slice(0, 3).map(articleCard).join("")}</div>` })}${ctaBand()}`, jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- conversion ----------
const API_INTERESTS = [["core-hr", "Core HR"], ["payroll", "Payroll"], ["attendance", "Attendance"], ["leave", "Leave"], ["self-service", "Employee and manager self-service"], ["approvals", "Approvals and workflows"], ["reporting", "Reports and analytics"], ["pakistan-payroll", "Pakistan payroll"]];
const EXTRA_INTERESTS = ["Recruitment", "Performance and talent", "Learning", "Compensation planning", "Expenses and travel", "Onboarding and offboarding", "Configuration Center"];

export function leadForm(kind) {
  const emailNote = site.contactEmail ? ` or email <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>` : "";
  return `<form id="lead-form" class="lead-form" novalidate data-kind="${kind}" data-api="${esc(site.apiUrl)}" data-contact="${esc(site.contactEmail)}">
  <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <div class="row2"><div class="field" data-field="fullName"><label for="f-name">Full name <span aria-hidden="true">*</span></label><input id="f-name" name="fullName" autocomplete="name" required maxlength="120"><p class="err" id="e-fullName">Enter your full name.</p></div>
  <div class="field" data-field="workEmail"><label for="f-email">Business email <span aria-hidden="true">*</span></label><input id="f-email" name="workEmail" type="email" autocomplete="email" required maxlength="200"><p class="err" id="e-workEmail">Enter a valid work email.</p></div></div>
  <div class="row2"><div class="field" data-field="phone"><label for="f-phone">Phone number</label><input id="f-phone" name="phone" type="tel" autocomplete="tel" maxlength="25"><p class="err" id="e-phone">Use digits, spaces, + ( ) or -, 6 to 25 characters.</p></div>
  <div class="field" data-field="companyName"><label for="f-company">Company name <span aria-hidden="true">*</span></label><input id="f-company" name="companyName" autocomplete="organization" required maxlength="160"><p class="err" id="e-companyName">Enter your company name.</p></div></div>
  <div class="row2"><div class="field"><label for="f-industry">Industry</label><select id="f-industry" name="industry"><option value="">Select</option>${industriesList.map((i) => `<option>${esc(i)}</option>`).join("")}<option>Other</option></select></div>
  <div class="field"><label for="f-size">Number of employees</label><select id="f-size" name="employeeCount"><option value="">Select</option><option value="1-50">1 to 50</option><option value="51-200">51 to 200</option><option value="201-500">201 to 500</option><option value="501-1000">501 to 1,000</option><option value="1000+">More than 1,000</option></select></div></div>
  <fieldset class="field"><legend>Interested modules</legend><div class="checks">${API_INTERESTS.map(([v, l]) => `<label><input type="checkbox" name="interests" value="${v}"><span>${esc(l)}</span></label>`).join("")}${EXTRA_INTERESTS.map((l) => `<label><input type="checkbox" name="extra" value="${esc(l)}"><span>${esc(l)}</span></label>`).join("")}</div></fieldset>
  <fieldset class="field"><legend>Preferred contact method</legend><div class="checks inline"><label><input type="radio" name="method" value="Email" checked> Email</label><label><input type="radio" name="method" value="Phone call"> Phone call</label><label><input type="radio" name="method" value="WhatsApp"> WhatsApp</label></div></fieldset>
  <div class="field"><label for="f-msg">Additional requirements</label><textarea id="f-msg" name="message" rows="4" maxlength="1400"></textarea></div>
  <div class="field consent" data-field="consentPrivacy"><label><input type="checkbox" name="consentPrivacy" required><span>I have read the <a href="/privacy/" target="_blank" rel="noopener">Privacy Policy</a> and agree that AiHxM may use these details to respond to this request. <span aria-hidden="true">*</span></span></label><p class="err" id="e-consentPrivacy">You need to accept the privacy policy to send this request.</p></div>
  <div id="form-status" class="form-status" role="status" tabindex="-1" aria-live="polite"></div>
  <button class="btn btn-primary" id="form-submit" type="submit">${kind === "contact" ? "Send message" : kind === "consultation" ? "Request consultation" : "Request my demo"}</button>
  <p class="fine">Nothing is shown as sent until our server confirms it saved your request. If it fails you can try again${emailNote}.</p>
</form>
<div id="form-done" class="form-done" role="status" tabindex="-1" hidden><span class="done-ico">${icon("check")}</span><h2>Request received</h2><p>Thank you. We saved your request and will contact you by your preferred method. Your reference is <strong id="done-ref"></strong>.</p><p><a class="btn btn-ghost" href="/platform/">Explore the platform while you wait</a></p></div>`;
}

export function demoPage() {
  const trail = [["Home", "/"], ["Book a Demo", "/book-a-demo/"]];
  return { path: "/book-a-demo/", title: "Book a Personalized Demo | AiHxM", description: "Request a personalised AiHxM demo. Tell us about your business and we will walk through HR, payroll and attendance set up around your needs.",
    body: `${hero(trail, "Book a demo", "See AiHxM set up around your business", "Tell us a little about your company. We will contact you to arrange a walkthrough using your own scenarios.", "t-magenta")}<section class="section"><div class="wrap two-col form-col"><div class="form-card"><h2 id="form-title">Your details</h2>${leadForm("demo")}</div><div class="form-aside"><h2>What happens next</h2>${steps([["We read your request", "Your details go to the AiHxM team."], ["We contact you", "By your preferred method."], ["Your walkthrough", "Payroll, attendance and approvals with your scenarios."]], "What happens next")}<p class="fine">We use these details only to respond to you. See the <a href="/privacy/">Privacy Policy</a>.</p></div></div></section>`, jsonld: [breadcrumbLd(trail, site)] };
}

export function contactPage() {
  const trail = [["Home", "/"], ["Contact", "/contact/"]];
  const direct = [site.contactEmail && `<li><strong>Email</strong> <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a></li>`, site.contactPhone && `<li><strong>Phone</strong> <a href="tel:${esc(site.contactPhone.replace(/[^+\d]/g, ""))}">${esc(site.contactPhone)}</a></li>`, site.whatsapp && `<li><strong>WhatsApp</strong> <a href="https://wa.me/${site.whatsapp}" rel="noopener">Message us</a></li>`].filter(Boolean);
  return { path: "/contact/", title: "Contact AiHxM", description: "Contact the AiHxM team with a question, to request a consultation or to book a demo.",
    body: `${hero(trail, "Contact", "Talk to the AiHxM team", "Ask a question, request a consultation about implementation or services, or book a demo.", "t-indigo")}<section class="section"><div class="wrap two-col form-col"><div class="form-card"><h2 id="form-title">Send us a message</h2>${leadForm("contact")}</div><div class="form-aside"><h2>Other ways to reach us</h2>${direct.length ? `<ul class="contact-list">${direct.join("")}</ul>` : `<p>The form is the way to reach us for now. Direct contact details will appear here when they are confirmed.</p>`}<p>Looking for a walkthrough? <a href="/book-a-demo/">Book a demo</a>. Want advice on implementation? <a href="/book-a-demo/?type=consultation">Request a consultation</a>.</p></div></div></section>`, jsonld: [breadcrumbLd(trail, site)] };
}

// ---------- pricing, integrations, about, security, legal ----------
export function pricingPage() {
  const trail = [["Home", "/"], ["Pricing", "/pricing/"]];
  const plans = pricingPlans.map((p) => `<div class="plan reveal"><h3>${esc(p.name)}</h3><p class="plan-for">${esc(p.for)}</p><ul>${p.modules.map((m) => `<li>${icon("check")}<span>${esc(m)}</span></li>`).join("")}</ul><p class="plan-price">${flags.pricingPublished && p.price ? esc(p.price) : "Contact Us for a Personalized Quote."}</p>${btn("/book-a-demo/", "Request a quote", "ghost")}</div>`).join("");
  return { path: "/pricing/", title: "AiHxM Pricing | Plans and Personalized Quotes", description: "AiHxM plans are quoted for your company: Starter, Growth, Business and Enterprise, with per-employee, module-based and implementation options.",
    body: `${hero(trail, "Pricing", "Plans shaped around your company", "Four plan structures to start the conversation. Pricing is quoted for each company.", "t-plum")}${section({ wide: true, eyebrow: "Plan structure", title: "Starter, Growth, Business, Enterprise", intro: "These describe how modules are grouped. The exact contents of each plan are agreed with you.", body: `<div class="grid g4 plans">${plans}</div>` })}${section({ cls: "alt", eyebrow: "How a quote is built", title: "What affects the price", body: ticks(pricingFactors) })}${section({ body: notice("<strong>Contact Us for a Personalized Quote.</strong> AiHxM does not publish prices, and no free plan is offered unless we tell you so in writing.") })}${ctaBand({ title: "Get a quote for your company", text: "Tell us your size and the modules you need." })}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function integrationsPage() {
  const trail = [["Home", "/"], ["Integrations", "/integrations/"]];
  return { path: "/integrations/", title: "Integrations | Devices, Accounting, Identity and API | AiHxM", description: "The connections AiHxM supports today: device punch intake, accounting journal export, single sign-on, SCIM, webhooks and read-only API keys.",
    body: `${hero(trail, "Integrations", "Connect AiHxM to the systems around it", "Only connections that exist or are formally approved are listed, each with its real status. No third-party product is named because none is a certified partner integration.", "t-teal")}${section({ wide: true, body: integrationGroups.map((g) => `<div class="int-group reveal"><h2>${esc(g.t)}</h2><ul class="int-list">${g.items.filter((i) => i[2] !== "upcoming" || flags.showUpcoming).map(([n, d, s]) => `<li><div><strong>${esc(n)}</strong><span>${esc(d)}</span></div>${chip(s)}</li>`).join("")}</ul></div>`).join("") })}${section({ cls: "alt", body: notice("Need a connection that is not listed? <a href=\"/services/integration-services/\">Integration services</a> scopes it with you. Compatibility is never promised before it is built and tested.") })}${ctaBand({ title: "Tell us what you need to connect" })}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function aboutPage() {
  const trail = [["Home", "/"], ["About AIHXM", "/about/"]];
  const blocks = [["Who we are", "AiHxM is a human capital management platform for Pakistani businesses, built to bring the whole employee lifecycle into one connected system."], ["Why AiHxM exists", "HR in many growing companies runs on spreadsheets, chat messages and one person's memory. Records disagree, approvals get lost and payroll depends on heroics. We built AiHxM so the same fact is entered once and used everywhere."], ["Our approach", "Start from the way a business works, then configure the software around it. Your team changes forms, workflows, policies and payslips without waiting for a developer."], ["Our technology philosophy", "Be explicit and explainable. A payslip stores its calculation. An approval stores who decided. A feature that is not finished says so. Nothing is switched on or applied to your people without a deliberate action."], ["Our commitment to businesses", "Keep each company's data private, keep the rules that change each year in the customer's hands, and describe the product honestly."]];
  return { path: "/about/", title: "About AIHXM | Intelligent Human Capital Management", description: "Who AiHxM is, why it exists and how it approaches HR technology for Pakistani businesses.",
    body: `${hero(trail, "About AIHXM", "Complex HR, brought into one connected platform", "We believe HR software should fit the business, not the other way round.", "t-purple")}${blocks.map(([t, d], i) => section({ id: t === "Why AiHxM exists" ? "why" : t === "Our approach" ? "vision" : "", cls: i % 2 ? "alt" : "", eyebrow: "", title: t, body: `<p class="lead reveal">${esc(d)}</p>` })).join("")}${section({ eyebrow: "Our vision", id: "vision-statement", title: "Where we are heading", body: `<p class="lead reveal">A platform where a Pakistani business of any size can run its people operations with the clarity of a large enterprise, and stay in control of its own rules.</p>` })}${section({ cls: "alt", eyebrow: "Contact", title: "Say hello", body: `<div class="btn-row">${btn("/contact/", "Contact the team", "primary")}${btn("/book-a-demo/", "Book a Demo", "ghost")}</div>` })}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function securityPage() {
  const trail = [["Home", "/"], ["Security & Privacy", "/security/"]];
  return { path: "/security/", title: "Security and Privacy | AiHxM", description: "How AiHxM protects employee data: tenant isolation, MFA, role-based access, audit logging, SSO, SCIM, read-only API keys and data-subject requests.",
    body: `${hero(trail, "Security and Privacy", "Employee information, protected and controlled", "These are the protections that exist in the product today. We list only what is real.", "t-plum")}${section({ wide: true, eyebrow: "Verified capabilities", title: "What protects your data", body: `<div class="grid g3 sec-list">${securityItems.map(([t, d]) => `<div class="plain reveal"><span class="sec-ico dark-ico">${icon("shield")}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</div>` })}${section({ cls: "alt", eyebrow: "What we do not claim", title: "Honest limits", body: notice(esc(securityNotAClaim), "warn") + `<p class="lead">If your procurement process needs evidence, ask us what we can provide. We will tell you plainly what exists.</p>` })}${section({ eyebrow: "Policies", title: "Privacy and terms", body: `<div class="btn-row">${btn("/privacy/", "Privacy Policy", "ghost")}${btn("/terms/", "Terms of Service", "ghost")}</div>` })}${ctaBand({ title: "Questions about security?", text: "Ask during a demo or send us a message." })}`, jsonld: [breadcrumbLd(trail, site)] };
}

export function privacyPage() {
  const trail = [["Home", "/"], ["Privacy Policy", "/privacy/"]];
  const way = site.contactEmail ? `email <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>` : `send a message through the <a href="/contact/">contact form</a> and say it is a privacy request`;
  return { path: "/privacy/", title: "Privacy Policy | AiHxM", description: "What the AiHxM website collects through its forms, why, who sees it and how to have it removed. The site sets no cookies and runs no trackers.",
    body: `${hero(trail, "Privacy Policy", "What this website collects, and why", "A plain-language description of what the website does today.", "t-indigo")}<section class="section"><div class="wrap narrow prose">${site.privacyReviewed ? "" : notice("<strong>Template notice.</strong> This is a plain-language template that has not been reviewed by a lawyer. Have it reviewed before launch.", "warn")}
<h2>Who we are</h2><p>This website is run by ${esc(site.legalName)}, the company behind the AiHxM platform. The product, where a company's employee data lives, is covered separately from this notice.</p>
<h2>What we collect</h2><p>Only what you type into our forms: your name, work email, company name and message. Optional fields are phone number, industry, company size, modules of interest and preferred contact method. We also store the page the form was sent from and a one-way hash of your network address, used to limit abuse.</p>
<h2>Why we collect it</h2><p>To respond to your request about a demo, a consultation or a question.</p>
<h2>Who sees it</h2><p>Our team, through a protected request list on the hosted infrastructure that runs AiHxM.</p>
<h2>Cookies and tracking</h2><p>This website does not set cookies and does not run analytics or advertising trackers. Fonts and images are served from the site itself.</p>
<h2>How long we keep it</h2><p>For as long as needed to follow up on your request. We delete a request when you ask.</p>
<h2>Your choices</h2><p>You can ask what we hold about you, ask us to correct it or delete it. To do that, ${way}.</p></div></section>`, jsonld: [breadcrumbLd(trail, site)] };
}

export function termsPage() {
  const trail = [["Home", "/"], ["Terms of Service", "/terms/"]];
  return { path: "/terms/", title: "Terms of Service | AiHxM", description: "Terms for using the AiHxM website. Terms for the platform itself are agreed in the customer agreement.",
    body: `${hero(trail, "Terms of Service", "Terms for using this website", "How you may use this website. The platform is governed by the customer agreement.", "t-indigo")}<section class="section"><div class="wrap narrow prose">${site.termsReviewed ? "" : notice("<strong>Template notice.</strong> These terms are a template that has not been reviewed by a lawyer. Replace and review them before launch.", "warn")}
<h2>Using this website</h2><p>The website describes the AiHxM platform and lets you request a demo or contact us. Use it lawfully and do not try to disrupt it.</p>
<h2>Information on the site</h2><p>We aim to keep descriptions accurate. Capabilities are labelled with their status. A description does not promise a feature, a price or a service level; those are set out in a written agreement.</p>
<h2>Statutory information</h2><p>Articles that mention tax, EOBI or other rules are general information, not legal or tax advice. Confirm current rules with your adviser or the official source.</p>
<h2>The platform</h2><p>Use of the AiHxM platform is covered by the agreement between your company and ${esc(site.legalName)}.</p>
<h2>Changes</h2><p>We may update these terms and this website.</p></div></section>`, jsonld: [breadcrumbLd(trail, site)] };
}

export const notFound = () => ({ path: "/404.html", title: "Page not found", description: "This page does not exist. Try the platform overview or book a demo.", noindex: true,
  body: `<section class="section"><div class="wrap narrow"><h1>That page is not here</h1><p class="lead">The link may be old or mistyped. Try the platform overview, or tell us what you were looking for.</p><div class="btn-row">${btn("/", "Go to the home page", "primary")}${btn("/platform/", "Explore the platform", "ghost")}${btn("/book-a-demo/", "Book a Demo", "ghost")}</div></div></section>` });
