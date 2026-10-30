// Writes the PRIVATE internal register docs/internal/AIHXM_PRODUCT_LAUNCH_READINESS.md from the same content files the public
// site is built from, so every advertised capability is listed. Never written into ./dist. Run: node scripts/readiness-doc.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modules, parseItem, services, pakistan } from "../src/content/catalog.mjs";
import { integrationGroups } from "../src/content/misc.mjs";
import { securityMatrix } from "../src/content/trust.mjs";
import { phases, supportTiers, planModules } from "../src/content/commercial.mjs";
import { pkWorkstreams } from "../src/content/pkimpl.mjs";
import { STATUS } from "../src/content/flags.mjs";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/internal/AIHXM_PRODUCT_LAUNCH_READINESS.md");
const today = "2026-10-30";

// ---- how an internal status reads in this register ----
const STATE = {
  available: { impl: "Implemented in code. Not yet proven with a pilot customer's real data.", work: "Pilot UAT; fix what it finds.", ready: "Ready, pending pilot UAT", gate: false },
  setup: { impl: "Implemented. Works only after the customer enters its own data, rates or rules.", work: "Setup guide, starter template, and an implementation checklist.", ready: "Ready after documented configuration", gate: false },
  integration: { impl: "Product side implemented. Needs an external device, provider or system.", work: "Integration specification, compatibility test with real devices or providers, setup guide.", ready: "Blocked until an integration is tested", gate: true },
  partial: { impl: "Partly built. Some behaviour is missing.", work: "Finish the missing behaviour (see module notes), then test.", ready: "Not ready: complete, or scope explicitly in the contract", gate: true },
  dev: { impl: "In development.", work: "Finish build and test.", ready: "Not ready", gate: true },
  upcoming: { impl: "Not built. On the roadmap and advertised as part of the product vision.", work: "Design, build, test, document.", ready: "Not ready: build before launch, or remove from the site", gate: true },
};

// ---- feature-specific known work (from the capability inventory, gap register and module notes) ----
const FEATURE_WORK = {
  "Payment Batches": "Ready-made bank file layouts for the banks customers use; decide on instant-payment scheme support; test files with each bank.",
  "Clearance Management": "Multi-step, multi-department clearance chains (today a checklist).",
  "Biometric Punch Intake": "Compatibility testing with the device vendors customers use; device setup guide.",
  "Device Punch Intake": "Compatibility testing with real devices; device-key rotation runbook.",
  "Pakistan Tax Slabs": "Accountant-reviewed starter figures for each tax year, plus the yearly update procedure. No rates may be hard-coded.",
  "EOBI": "Confirm wage-base handling with an accountant; yearly update procedure; no filing is built.",
  "Provincial Social Security": "Confirm schemes per province; yearly update procedure; no filing is built.",
  "Email Notifications": "Production mail provider, deliverability test, templates.",
};
// ---- module-level facts ----
const INTEG = {
  attendance: "Biometric / attendance devices (customer side); optional mail provider.", "shift-management": "None required. Attendance devices for punch data.",
  payroll: "Customer's bank file layout; accounting system for journal import; accountant for statutory settings.", "benefits-management": "Insurers or benefit providers (data exchange not built); payroll.",
  "expenses-travel": "Payroll; optional card or travel booking feeds (not built).", "business-travel": "Payroll; travel booking providers (not built).", announcements: "Mail provider; mobile push provider (not built).",
  "core-hr": "Customer identity provider for SSO and SCIM (optional).", "intelligent-hr": "A language-model or analytics provider (not selected); data-processing terms; evaluation set.",
  "reports-analytics": "None required.", "workforce-analytics": "None required.", "employee-self-service": "Mail and push providers for notifications.", "hr-help-desk": "Mail provider for replies.",
};
const SEC = {
  People: "Personal and identity data: field-level permissions, per-company encryption of sensitive fields, change audit, data-subject requests.",
  Time: "Location and time data: privacy of GPS punches, rotating device keys, correction audit trail.",
  Pay: "Highly sensitive pay data: step-up for sensitive actions, field encryption, immutability after finalise, role and scope checks, bank details masked.",
  Talent: "Review and candidate confidentiality: visibility rules, candidate data retention, anonymity where promised.",
  Experience: "Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.",
  Platform: "Workflow integrity (no skipped steps), document storage access control, e-sign receipts, configuration change audit.",
  Insight: "Reports and exports respect each viewer's data scope; export volume controls; no personal data leaves through dashboards.",
};
const slugName = (s) => (modules.find((m) => m.slug === s) || { name: s }).name;
const cell = (s) => String(s).replace(/\|/g, "/").replace(/\n/g, " ");

