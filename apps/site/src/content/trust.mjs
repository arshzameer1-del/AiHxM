// Trust, security and company-transparency content. Everything here is either checked against the code (see
// docs/marketing/capability-inventory.md) or openly marked as not yet published. Nothing is invented: a fact the owner has
// not confirmed is shown as "Not yet published", never as a reassuring guess.

// state: yes = in the product | cust = set by the customer's company | agree = agreed in writing for each customer.
// Public wording never states a certification, a recovery figure, an uptime figure or a customer. Where an arrangement is
// confirmed per customer, the row says so. The true implementation state of every row is kept in
// docs/internal/AIHXM_PRODUCT_LAUNCH_READINESS.md and must be confirmed before launch.
export const SEC_STATE = {
  yes: { label: "In the product", tone: "yes" },
  cust: { label: "Set by your company", tone: "setup" },
  agree: { label: "Agreed per customer", tone: "tbc" },
};

export const securityMatrix = [
  { id: "tenant", area: "Tenant isolation", state: "yes", what: "Every company's records are separated in the database with row-level security. Automated tests try to read one company's data from another and must fail.", note: "" },
  { id: "dbaccess", area: "Database access", state: "yes", what: "Browsers never talk to the database. All access goes through the application server, which sets the company for every request before any query runs.", note: "" },
  { id: "authn", area: "Sign-in and multi-factor authentication", state: "yes", what: "Passwords are stored hashed. Repeated failed attempts are throttled and locked out. One-time-code MFA is available, its secrets are stored encrypted, and sensitive actions can require a fresh verification.", note: "" },
  { id: "access", area: "Access control", state: "cust", what: "Built-in and custom roles, access scoped to oneself, a team or the company, and separate permissions for sensitive fields such as pay and identity numbers.", note: "Your administrators set roles and scopes." },
  { id: "sso", area: "Single sign-on and provisioning", state: "cust", what: "SAML 2.0, OpenID Connect and SCIM 2.0 connect AiHxM to your identity system.", note: "Set up with your identity provider." },
  { id: "encrypt", area: "Encryption of sensitive data", state: "yes", what: "Sensitive values are encrypted in the application with AES-256-GCM, using a separate key for each company. Browser connections use HTTPS.", note: "" },
  { id: "audit", area: "Audit trail", state: "yes", what: "Changes are recorded with who, what and when, and the audit records cannot be edited through the product.", note: "" },
  { id: "api", area: "API keys and webhooks", state: "yes", what: "API keys are read-only, scoped, stored hashed, shown once and revocable, and expose no pay, bank, identity or contact data. Webhooks keep a delivery history.", note: "" },
  { id: "hardening", area: "Application hardening", state: "yes", what: "Standard HTTP security headers and request rate limits are applied by the application, and this website sends strict security headers.", note: "" },
  { id: "dsr", area: "Data-subject requests", state: "yes", what: "A workflow to receive and handle requests about personal data.", note: "" },
  { id: "backup", area: "Backups and restore", state: "agree", what: "Backup, restore and recovery arrangements are agreed in writing for each customer before go-live.", note: "" },
  { id: "dr", area: "Disaster recovery", state: "agree", what: "Recovery arrangements form part of the written hosting agreement for each customer.", note: "" },
  { id: "hosting", area: "Hosting", state: "agree", what: "AiHxM runs on managed cloud services. The hosting arrangement for a customer's production data is confirmed in writing before go-live. Dedicated hosting is available as a scoped service.", note: "" },
  { id: "location", area: "Data location", state: "agree", what: "Where a customer's data is stored is stated in writing before contract. If your policy requires a specific country, tell us first.", note: "" },
  { id: "incident", area: "Incident response", state: "agree", what: "Incident handling and customer notification terms are set out in the customer agreement.", note: "" },
  { id: "disclosure", area: "Reporting a vulnerability", state: "agree", what: "Security concerns can be reported through the contact page and are reviewed by the team.", note: "" },
  { id: "subproc", area: "Service providers", state: "agree", what: "The third-party services that process customer data are listed in writing during procurement.", note: "" },
  { id: "assurance", area: "Independent testing and assurance", state: "agree", what: "Questions about independent testing or assurance reports are answered in writing during procurement.", note: "" },
];

// What the customer is responsible for, so the boundary of the product's protection is clear.
export const customerResponsibilities = [
  ["Who has access", "Your administrators decide who gets an account, which role they hold and when access ends."],
  ["Sign-in policy", "Whether MFA is required, and how your identity system and single sign-on are set up, is your choice."],
  ["Devices and passwords", "Keeping staff devices, passwords and one-time-code apps safe is outside the product."],
  ["What you load", "You decide which employee data goes into the system and who may see sensitive fields."],
  ["Your own compliance", "Your legal and tax obligations remain yours. AiHxM is a tool for meeting them, not advice on them."],
];

// How a cautious buyer can check the product before buying.
export const verifyGuide = [
  { ask: "See the product working", today: "A guided demo on a sample company, and the public playground on this site with fictional data." },
  { ask: "Check the security design", today: "The Security page lists the controls by area. Send a questionnaire and we answer it in writing." },
  { ask: "Understand the project", today: "The Implementation page lists each phase, what we do, what you provide and what you receive." },
  { ask: "Test payroll before relying on it", today: "Payroll implementation includes a parallel run against your current payroll before your first live run." },
  { ask: "Know what it will cost", today: "The Pricing page shows how a quote is built, and the scope estimator turns your needs into a scope you can send." },
  { ask: "Get terms in writing", today: "Quotations, hosting arrangements and the support tier are agreed in writing before work starts." },
];

// Case-study architecture. A story is shown only when it has an approval record. The list is empty on purpose.
export const caseStudies = [
  // {
  //   slug: "company-name", company: "Registered name as the customer approved it", industry: "...", size: "employees band",
  //   modules: ["payroll"], summary: "...", challenge: "...", approach: "...", outcome: "...",
  //   metrics: [["measured in the customer's own words and figures", "value"]],
  //   approval: { by: "Name and role at the customer", on: "YYYY-MM-DD", scope: "what they allowed us to publish" },
  // },
];
export const caseStudyTemplate = ["Customer and industry", "The situation before", "What was set up", "What changed, in the customer's own measure", "What the customer approved for publication"];

// Company facts. Only confirmed values are rendered; an empty value is never replaced by a placeholder.
export const companyFacts = (site) => [
  ["Product", `${site.name}: ${site.tagline}`],
  ["Built for", "Pakistani businesses that want HR, payroll and attendance in one system"],
  site.legalName && site.legalName !== site.name ? ["Registered company", site.legalName] : null,
  site.regNo ? ["Registration number", site.regNo] : null,
  site.address ? ["Address", site.address] : null,
  site.contactPhone ? ["Phone", site.contactPhone] : null,
  site.whatsapp ? ["WhatsApp", "Available through the contact page"] : null,
  site.contactEmail ? ["Email", site.contactEmail] : null,
].filter(Boolean);
