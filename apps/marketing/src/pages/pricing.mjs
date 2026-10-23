import { pageHero, ctaBand } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Pricing & deployment", "/pricing/"]];
  const body = `
${pageHero({
  trail,
  title: "Pricing is quoted for your company.",
  lead: "There is no public price list. Tell us roughly how many people you have and which modules you need, and we will send a quote.",
  actions: false,
})}
<section class="section">
  <div class="wrap">
    <div class="split">
      <div>
        <h2>How a quote is put together</h2>
        <p>AiHxM is packaged in tiers, and modules and features can be switched on per company. Your headcount and the modules you need are what we ask for to prepare a quote.</p>
        <p><a class="btn btn-primary" href="/book-a-demo/?interest=other">Request pricing</a></p>
      </div>
      <div class="card">
        <h3>To get an accurate quote, have ready</h3>
        <ul class="ticks">
          <li>Roughly how many employees you have, and how many sites</li>
          <li>Which modules matter first: payroll, attendance, leave, hiring</li>
          <li>Whether you need single sign-on or device integration</li>
        </ul>
      </div>
    </div>
  </div>
</section>
<section class="section soft">
  <div class="wrap">
    <div class="section-head"><h2>Deployment</h2><p class="lead">AiHxM is a hosted web service. Nothing to install on your servers.</p></div>
    <div class="grid g3">
      <div class="card"><h3>Your own space</h3><p>Each company runs in its own isolated space and signs in at its own address, with a login page carrying the company's branding.</p></div>
      <div class="card"><h3>A guided start</h3><p>A starter setup walks a new company through approval routes, holidays, a leave policy, working hours and its first payroll area.</p></div>
      <div class="card"><h3>Bring your data</h3><p>Employees can be loaded in bulk from CSV, and payroll data can be imported and exported as CSV.</p></div>
      <div class="card"><h3>On phones too</h3><p>Installable on Android and iPhone from the browser, with a phone layout.</p></div>
      <div class="card"><h3>Your identity provider</h3><p>Single sign-on (SAML, OpenID Connect) and SCIM provisioning can be set up per company.</p></div>
      <div class="card"><h3>Hosting questions</h3><p>Ask where your data is hosted and how backups work. We will answer specifically in the demo.</p></div>
    </div>
  </div>
</section>
${ctaBand({ title: "Get a quote", text: "A short conversation is enough: headcount, modules and any integration needs." })}
`;
  return {
    path: "/pricing/",
    title: "Pricing and deployment",
    description:
      "AiHxM pricing is quoted per company based on headcount and the modules you use. How deployment works: hosted service, company-specific sign-in, guided setup and CSV import.",
    trail,
    body,
  };
};