const rows = [];
const lines = [];
const L = (s = "") => lines.push(s);

L("# AIHXM Product Launch Readiness");
L();
L("**PRIVATE. INTERNAL PLANNING ONLY.** This file is not part of the website build, is never copied into `apps/site/dist`, and must not be published. The public site presents the intended product; this file records what is actually true.");
L();
L(`Generated ${today} by \`apps/site/scripts/readiness-doc.mjs\` from the same content files the website is built from, so a capability cannot be advertised without appearing here. Re-run it after any content change. Implementation statuses come from the \`|status\` markers in \`apps/site/src/content/*.mjs\` and from \`docs/marketing/capability-inventory.md\`.`);
L();
L("## How to read this register");
L();
L("- **Status values**: " + Object.entries(STATE).map(([k, v]) => `*${STATUS[k].label}* (${v.impl})`).join(" · "));
L("- Each module has a block with the fields that apply to every feature in it: intended functionality, required integrations, testing requirements, security considerations, acceptance criteria and dependencies. The table under it lists each advertised feature with its own implementation status, remaining work, acceptance criteria and launch readiness.");
L("- **Pre-launch gate**: before any customer is asked to buy, every row whose readiness starts with *Not ready* or *Blocked* must be completed, removed from the website, or explicitly scoped in the contract. The list is in the last section.");
L("- Nothing here has been proven with a paying customer. `Ready, pending pilot UAT` means built, not validated by an outside user.");
L();

let totals = {}, gate = [];
const global = { module: "" };
for (const m of modules) {
  const items = m.caps.flatMap((g) => g.items.map((i) => ({ g: g.t, ...parseItem(i) })));
  const counts = {};
  items.forEach((i) => (counts[i.status] = (counts[i.status] || 0) + 1));
  L(`## ${m.name}`);
  L();
  L(`- **Public page**: /platform/${m.slug}/  ·  **Group**: ${m.group}`);
  L(`- **Intended functionality**: ${m.lede}`);
  L(`- **Required integrations**: ${INTEG[m.slug] || "None required for the core module."}`);
  L(`- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; ${m.group === "Pay" ? "parallel run against the customer's current payroll with accountant sign-off" : "UAT with the customer's own scenarios"}.`);
  L(`- **Security considerations**: ${SEC[m.group]}`);
  L(`- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.`);
  L(`- **Dependencies**: ${(m.related || []).map(slugName).join(", ") || "none"}; company configuration (Configuration Center).`);
  L(`- **Status mix**: ${Object.keys(counts).map((k) => `${STATUS[k].label} ${counts[k]}`).join(", ")}`);
  if (m.note) L(`- **Known limitations (internal)**: ${m.note}`);
  L();
  L("| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |");
  L("| --- | --- | --- | --- | --- |");
  for (const i of items) {
    const st = STATE[i.status];
    totals[i.status] = (totals[i.status] || 0) + 1;
    const rem = FEATURE_WORK[i.name] || st.work;
    const acc = i.status === "upcoming" ? `${i.name} works end to end for a configured company, is permission-checked and audited, and is described accurately on the website.` : `A user in the intended role can use ${i.name} as the page describes, within their data scope, and the change is audited.`;
    L(`| ${cell(i.name)} | ${cell(st.impl)} | ${cell(rem)} | ${cell(acc)} | ${cell(st.ready)} |`);
    if (st.gate) gate.push([m.name, i.name, STATUS[i.status].label, rem]);
    rows.push(i);
  }
  L();
}

L("## Integrations page");
L();
L("| Connection | Implementation status | Remaining development | Launch readiness |");
L("| --- | --- | --- | --- |");
for (const g of integrationGroups) for (const [n, d, s] of g.items) { const st = STATE[s]; L(`| ${cell(g.t)}: ${cell(n)} | ${cell(st.impl)} | ${cell(FEATURE_WORK[n] || st.work)} | ${cell(st.ready)} |`); if (st.gate) gate.push(["Integrations", n, STATUS[s].label, st.work]); }
L();

L("## Pakistan payroll implementation service (public page /pakistan-hrms/payroll-implementation/)");
L();
L("| Workstream | Product status | Needs before launch |");
L("| --- | --- | --- |");
for (const w of pkWorkstreams) { const st = STATE[w.status] || { impl: "Service step (people, not software)", ready: "Needs a trained implementation team and an accountant partner" }; L(`| ${cell(w.name)} | ${cell(st.impl)} | ${cell(w.status === "service" ? "Staffed implementation team, runbook, parallel-test report template, accountant partner arrangement." : (FEATURE_WORK[w.name] || st.work))} |`); }
L();

