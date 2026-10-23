import { pageHero, ctaBand, chip, statusLegend } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Platform", "/platform/"]];
  const rows = [
    ["Core HR", "/platform/core-hr/", "Employee records, organisation units, positions, locations, cost and profit centres, reorganisations.", "ok", "Interface is English only."],
    ["Payroll", "/platform/payroll/", "Six-step monthly run, variance check, payslips, certificates, settlements, statutory reports, bank batches, accounting journal.", "part", "No FBR upload or challan layouts, no named-bank layouts, no payroll register, no scheduled run."],
    ["Time & attendance", "/platform/attendance/", "Clock in and out, shifts, timesheets, corrections, overtime, on-duty, device feeds.", "ok", "Devices need set-up on your side."],
    ["Leave", "/platform/leave/", "Policies by employee group, balances with ledger, accrual, holidays, team calendar.", "ok", "Moon-sighting holidays are added by HR."],
    ["Talent", "/platform/talent/", "Recruitment, onboarding and offboarding, performance and goals, learning, expenses.", "ok", "Learning is a catalogue with enrolments."],
    ["Workflows & approvals", "/platform/workflows/", "Configurable routes for 15 processes, one inbox, comment rules per step, delegations, decision history.", "ok", ""],
    ["Self-service", "/platform/self-service/", "Role-based home pages, personal data, org chart, notifications.", "part", "Email needs your mail settings. WhatsApp and push have no provider."],
    ["Reports & analytics", "/platform/reporting/", "Workforce analytics, payroll dashboard, variance, statutory and accounting exports.", "part", "No payroll register or custom report builder."],
  ];
  const table = `<div class="table-wrap"><table><thead><tr><th scope="col">Module</th><th scope="col">What it covers</th><th scope="col">Status</th><th scope="col">Worth knowing</th></tr></thead><tbody>${rows
    .map(([n, h, d, s, g]) => `<tr><td data-label="Module"><a href="${h}">${n}</a></td><td data-label="What it covers">${d}</td><td data-label="Status">${chip(s)}</td><td data-label="Worth knowing">${g || "&mdash;"}</td></tr>`)
    .join("")}</tbody></table></div>`;
  const body = `
${pageHero({
  trail,
  title: "One platform, eight working areas.",
  lead: "The modules share one employee record and one approval engine, so they behave like parts of one product.",
})}
<section class="section">
  <div class="wrap">
    ${statusLegend()}
    ${table}
  </div>
</section>
<section class="section soft">
  <div class="wrap">
    <div class="section-head"><h2>Underneath every module</h2></div>
    <div class="grid g3">
      <div class="card"><h3>Isolated companies</h3><p>Each company's data is separated with row-level security and signs in at its own address.</p><a class="more" href="/security/">Security and trust &rarr;</a></div>
      <div class="card"><h3>Administration</h3><p>Role assignment, MFA settings, a guided starter setup, versioned configuration with scheduled changes and rollback, and change requests.</p></div>
      <div class="card"><h3>Open connections</h3><p>SSO, SCIM, webhooks and CSV import and export.</p><a class="more" href="/integrations/">Integrations &rarr;</a></div>
    </div>
  </div>
</section>
${ctaBand({})}
`;
  return {
    path: "/platform/",
    title: "Platform overview",
    description:
      "AiHxM platform overview: core HR, payroll, time and attendance, leave, talent, workflows and approvals, self-service and reports, with an honest status for each.",
    trail,
    body,
  };
};
