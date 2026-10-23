import { pageHero, ctaBand, ticks } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Resources", "/resources/"]];
  const body = `
${pageHero({
  trail,
  title: "Short explainers on how AiHxM works.",
  lead: "Plain-language notes on the ideas behind the product. There are no gated downloads and no sign-up to read them.",
  actions: false,
})}
<section class="section">
  <div class="wrap narrow prose">
    <h2 id="payroll-run">How the six-step payroll run works</h2>
    <p>Each month moves through the same six steps, and the Payroll screen always shows which one you are on and what to do next.</p>
    ${ticks([
      "<strong>Prepare:</strong> enter or import pay inputs: benefits, loans, additional and off-cycle payments, and payroll events.",
      "<strong>Calculate:</strong> the run calculates in the background. You can run a simulation first.",
      "<strong>Review:</strong> validation, the readiness check and the variance check against the last finalised run.",
      "<strong>Approve:</strong> the run goes through its approval route.",
      "<strong>Finalize:</strong> the run is locked, and payslips and statutory reports can be produced.",
      "<strong>Pay and post:</strong> generate the bank file, release payments and post the journal.",
    ])}
    <h2 id="decisions">How approvals record a decision</h2>
    <p>Every approval step names its approver by rule: the submitter's manager, a role, or a named person. When someone approves or rejects, the system stores who decided, the date and time (set by the server), and any comment. A step can require a comment to approve, to reject, or both. Published workflow versions never change, so a request keeps the rules it started under.</p>
    <h2 id="effective-dating">What "effective-dated" means for your records</h2>
    <p>A job change, a transfer or a pay change has a date on which it starts. AiHxM keeps the earlier value and the date the new one takes over, so you can enter next month's promotion today without disturbing this month's payroll, and look at a setting as it stood on any date.</p>
    <h2 id="variance">Why the variance check exists</h2>
    <p>Most payroll mistakes are surprises: a missing allowance, a duplicated loan instalment, someone left off. The variance check compares the run against the last finalised one and names each person whose net pay moved more than 20% or whose tax moved more than 50% (both at least Rs 1,000), who dropped out and how many are new. It also warns if an earlier month in the tax year is still open.</p>
    <h2 id="glossary">Glossary</h2>
    <dl>
      <dt><strong>CNIC</strong></dt><dd>Computerised National Identity Card number. Held on the employee record and shown only to roles that may see it.</dd>
      <dt><strong>EOBI</strong></dt><dd>Employees' Old-Age Benefits Institution. AiHxM produces an EOBI report with employee and employer amounts from a finalised run.</dd>
      <dt><strong>Row-level security</strong></dt><dd>A database feature that lets each company see only its own rows. It is how AiHxM separates companies.</dd>
      <dt><strong>SCIM</strong></dt><dd>A standard for creating and removing user accounts automatically from an identity provider.</dd>
    </dl>
  </div>
</section>
${ctaBand({})}
`;
  return {
    path: "/resources/",
    title: "Resources",
    description:
      "Plain-language explainers: the six-step payroll run, how approvals record decisions, effective-dated records, the variance check, and a short glossary.",
    trail,
    body,
  };
};