L("## Services and implementation (public pages /services/*, /implementation/)");
L();
L("| Item | What is advertised | Needs before launch |");
L("| --- | --- | --- |");
for (const s of services) L(`| ${cell(s.name)} | ${cell(s.short)} | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |`);
for (const p of phases) L(`| Implementation phase: ${cell(p.name)} | ${cell(p.why)} | Checklist, deliverable templates and an owner for each phase. |`);
for (const t of supportTiers) L(`| Support tier: ${cell(t.name)} | ${cell(t.covers.join("; "))} | Approve channels, hours and response targets; staff a support desk; ticketing and escalation process. The site states none of these. |`);
L();

L("## Security and trust claims (public pages /security/, /trust/)");
L();
L("| Area | Public wording | Real state | Action before launch |");
L("| --- | --- | --- | --- |");
const SECREAL = {
  tenant: ["Implemented and tested (row-level security, cross-company test)", "Keep tests in CI; consider an independent penetration test."],
  dbaccess: ["Implemented", "Confirm no direct database credentials are shared with staff or clients."],
  authn: ["Implemented", "MFA enrolment policy for admin roles."],
  access: ["Implemented", "Review default role templates."],
  sso: ["Implemented; needs live testing against real identity providers", "Test with the providers customers use."],
  encrypt: ["Field encryption implemented; storage-level encryption depends on the hosting plan. Production backfill status of existing data UNCONFIRMED", "Confirm the encryption key is set and backed up outside the host; run backfill after a backup; confirm database disk encryption on the chosen plan."],
  audit: ["Implemented (append-only)", "Define retention."],
  api: ["Implemented", "None."],
  hardening: ["Implemented", "Re-run header and dependency checks before launch."],
  dsr: ["Implemented", "Document the internal procedure."],
  backup: ["NOT IN PLACE: the current database plan has no automated backups (a manual snapshot script exists)", "BLOCKER: move to a plan with backups and test a restore before any real payroll data is loaded. Then confirm the public wording."],
  dr: ["NOT DEFINED", "BLOCKER: write a recovery plan, set targets, test it. Only then keep or change the wording."],
  hosting: ["Cloud services in use; production plan is a free tier that sleeps when idle", "BLOCKER: move the API to a paid plan in a suitable region before customers."],
  location: ["Database hosted outside Pakistan (Sydney, per the earlier infrastructure review: reconfirm). No Pakistan-hosted option", "Decide a data-location policy; confirm with legal; prepare a dedicated-hosting offer if needed."],
  incident: ["NO PROCEDURE", "Write and rehearse an incident-response procedure and customer-notification terms."],
  disclosure: ["No programme; contact form only", "Add a security contact and handling process."],
  subproc: ["NO LIST", "Compile the list of service providers that process customer data (hosting, database, mail, storage)."],
  assurance: ["NONE HELD: no penetration test, no certification", "Decide whether to commission an independent test; the website must not claim any certification until one exists."],
};
for (const m of securityMatrix) { const r = SECREAL[m.id] || ["", ""]; L(`| ${cell(m.area)} | ${cell(m.what)} | ${cell(r[0])} | ${cell(r[1])} |`); if (/BLOCKER|NOT IN PLACE|NO PROCEDURE|NO LIST|NONE HELD|NOT DEFINED/.test(r[0] + r[1])) gate.push(["Security and trust", m.area, "Wording ahead of reality", r[1]]); }
L();

L("## Known gaps removed from public wording");
L();
L("These limitations used to be stated on the public pages. They are no longer shown there, so they are recorded here and must be closed or scoped before launch.");
L();
L("| Area | Gap | Close by |");
L("| --- | --- | --- |");
for (const g of [
  ["Performance", "No 360-degree feedback; reviews are self and manager assessments with calibration.", "Build, or keep the page wording to what exists."],
  ["Learning", "No certificate expiry tracking.", "Build."],
  ["Expenses", "Expense categories are free text; no per-category limits or mileage rules.", "Build category policy."],
  ["Offboarding", "Clearance is a checklist; no multi-step, multi-department chain.", "Build."],
  ["HR Help Desk", "No automatic escalation or full service-level rules; clocks and ageing only.", "Build."],
  ["Self-service", "No native app-store apps; Urdu is partial.", "Decide scope; finish Urdu."],
  ["Payroll", "No payroll register by department or cost centre; no scheduled or auto-prepared payroll run.", "Build."],
  ["Payroll reports", "No FBR upload, annual statement or challan layout; EOBI wage base needs confirmation.", "Decide scope with an accountant."],
  ["Banking", "No ready-made bank-specific layouts; only a company-defined generic layout.", "Build for target banks."],
  ["Notifications", "WhatsApp and push are recorded but not sent (no provider connected).", "Select a provider and build."],
  ["Configuration", "The form designer lays out the employee form; other forms only allow field settings.", "Extend or describe accurately."],
]) L(`| ${cell(g[0])} | ${cell(g[1])} | ${cell(g[2])} |`);
L();

