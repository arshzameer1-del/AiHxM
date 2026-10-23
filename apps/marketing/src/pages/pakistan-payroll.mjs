import { pageHero, statusLegend, ctaBand, chip, frame } from "../layout.mjs";

export default (A) => {
  const trail = [["Home", "/"], ["Pakistan payroll", "/pakistan-payroll/"]];
  const rows = [
    ["Tax slabs and statutory settings", "setup", "Entered and maintained by your company. No rate is fixed in the code.", "Your accountant's current slabs and rates."],
    ["Tax year and cumulative tax", "ok", "The tax year runs July to June. Tax is worked out cumulatively over the year, with retroactive calculation for back-dated changes.", "Nothing further."],
    ["Income tax withheld report", "part", "From a finalised run, with CNIC, totals, preview and CSV.", "An FBR e-filing upload layout and an annual tax statement layout are not built. The report is a plain CSV."],
    ["EOBI (employee and employer)", "part", "Report with CNIC, totals, preview and CSV from a finalised run.", "An EOBI challan layout is not built. We have not confirmed the EOBI wage base, so enter it from the official source."],
    ["Social security (employer)", "part", "Report with CNIC, totals, preview and CSV from a finalised run.", "A provincial social-security challan layout is not built."],
    ["Year-end tax and salary certificates", "ok", "Generated from payroll data.", "Check the wording and format with your accountant."],
    ["Payslips", "ok", "Designed in the payslip designer, published when you choose. Email notices carry no amounts.", "Mail settings for email delivery."],
    ["Bank payments", "part", "Payment batches in a bank file layout your company defines, with release and reconciliation.", "Named-bank and Raast layouts are not built. We need each bank's real specification."],
    ["Public holidays", "setup", "Fixed-date Pakistani public holidays for 2026 and 2027 come in the starter setup.", "HR adds Eid and other moon-sighting holidays once they are announced."],
    ["CNIC and sensitive data", "ok", "CNIC, date of birth, salary band and bank account show or hide per role, with encryption keys held per company.", "Nothing further."],
    ["Urdu", "no", "The interface is English only.", "Urdu translation and right-to-left layout."],
  ];
  const table = `<div class="table-wrap"><table><thead><tr><th scope="col">Area</th><th scope="col">Status</th><th scope="col">What you get today</th><th scope="col">What is still needed</th></tr></thead><tbody>${rows
    .map(([a, s, g, n]) => `<tr><td data-label="Area">${a}</td><td data-label="Status">${chip(s)}</td><td data-label="What you get today">${g}</td><td data-label="What is still needed">${n}</td></tr>`)
    .join("")}</tbody></table></div>`;

  const body = `
${pageHero({
  trail,
  title: "Payroll for Pakistan, with the gaps stated plainly.",
  lead: "Payroll rules change, and a wrong rate is worse than a missing one. AiHxM keeps tax slabs and statutory settings in your hands, and tells you exactly which official formats are not built yet.",
})}
<section class="section">
  <div class="wrap">
    <div class="split">
      <div>
        <h2>Why your company enters the rates</h2>
        <p>Slabs, thresholds and wage bases are set by notifications that change. Instead of shipping numbers that go stale, AiHxM stores the rates as company settings, so a change is an edit you control and the effective date is on record.</p>
        <p>We do not state that AiHxM is compliant on its own. Confirm each rate against the current official source with your accountant before the first live run. The variance check then helps you catch surprises: it names every person whose net pay moved more than 20% or tax more than 50% against the last finalised run (both at least Rs 1,000).</p>
      </div>
      ${frame({ ...A.shot("payroll-dashboard"), alt: "AiHxM payroll screen showing the six-step run and a finalised September 2026 payroll for 40 people.", caption: "A finalised monthly run. Sample data and sample amounts." })}
    </div>
  </div>
</section>
<section class="section soft">
  <div class="wrap">
    <div class="section-head"><h2>Where each Pakistan-specific item stands</h2><p class="lead">This table is the same one we use internally. We would rather you see it now than find it in a demo.</p></div>
    ${statusLegend()}
    ${table}
    <div class="callout"><h3>Have a bank or an official format you need?</h3><p>The two things that unblock the missing layouts are the official specification and a sample file. If a particular bank or filing matters to you, tell us in the demo request and we will say plainly whether and when it can be built.</p></div>
  </div>
</section>
${ctaBand({ title: "Talk through your payroll set-up", text: "Bring your current payslip and your bank's file format. We will show what AiHxM covers and what it does not." })}
`;
  return {
    path: "/pakistan-payroll/",
    title: "Payroll for Pakistan",
    description:
      "How AiHxM handles Pakistani payroll: tax slabs you enter, July to June cumulative tax, EOBI and social-security reports, and which official formats are not built yet.",
    trail,
    body,
  };
};
