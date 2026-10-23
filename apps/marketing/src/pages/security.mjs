import { pageHero, ctaBand, chip } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Security & trust", "/security/"]];
  const rows = [
    ["Tenant isolation", "Each company's rows are separated inside the database with row-level security. A cross-company test suite checks it.", "ok"],
    ["Roles and permissions", "Role-based access with data scopes: HR admin, line manager, employee, system admin and payroll roles.", "ok"],
    ["Field-level permissions", "Rules decide which roles see sensitive fields, including conditional rules based on a record's status.", "ok"],
    ["Encryption", "Sensitive fields are encrypted with keys held per company.", "ok"],
    ["Multi-factor sign-in", "Authenticator-app codes, required per user. A System Admin can reset a colleague's device or password.", "ok"],
    ["Step-up re-authentication", "Sensitive actions ask the person to confirm again.", "ok"],
    ["Single sign-on", "SAML and OpenID Connect, set up per company.", "ok"],
    ["SCIM 2.0 provisioning", "Automatic user provisioning from your identity provider.", "ok"],
    ["Sessions and rate limits", "Server-side sessions that can be revoked, with rate limiting per person and per address.", "ok"],
    ["Audit trail", "Important actions are recorded with who and when, plus a platform-level audit log.", "ok"],
    ["Privacy requests", "A workflow for access and erasure requests. Candidates can be anonymised.", "ok"],
    ["Operator access controls", "Platform administrators hold full, read-only or company-scoped access. Support access (\"Login as\") uses a short-lived session that can be ended.", "ok"],
    ["Backups and recovery", "Backups with download, and disaster-recovery test records, are available to the platform team.", "ok"],
    ["Company sign-in address", "Each company signs in at its own address, with a company-branded login page.", "ok"],
  ];
  const table = `<div class="table-wrap"><table><thead><tr><th scope="col">Control</th><th scope="col">What it does</th><th scope="col">Status</th></tr></thead><tbody>${rows
    .map(([a, d, s]) => `<tr><td data-label="Control">${a}</td><td data-label="What it does">${d}</td><td data-label="Status">${chip(s)}</td></tr>`)
    .join("")}</tbody></table></div>`;
  const body = `
${pageHero({
  trail,
  title: "Security you can check, not just read about.",
  lead: "HR and payroll data is sensitive. This page lists the controls that exist in the product, and what we do not claim.",
  actions: false,
})}
<section class="section">
  <div class="wrap">
    ${table}
  </div>
</section>
<section class="section soft">
  <div class="wrap">
    <div class="grid g2">
      <div class="card">
        <h2 class="h3">What we do not claim</h2>
        <ul class="ticks">
          <li>We do not claim third-party certifications or audit reports on this site.</li>
          <li>We do not claim a particular uptime figure.</li>
          <li>There is no separate staging environment for customers today.</li>
        </ul>
      </div>
      <div class="card">
        <h2 class="h3">Ask us directly</h2>
        <p>If your security team has a questionnaire, or you want to know where your data is hosted and how access is controlled, put it in your demo request and we will answer in writing.</p>
        <p><a class="btn btn-primary" href="/book-a-demo/">Book a Personalized Demo</a></p>
      </div>
    </div>
  </div>
</section>
${ctaBand({})}
`;
  return {
    path: "/security/",
    title: "Security and trust",
    description:
      "The security controls built into AiHxM: row-level tenant isolation, multi-factor sign-in, SSO and SCIM, field-level permissions, encryption and audit trail. Plus what we do not claim.",
    trail,
    body,
  };
};
