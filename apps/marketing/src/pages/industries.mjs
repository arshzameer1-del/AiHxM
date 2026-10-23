import { pageHero, ctaBand } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Who it's for", "/industries/"]];
  const body = `
${pageHero({
  trail,
  title: "Built for growing Pakistani businesses.",
  lead: "AiHxM is not split into industry editions. It fits companies whose HR has outgrown spreadsheets and chat groups, and these are the situations where it helps most.",
})}
<section class="section">
  <div class="wrap">
    <div class="grid g2">
      <div class="card"><h2 class="h3">Teams leaving spreadsheets behind</h2><p>If attendance is in one file, leave in another and payroll in a third, the same change gets typed three times. One employee record removes that work and keeps history.</p><p class="small muted">Relevant: <a href="/platform/core-hr/">Core HR</a>, <a href="/platform/payroll/">Payroll</a></p></div>
      <div class="card"><h2 class="h3">Companies on more than one site</h2><p>Model locations as a tree, use cost centres and profit centres, and run regional payroll areas with scoped access, so a regional HR lead sees their own people.</p><p class="small muted">Relevant: <a href="/platform/core-hr/">Organisation structure</a>, <a href="/platform/payroll/">Payroll areas</a></p></div>
      <div class="card"><h2 class="h3">Shift-based and field teams</h2><p>Shifts with weekly patterns, clock in from a phone with GPS, device feeds from biometric terminals, correction requests and overtime with approval.</p><p class="small muted">Relevant: <a href="/platform/attendance/">Time &amp; attendance</a></p></div>
      <div class="card"><h2 class="h3">Finance teams that need control</h2><p>Approval routes you design, a separate payroll approval step, a variance check before finalising, and GL-mapped accounting journals.</p><p class="small muted">Relevant: <a href="/platform/workflows/">Workflows &amp; approvals</a>, <a href="/platform/reporting/">Reports</a></p></div>
      <div class="card"><h2 class="h3">HR teams that hire steadily</h2><p>Requisitions through approval, a candidate pipeline, offers with letters, and onboarding checklists. An accepted offer creates the employee record.</p><p class="small muted">Relevant: <a href="/platform/talent/">Talent</a></p></div>
      <div class="card"><h2 class="h3">IT teams with an identity provider</h2><p>Single sign-on with SAML or OpenID Connect and SCIM user provisioning, set up per company.</p><p class="small muted">Relevant: <a href="/security/">Security</a>, <a href="/integrations/">Integrations</a></p></div>
    </div>
    <div class="callout warn"><h2 class="h3">What we do not claim</h2><p>We do not list customer logos or sector-specific packages on this site, and we have not built features that exist only for one industry. If your sector has a rule we should know about, say so when you book a demo.</p></div>
  </div>
</section>
${ctaBand({})}
`;
  return {
    path: "/industries/",
    title: "Who AiHxM is for",
    description:
      "The situations where AiHxM fits best: teams leaving spreadsheets, multi-site companies, shift-based teams, finance-controlled payroll, steady hiring and identity-provider setups.",
    trail,
    body,
  };
};
