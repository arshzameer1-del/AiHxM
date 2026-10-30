import { site } from "../site.config.mjs";
import { icon } from "../lib/icons.mjs";
import { esc, btn, frame, mock, ctaBand, section, ticks } from "../lib/ui.mjs";
import { modules, moduleGroups, modulePath, resolve } from "../content/catalog.mjs";
import { lifecycle } from "../content/misc.mjs";

const trust = [
  ["manage", "One Connected HR Platform", "One employee record feeds every module."],
  ["hire", "Complete Employee Lifecycle", "From requisition to exit."],
  ["workflow", "Configurable Workflows", "15 templates your team can edit."],
  ["pay", "Pakistan-Focused Payroll", "July-to-June tax year, EOBI, PKR."],
  ["organization", "Private Company Workspaces", "Every company's data kept apart."],
];

const payrollSteps = [
  ["Prepare", "Create the month's run and check inputs from attendance, leave, loans and reimbursements."],
  ["Calculate", "Pay, salary tax, EOBI and other deductions are worked out for every employee."],
  ["Review", "Variance checks flag large changes against last month before anyone approves."],
  ["Approve", "The approval workflow records who signed off and when."],
  ["Finalise", "Payslips are fixed, and corrections are made by reversal, never by editing history."],
  ["Pay and post", "Create the payment batch, reconcile it and export the accounting journal."],
];

const configTiles = [
  ["Forms", "Arrange the employee form into sections.", "core-hr"],
  ["Fields", "Add your own fields without code.", "config"],
  ["Workflows", "Start from 15 templates and edit the steps.", "workflow"],
  ["Approvals", "Name approvers and fallbacks.", "manager"],
  ["Leave rules", "Types, accrual, carry-forward, expiry.", "leave"],
  ["Attendance policies", "Shifts, overtime caps, pre-approval.", "attendance"],
  ["Roles", "Built-in and custom roles with data scope.", "organization"],
  ["Payslips", "Design the payslip employees receive.", "payroll"],
  ["Numbering", "Set the employee number pattern.", "documents"],
];

