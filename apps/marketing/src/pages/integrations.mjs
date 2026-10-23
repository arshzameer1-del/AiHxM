import { pageHero, featureList, ctaBand, statusLegend } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Integrations", "/integrations/"]];
  const body = `
${pageHero({
  trail,
  title: "Connects the ways Pakistani companies actually exchange data.",
  lead: "Most of AiHxM's connections are open standards and files, not a marketplace of named apps. This is the real list.",
})}
<section class="section">
  <div class="wrap narrow">
    ${statusLegend()}
    <h2>Available today</h2>
    ${featureList([
      ["Single sign-on", "SAML and OpenID Connect, per company.", "ok"],
      ["SCIM 2.0", "Automatic user provisioning from an identity provider.", "ok"],
      ["Webhooks", "Domain events delivered to your systems, with event history, replay and test delivery.", "ok"],
      ["CSV import and export", "Employee and payroll data, and saved views.", "ok"],
      ["Accounting journal", "CSV journal and costing with general-ledger mapping.", "ok"],
      ["Attendance devices", "Biometric or other devices post punches with their own rotating keys. Needs devices and set-up on your side.", "setup"],
      ["Email", "Real email over SMTP once your mail settings are configured.", "setup"],
      ["Bank payment files", "In a layout your company defines. Generic, not a named-bank format.", "part"],
    ])}
    <h2>Not built yet</h2>
    ${featureList([
      ["FBR e-filing upload", "Needs the official format.", "no"],
      ["Named-bank and Raast payment layouts", "Needs each bank's specification.", "no"],
      ["WhatsApp and push delivery", "Notifications are recorded, but no delivery provider is connected.", "no"],
      ["Direct connectors to named accounting software", "Accounting export is a CSV journal.", "no"],
    ])}
  </div>
</section>
${ctaBand({ title: "Tell us what you need to connect", text: "Put your systems in the demo request and we will say plainly what works today." })}
`;
  return {
    path: "/integrations/",
    title: "Integrations",
    description:
      "What AiHxM connects to today: SSO (SAML, OpenID Connect), SCIM, webhooks, CSV import and export, accounting journals, attendance devices and email. And what is not built yet.",
    trail,
    body,
  };
};
