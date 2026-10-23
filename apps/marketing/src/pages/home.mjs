import { site } from "../site.config.mjs";
import { frame, ctaBand, ticks } from "../layout.mjs";

export default (A) => {
  const payroll = A.shot("payroll-hero");
  const dashboard = A.shot("payroll-dashboard");
  const employees = A.shot("employees");
  const analytics = A.shot("analytics");
  const recruitment = A.shot("recruitment");
  const config = A.shot("configuration");

  const body = `
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <h1>HR, attendance and payroll, <em>connected</em> in one platform.</h1>
      <p class="lead">AiHxM is built for Pakistani businesses. One employee record feeds leave, attendance, payroll, approvals and reports, so a change made once reaches every place that needs it.</p>
      <div class="btn-row">
        <a class="btn btn-primary" href="/book-a-demo/">Book a Personalized Demo</a>
        <a class="btn btn-ghost" href="/platform/">Explore the Platform</a>
      </div>
      <ul class="proof-line">
        <li>Each company runs in its own isolated space</li>
        <li>Installable on Android and iPhone from the browser</li>
        <li>Tax slabs and statutory rates are yours to enter</li>
      </ul>
    </div>
    ${frame({ ...payroll, alt: "AiHxM Payroll screen showing the six-step monthly run, with the latest payroll finalised for 40 people and the next action stated in one sentence.", caption: "The Payroll screen from a demo company with sample data.", eager: true })}
  </div>
</section>

<section class="section navy">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">Why connected matters</span>
      <h2>Change it once. Every module sees it.</h2>
      <p class="lead">Most teams run HR in one tool, attendance in another and payroll in a spreadsheet, then re-type the same changes three times. In AiHxM the employee record sits in the middle and everything else reads from it.</p>
    </div>
    <ol class="flow">
      <li class="core"><strong>Employee record</strong>Job, manager, pay, bank account, dates. Effective-dated, so history is kept.</li>
      <li><strong>Attendance</strong>Clock events, shifts and timesheets follow the employee's schedule.</li>
      <li><strong>Leave</strong>Policies are picked from the employee's group. Balances and approvals follow.</li>
      <li><strong>Payroll</strong>Pay inputs, loans, overtime payouts and events feed the monthly run.</li>
      <li><strong>Payslips &amp; reports</strong>Payslips, tax and statutory files come from the finalised run.</li>
    </ol>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">The platform</span>
      <h2>Everything a growing HR team runs, in one place.</h2>
      <p class="lead">Each area is a working module with its own screens, not a placeholder. Where something is partly built or needs your setup, the page for that module says so.</p>
    </div>
    <div class="grid g3">
      <a class="card" href="/platform/core-hr/"><h3>Core HR</h3><p>Employee records, organisation units, positions, locations and cost centres, with reorganisations planned for a future date.</p><span class="more">Core HR &rarr;</span></a>
      <a class="card" href="/platform/payroll/"><h3>Payroll</h3><p>A six-step monthly run with a variance check, payslips, year-end certificates, statutory reports and bank payment files.</p><span class="more">Payroll &rarr;</span></a>
      <a class="card" href="/platform/attendance/"><h3>Time &amp; attendance</h3><p>Clock in from the browser or phone, shifts, timesheets, correction requests, overtime and device feeds.</p><span class="more">Time &amp; attendance &rarr;</span></a>
      <a class="card" href="/platform/leave/"><h3>Leave</h3><p>Policies assigned by employee group, balances with a ledger, a team calendar and approvals that show who decided and when.</p><span class="more">Leave &rarr;</span></a>
      <a class="card" href="/platform/workflows/"><h3>Workflows &amp; approvals</h3><p>Configurable approval routes for 15 processes, one inbox, and a comment requirement you set per step.</p><span class="more">Workflows &rarr;</span></a>
      <a class="card" href="/platform/talent/"><h3>Talent</h3><p>Recruitment, onboarding, performance reviews and goals, learning and expense claims.</p><span class="more">Talent &rarr;</span></a>
    </div>
  </div>
</section>

<section class="section soft">
  <div class="wrap">
    <div class="split">
      <div>
        <span class="eyebrow">Payroll</span>
        <h2>A monthly run that tells you what to do next.</h2>
        <p>Payroll moves through six steps: Prepare, Calculate, Review, Approve, Finalize, then Pay and post. The screen shows where you are and states the next action in a sentence.</p>
        ${ticks([
          "<strong>Variance check</strong> against the last finalised run. It names each person whose net pay moved more than 20% or whose tax moved more than 50% (both at least Rs 1,000), who dropped out and how many are new.",
          "<strong>Tax over the tax year</strong>, July to June, calculated cumulatively, with retroactive calculation for back-dated changes.",
          "<strong>Payslips you publish when ready</strong>, with email notices that carry no amounts.",
        ])}
        <p><a class="btn btn-ghost" href="/platform/payroll/">See what payroll covers</a></p>
      </div>
      ${frame({ ...dashboard, alt: "AiHxM payroll dashboard listing recently finalised runs for July, August and September with people calculated, net pay and employer cost.", caption: "Payroll dashboard with three finalised runs. Sample data." })}
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="split flip">
      <div>
        <span class="eyebrow">Pakistan</span>
        <h2>Set up for Pakistani payroll. Clear about what still needs your input.</h2>
        <p>Tax slabs and statutory settings are entered by your company, so no rate is hard-wired into the software. Fixed-date public holidays for 2026 and 2027 are loaded in the starter setup. EOBI and social-security reports come from a finalised run with CNIC, totals, preview and CSV.</p>
        <p>We do not claim an official FBR upload file or named-bank payment layouts yet. Those need the official formats, and the Pakistan payroll page lists exactly where things stand.</p>
        <p><a class="btn btn-ghost" href="/pakistan-payroll/">Pakistan payroll in detail</a></p>
      </div>
      ${frame({ ...config, alt: "AiHxM Configuration Center starter setup listing approval routes, public holidays, leave policy and working hours as in place.", caption: "Starter setup walks a new company through its basics." })}
    </div>
  </div>
</section>

<section class="section soft">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">See the product</span>
      <h2>Real screens from a demo company.</h2>
      <p class="lead">These are screenshots of the running application with sample people and sample numbers. Nothing here is a mock-up.</p>
    </div>
    <div class="grid g3">
      ${frame({ ...employees, alt: "AiHxM employee directory showing 40 employees by department.", caption: "Employee directory." })}
      ${frame({ ...analytics, alt: "AiHxM workforce analytics showing headcount by department and employment type.", caption: "Workforce analytics." })}
      ${frame({ ...recruitment, alt: "AiHxM recruitment screen listing open job requisitions.", caption: "Recruitment requisitions." })}
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="split">
      <div>
        <span class="eyebrow">Trust</span>
        <h2>Your company's data stays in your company's space.</h2>
        <p>Every company's records are separated inside the database with row-level security, and a cross-company test suite checks it. People sign in with an authenticator-app code, sensitive fields show or hide by role, and important actions are written to an audit trail.</p>
        <p><a class="btn btn-ghost" href="/security/">Security and trust</a></p>
      </div>
      <div class="card">
        <h3>What we can point to today</h3>
        ${ticks([
          "Row-level tenant isolation, tested",
          "Multi-factor sign-in, with step-up for sensitive actions",
          "Single sign-on (SAML, OpenID Connect) and SCIM provisioning",
          "Field-level permissions and per-company encryption keys",
          "Audit trail of who did what and when",
        ])}
        <p class="small muted">We do not claim third-party certifications such as ISO 27001 or SOC 2.</p>
      </div>
    </div>
  </div>
</section>

${ctaBand({})}
`;
  return {
    path: "/",
    title: `${site.name}: ${site.tagline}`,
    description:
      "AiHxM is an HR, attendance and payroll platform built for Pakistani businesses: core HR, payroll, time and attendance, leave, approvals and reports on one employee record.",
    body,
  };
};