export default function home(A) {
  const hero = A.shot("home");
  const stage = `<div class="stage" data-parallax>
    <div class="orb o1" data-depth="18" aria-hidden="true"></div><div class="orb o2" data-depth="34" aria-hidden="true"></div><div class="orb o3" data-depth="10" aria-hidden="true"></div><div class="sphere" data-depth="26" aria-hidden="true"></div>
    <svg class="net" viewBox="0 0 600 420" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1" fill="none" opacity=".45"><path class="ia-draw" pathLength="1" d="M70 80L250 150L420 60M250 150L330 300L520 250M70 300L250 150"/></g><g fill="currentColor"><circle cx="70" cy="80" r="3"/><circle cx="250" cy="150" r="4"/><circle cx="420" cy="60" r="3"/><circle cx="330" cy="300" r="3"/><circle cx="520" cy="250" r="3"/><circle cx="70" cy="300" r="3"/></g></svg>
    <div class="stage-main" data-depth="6">${frame({ ...hero, alt: "The AiHxM home page for HR, showing today's attendance, leave balance and pending requests, drawn from a demonstration company", eager: true })}</div>
    <div class="glass g-a float f1" data-depth="22"><span class="g-ico">${icon("payroll")}</span><div><strong>Payroll run</strong><small>Step 4 of 6 · Approved</small></div></div>
    <div class="glass g-b float f2" data-depth="30"><span class="g-ico">${icon("leave")}</span><div><strong>Leave approved</strong><small>3 days · Sample data</small></div></div>
    <div class="glass g-c float f3" data-depth="16"><span class="g-ico">${icon("attendance")}</span><div><strong>184 of 190</strong><small>clocked in today</small></div></div>
    <div class="glass g-d float f4" data-depth="26"><span class="g-ico">${icon("core-hr")}</span><div><strong>2 documents</strong><small>expiring this month</small></div></div>
  </div>`;

  const lifeBtns = lifecycle.map((s, i) => `<button type="button" class="life-btn${i === 0 ? " on" : ""}" role="tab" id="lt-${s.key}" aria-controls="lp-${s.key}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><span class="life-ico">${icon(s.key)}</span><span>${s.label}</span></button>`).join("");
  const lifePanels = lifecycle
    .map(
      (s, i) => `<div class="life-panel" role="tabpanel" id="lp-${s.key}" aria-labelledby="lt-${s.key}"${i ? " hidden" : ""}><h3>${s.label}</h3><p>${esc(s.text)}</p><div class="chips">${s.modules.map((m) => `<a class="pill" href="${resolve(m).href}">${esc(resolve(m).name)} ${icon("arrow")}</a>`).join("")}</div></div>`
    )
    .join("");

  const filters = ["All", ...moduleGroups].map((g, i) => `<button type="button" class="filter${i === 0 ? " on" : ""}" data-filter="${g}" aria-pressed="${i === 0}">${g}</button>`).join("");
  const cards = modules
    .map((m) => `<a class="card tilt mod" data-group="${m.group}" href="${modulePath(m)}"><span class="card-ico">${icon(m.icon)}</span><h3>${esc(m.name)}</h3><p>${esc(m.short)}</p><p class="benefit">${esc(m.benefit)}</p><span class="more">Explore ${icon("arrow")}</span></a>`)
    .join("");

  const payNav = payrollSteps.map(([t], i) => `<button type="button" class="pay-btn${i === 0 ? " on" : ""}" role="tab" id="pt-${i}" aria-controls="pp-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><b>${i + 1}</b>${t}</button>`).join("");
  const payPanels = payrollSteps.map(([t, d], i) => `<div class="pay-panel" role="tabpanel" id="pp-${i}" aria-labelledby="pt-${i}"${i ? " hidden" : ""}><h3>${t}</h3><p>${esc(d)}</p></div>`).join("");
  const pay = A.shot("payroll");

  const body = `
<section class="hero"><div class="bg-grid" aria-hidden="true"></div><div class="wrap hero-grid">
  <div class="hero-copy">
    <p class="eyebrow">Intelligent Human Capital Management</p>
    <h1>Your People. Your Processes. One Intelligent Platform.</h1>
    <p class="lead">Transform the way your business manages people, payroll and performance with an intelligent HR platform designed to simplify every stage of the employee journey.</p>
    <div class="btn-row">${btn("/book-a-demo/", "Book a Personalized Demo", "primary")}${btn("/platform/", "Explore the Platform", "ghost")}</div>
    <p class="hero-note">Built for Pakistani businesses. Private workspace for every company.</p>
  </div>
  ${stage}
</div></section>

<section class="trust"><div class="wrap"><ul class="trust-row">${trust.map(([i, t, d]) => `<li class="reveal"><span class="t-ico">${icon(i)}</span><div><strong>${esc(t)}</strong><small>${esc(d)}</small></div></li>`).join("")}</ul></div></section>

${section({ cls: "life", eyebrow: "The employee journey", title: "Hire. Onboard. Manage. Pay. Develop. Retain.", intro: "Every stage of an employee's time with you is covered, and each one hands its data to the next. Select a stage to see what it includes.", body: `<div class="life-wrap" data-tabs="life"><svg class="life-line" viewBox="0 0 600 6" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="3" x2="600" y2="3" stroke="currentColor" stroke-width="2" stroke-dasharray="4 6"/><line class="life-prog" x1="0" y1="3" x2="600" y2="3" stroke="currentColor" stroke-width="3"/></svg><div class="life-tabs" role="tablist" aria-label="Employee lifecycle stages">${lifeBtns}</div><div class="life-panels">${lifePanels}</div></div>` })}

${section({ cls: "alt", id: "products", eyebrow: "The platform", title: "Every part of HR, connected", intro: `${modules.length} product areas share one employee record. Choose a group to filter, or open any module.`, wide: true, body: `<div class="filters" role="group" aria-label="Filter modules">${filters}</div><div class="grid g4 mods" id="mods">${cards}</div>` })}

<section class="section dark pay" id="payroll"><div class="wrap wide"><div class="pay-grid">
  <div><p class="eyebrow">Payroll excellence</p><h2 class="reveal">Payroll you can review, explain and close with confidence</h2><p class="lead reveal">Six guided steps, variance checks before approval and a stored calculation on every payslip. Tax, statutory contributions, payslips and reports sit inside the same run.</p>
    <div class="pay-tabs" data-tabs="pay" role="tablist" aria-label="Payroll run steps">${payNav}</div><div class="pay-panels">${payPanels}</div>
    <div class="btn-row">${btn("/platform/payroll/", "See Payroll", "light")}${btn("/pakistan-hrms/payroll/", "Pakistan payroll", "outline-light")}</div></div>
  <div class="pay-visual reveal">${frame({ ...pay, alt: "The AiHxM payroll workspace for a demonstration company, showing the run and its steps" })}<div class="glass g-e float f2"><span class="g-ico">${icon("analytics")}</span><div><strong>3 variance flags</strong><small>to review · Sample data</small></div></div></div>
</div></div></section>

${section({ id: "configure", eyebrow: "Configuration without complexity", title: "Configure AiHxM around the way your business works", intro: "Your own team changes forms, fields, workflows, approvals, rules, roles, payslips and numbering from one place. Changes apply to your company only.", wide: true,
  body: `<div class="cfg-grid"><div class="grid g3 cfg-tiles">${configTiles.map(([t, d, i]) => `<div class="tile reveal"><span class="card-ico sm">${icon(i)}</span><h3>${t}</h3><p>${d}</p></div>`).join("")}</div><div class="cfg-shot reveal">${frame({ ...A.shot("configuration"), alt: "The AiHxM Configuration Center showing the areas a company configures for itself" })}</div></div><div class="btn-row">${btn("/platform/configuration-center/", "Explore the Configuration Center", "ghost")}</div>` })}

${section({ cls: "alt", id: "experience", eyebrow: "Employee experience", title: "Self-service for employees, speed for managers", intro: "Employees see their own payslips, leave, attendance and requests on a home page built for their role, on the web or installed on a phone. Managers decide faster with the balance and team calendar in view.", wide: true,
  body: `<div class="exp-grid"><div class="reveal">${frame({ ...A.shot("leave"), alt: "The AiHxM leave page for a demonstration company, showing balances and the team calendar" })}</div><div class="exp-cards">${mock({ title: "My home", rows: [["Leave balance", "12.5 days"], ["Latest payslip", "Available", "ok"], ["Today", "Clocked in 9:04 AM"], ["My requests", "1 pending", "info"]], foot: "Employee · Sample data" }, "reveal")}${mock({ title: "My team", rows: [["To approve", "4", "warn"], ["Away this week", "2 of 11"], ["Late today", "1"], ["Reviews due", "3", "info"]], foot: "Manager · Sample data" }, "reveal")}</div></div><div class="btn-row">${btn("/platform/employee-self-service/", "Employee Self-Service", "ghost")}${btn("/platform/manager-self-service/", "Manager Self-Service", "ghost")}</div>` })}

<section class="section reports" id="reports"><div class="wrap wide"><div class="rep-grid"><div><p class="eyebrow">Reporting and analytics</p><h2 class="reveal">Answers from your own data</h2><p class="lead reveal">A catalogue of reports for management, finance and HR, with filters, detail tabs, CSV export and access rules for sensitive data. The reports describe what has happened in your records. They do not predict.</p>
  <ul class="counters">
    <li><b data-count="245" data-prefix="about ">245</b><span>reports in the product catalogue</span></li>
    <li><b data-count="${modules.length}">${modules.length}</b><span>product areas on one record</span></li>
    <li><b data-count="15">15</b><span>ready workflow templates</span></li>
    <li><b data-count="6">6</b><span>guided payroll steps</span></li></ul>
  <p class="fine">A report shows data only where your company has that data.</p>
  <div class="btn-row">${btn("/platform/reports-analytics/", "Reports and Analytics", "primary")}</div></div>
  <div class="reveal">${frame({ ...A.shot("analytics"), alt: "The AiHxM analytics view for a demonstration company with workforce charts" })}</div></div></div></section>

<section class="section pk" id="pakistan"><div class="wrap wide"><div class="pk-grid"><div><p class="eyebrow">Pakistan-focused HRMS</p><h2 class="reveal">Built around the Pakistani tax year, calendar and payroll</h2><p class="lead reveal">The rules that change each year stay in your hands, confirmed with your accountant, so the system never goes out of date silently.</p>
  ${ticks(["July-to-June tax year and cumulative salary tax", "CNIC and NTN records, EOBI information", "PESSI and SESSI settings, WWF and WPPF worksheets", "Local holiday calendars with tentative moon-dependent dates", "Payment batches in a bank file layout you define", "English with an Urdu interface switcher on main screens"])}
  <div class="btn-row">${btn("/pakistan-hrms/", "HRMS for Pakistan", "primary")}</div><p class="fine">AiHxM does not file with government bodies, and no government certification is claimed.</p></div>
  <div class="pk-visual reveal" aria-hidden="true"><div class="pk-card"><span>Tax year</span><b>1 July – 30 June</b></div><div class="pk-card"><span>Time zone</span><b>Asia/Karachi</b></div><div class="pk-card"><span>Currency</span><b>PKR</b></div><div class="pk-card"><span>Identity</span><b>CNIC · NTN</b></div></div></div></div></section>

<section class="section dark plum sec" id="security"><div class="wrap wide"><p class="eyebrow">Security and enterprise architecture</p><h2 class="reveal">Employee information, kept private and controlled</h2><p class="lead reveal">Only features that exist are listed here, and nothing is claimed that has not been independently shown.</p>
  <div class="grid g3 sec-grid">${[["Tenant isolation", "Each company's data is separated at the database level."], ["Multi-factor authentication", "One-time codes, with step-up for sensitive actions."], ["Role-based access", "Roles, data scope and field-level permissions."], ["Audit trail", "Changes are recorded with who, what and when."], ["Secure employee information", "Sensitive values are encrypted with a key per company."], ["Enterprise administration", "Single sign-on, SCIM provisioning and read-only API keys."]].map(([t, d]) => `<div class="sec-item reveal"><span class="sec-ico">${icon("shield")}</span><h3>${t}</h3><p>${d}</p></div>`).join("")}</div>
  <div class="btn-row">${btn("/security/", "Security and Privacy", "light")}</div></div></section>

${section({ cls: "svc", id: "services", eyebrow: "Implementation and services", title: "From first conversation to confident launch", intro: "AiHxM is a platform supported by professional services. Scope and fees are agreed with you for each engagement.", wide: true,
  body: `<ol class="journey">${["Discover", "Configure", "Migrate", "Train", "Launch", "Support"].map((t, i) => `<li class="reveal" style="--i:${i}"><span class="j-dot">${i + 1}</span><strong>${t}</strong></li>`).join("")}</ol><div class="btn-row">${btn("/services/", "Our Services", "ghost")}${btn("/services/hrms-implementation/", "HRMS Implementation", "ghost")}</div>` })}

${ctaBand()}`;

  return {
    path: "/",
    title: "AiHxM | Intelligent Human Capital Management and HR Software for Pakistan",
    description: "AiHxM is an intelligent HR, payroll, attendance and performance platform for Pakistani businesses. One connected system for the whole employee journey, configurable around the way you work.",
    body,
    jsonld: [
      { "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: site.url },
      { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "AiHxM", applicationCategory: "BusinessApplication", operatingSystem: "Web", description: site.description, url: site.url },
    ],
  };
}
