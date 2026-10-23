import { site } from "../site.config.mjs";
import { pageHero, ctaBand } from "../layout.mjs";

export const FAQ = [
  ["Is AiHxM only for Pakistan?", "It is built for Pakistani businesses: CNIC on the employee record, a July to June tax year, EOBI and social-security reports and Pakistani public holidays. Tax slabs and rates are entered by your company. The interface is in English only today."],
  ["Does it calculate Pakistani income tax?", "Yes, from the slabs and settings your company enters. Tax is worked out cumulatively over the July to June tax year, with retroactive calculation for back-dated changes. Confirm each rate against the official source with your accountant before your first live run."],
  ["Can I file with FBR from AiHxM?", "Not yet. There is no FBR e-filing upload layout or annual tax statement layout. You can export an income tax withheld report as CSV from a finalised run."],
  ["Can AiHxM pay salaries through my bank?", "It produces payment batches in a bank file layout that your company defines, with release and reconciliation. There are no named-bank or Raast layouts yet. Each needs the bank's real specification."],
  ["Does it work on phones?", "Yes. It can be installed on Android and iPhone from the browser, with a phone layout. Employees can clock in from a phone, with GPS."],
  ["Is there an Urdu interface?", "Not yet. Urdu translation and right-to-left layout are on our list."],
  ["How is my company's data kept separate from other companies?", "Each company's rows are separated inside the database with row-level security, and a cross-company test suite checks it. Each company also signs in at its own address."],
  ["Do you support single sign-on?", "Yes. SAML and OpenID Connect can be set up per company, and SCIM 2.0 can provision users automatically from your identity provider."],
  ["Can we import our existing employees?", "Yes. Employees can be imported in bulk from CSV, and payroll data can be imported and exported as CSV."],
  ["Do payslip emails work?", "Email works once your company's mail settings are configured. Payslip notices carry no amounts. WhatsApp and push notifications have no delivery provider yet."],
  ["How much does it cost?", "Pricing is quoted per company based on headcount and the modules you need. Request pricing from the demo form."],
];

export default () => {
  const trail = [["Home", "/"], ["Contact & FAQ", "/contact/"]];
  const faqHtml = `<div class="faq">${FAQ.map(([q, a]) => `<details><summary>${q}</summary><div>${a}</div></details>`).join("")}</div>`;
  const body = `
${pageHero({ trail, title: "Contact and frequently asked questions.", lead: "The quickest way to reach us is the demo form. It goes straight into our team's request list.", actions: false })}
<section class="section">
  <div class="wrap">
    <div class="grid g3">
      <div class="card"><h2 class="h3">Book a demo</h2><p>Tell us about your company and what you want to see.</p><a class="btn btn-primary" href="/book-a-demo/">Book a Personalized Demo</a></div>
      <div class="card"><h2 class="h3">Request pricing</h2><p>Headcount and modules are enough for a quote.</p><a class="btn btn-ghost" href="/book-a-demo/?interest=other">Request pricing</a></div>
      <div class="card"><h2 class="h3">Email${site.contactPhone ? " or call" : ""}</h2>${
        site.contactEmail
          ? `<p><a href="mailto:${site.contactEmail}">${site.contactEmail}</a>${site.contactPhone ? `<br>${site.contactPhone}` : ""}</p>`
          : `<p>Use the demo form for now. A direct email address will appear here once it is set up.</p>`
      }</div>
    </div>
  </div>
</section>
<section class="section soft">
  <div class="wrap narrow">
    <h2>Frequently asked questions</h2>
    ${faqHtml}
  </div>
</section>
${ctaBand({ title: "Still have a question?", text: "Ask it in the demo request and we will answer it in the walkthrough." })}
`;
  return {
    path: "/contact/",
    title: "Contact and FAQ",
    description:
      "How to reach AiHxM, and answers to common questions about Pakistani payroll, FBR and bank files, phones, Urdu, data separation, single sign-on and pricing.",
    trail,
    faq: FAQ,
    body,
  };
};