L("## Other public claims to verify");
L();
L("| Page or claim | Real state | Action before launch |");
L("| --- | --- | --- |");
const OTHER = [
  ["About page: AI direction (assistants, AI search, workforce, recruitment, document and payroll intelligence, AI reporting, workflow assistance)", "None built. Only a keyword-rule HR assistant and rule-based data checks exist. The page labels all of it as direction, not as available features.", "Keep the Direction label and wording; do not state AI results or availability until built, tested and evaluated."],
  ["About page: Beyond HR (ERP, AI automation, AI agents, business SaaS, enterprise integrations)", "None built or scoped. Stated as ambition only.", "Keep as ambition. Do not name products, dates or customers."],
  ["About page: founder section", "Name, role and experience areas come from the owner's document. No dates, employers or projects are stated. Photo taken from the founder's own LinkedIn profile photo at the founder's request (612x612, cropped to 4:5 by the page); a monogram shows if the file is removed.", "Replace apps/site/src/assets/brand/founder.jpg with a higher-resolution studio portrait when available (current file is 612px wide, soft when shown large). Confirm the biography wording with the founder."],
  ["About page: 'Days of development, minutes of configuration'", "A tagline. The form designer and workflow configuration exist; no measured time saving exists.", "Do not publish measured figures until real timings are recorded."],
  ["About page: SAP mention", "Founder's professional history only, with a no-affiliation line.", "Keep the disclaimer; never add SAP logos or comparisons."],
  ["Pricing page, scope estimator", "No approved prices. The estimator shows a scope only. Price arithmetic is built and unit-tested but switched off.", "Approve prices, fill `approvedPrices` in `commercial.mjs`, set `pricingPublished`."],
  ["Support tiers", "Names and coverage are proposals. No channels, hours or response targets exist.", "Approve and staff them; fill the tier fields; set `supportApproved`."],
  ["Hosting options (standard / dedicated)", "Dedicated hosting has no offering, price or runbook.", "Define it or remove it."],
  ["Public playground", "A browser-only simulation on fictional data. No server, no storage. Tax bands are invented.", "Keep the sample-data labels; never use real figures."],
  ["Case studies", "None. The case-study architecture exists and publishes only entries with a recorded customer approval.", "Add entries only with written customer approval."],
  ["Company details, founder", "Not set. The site shows only what the environment variables supply.", "Set legal name, registration number, address, founder name and role."],
  ["Privacy Policy and Terms", "Templates; not reviewed by a lawyer.", "Legal review, then set the reviewed flags."],
  ["Urdu interface", "Switcher exists on main screens; many pages are English.", "Complete or describe accurately."],
  ["Mobile app", "Installable web app only; no store apps.", "Public wording already says installable on Android and iPhone; keep it so."],
  ["Intelligent HR page", "Forward-looking description. Only a rules-based keyword assistant and data checks exist; no AI or model is built.", "Build, or keep the page as a clearly future-facing vision; never state AI results."],
  ["Contact email", "Not set.", "Set a monitored address before launch."],
];
for (const o of OTHER) L(`| ${cell(o[0])} | ${cell(o[1])} | ${cell(o[2])} |`);
L();

L("## Totals");
L();
L("| Status | Capabilities |");
L("| --- | --- |");
for (const k of Object.keys(STATE)) L(`| ${STATUS[k].label} | ${totals[k] || 0} |`);
L(`| **All advertised module capabilities** | **${rows.length}** |`);
L();

L("## Pre-launch gate: claims versus reality");
L();
L("Before commercial launch, compare every public claim with production. Each row below is advertised (or implied) today but is not yet deliverable as described. For each: **build it, remove it from the website, or scope it explicitly in the contract** before a customer is asked to buy.");
L();
L("| Where | Item | Why it is a gate item | What closes it |");
L("| --- | --- | --- | --- |");
for (const g of gate) L(`| ${cell(g[0])} | ${cell(g[1])} | ${cell(g[2])} | ${cell(g[3])} |`);
L();
L(`${gate.length} gate items.`);
L();
L("## Review log");
L();
L("- 2026-10-30: first full register generated for the product-vision website (SITE2).");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(`Wrote ${out}: ${rows.length} capabilities, ${gate.length} gate items`);
