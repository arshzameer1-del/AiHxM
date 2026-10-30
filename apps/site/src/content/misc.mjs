// FAQs, integrations, pricing structure, security statements and the home-page lifecycle. Edit here, not in pages.
export const faqs = [
  ["What is AiHxM?", "AiHxM is a cloud HR, payroll and attendance platform built for Pakistani businesses. It connects employee records, leave, attendance, payroll, recruitment, performance and more in one system, and your own team can configure it."],
  ["What does AiHxM manage?", "The employee record from hire to exit, leave and attendance, payroll and tax, approvals, organisation structure, recruitment, performance and talent, learning, expenses and travel, onboarding and offboarding, surveys, recognition, the HR help desk, documents and assets, plus reports and a configuration centre."],
  ["Which HR modules are available?", "Every module on the product pages is built. Each capability carries a status: available, needs your setup, partly built or upcoming. The status labels on the product pages are the definitive answer."],
  ["How does payroll processing work?", "A six-step monthly run: prepare, calculate, review, approve, finalise, then pay and post. Variance checks flag unusual changes before approval, and every payslip keeps its calculation."],
  ["Does AiHxM support Pakistan income tax?", "Yes. Salary tax is calculated by tax year (July to June) using the slabs your company enters, with a cumulative method, tax profiles and exemptions. Rates are maintained by you with your accountant because they change."],
  ["How does EOBI configuration work?", "You enter the current EOBI wage base and rates as settings with an effective date. AiHxM then calculates the employee and employer amounts and reports them from finalised payslips. It does not file with EOBI."],
  ["Can businesses configure their own workflows?", "Yes. Start from one of 15 workflow templates and edit the steps, approvers, comment rules and fallback approvers."],
  ["Can employees view payslips?", "Yes. Once payslips are published, employees see them in self-service, on the web or the installable phone app."],
  ["Can managers approve leave?", "Yes. Managers get an approvals inbox with the balance and team calendar in view, and can delegate while away."],
  ["Does AiHxM support attendance devices?", "Yes. Devices can send punches to a secured intake with a rotating device key. The devices and their setup are on the customer's side, so this needs setup."],
  ["Can multiple locations be managed?", "Yes. Locations can have their own holiday calendars, and employee groups can apply different policies."],
  ["How is company data isolated?", "Each company's data is separated at the database level, so one company's records cannot be read by another. Access inside a company is controlled by roles and data scope."],
  ["Can employee data be imported?", "Yes. Bulk import accepts a spreadsheet and checks each row. Data migration from older systems is also available as a service."],
  ["How can a company request a demo?", "Use the Book a Demo form. It stores your request and the AiHxM team follows up with you."],
  ["What implementation services are available?", "Implementation, payroll setup, data migration, consulting, integration, training and support are offered as services. Scope and fees are agreed per engagement."],
  ["How does pricing work?", "Pricing is not published. Contact us for a personalised quote based on your employees, modules and the services you want."],
];

// Only supported or formally approved integrations. No third-party product is named. Status says what is real today.
export const integrationGroups = [
  { t: "Banking and Payments", items: [["Payment batches with a company-defined bank file", "Create a file in the layout your bank accepts, then reconcile.", "partial"], ["Payment reconciliation", "Check what was paid against payroll.", "available"], ["Named-bank file layouts", "Ready-made layouts for specific banks.", "upcoming"]] },
  { t: "Attendance and Biometrics", items: [["Device punch intake", "Devices send punches to a secured endpoint with a rotating key; punches are matched to employees.", "setup"], ["Biometric devices", "Works through the device intake. Devices and their configuration are on your side.", "setup"]] },
  { t: "Accounting", items: [["Accounting journal export", "A CSV with your general-ledger mapping.", "available"], ["Direct connection to accounting software", "Pushing journals straight into an accounting system.", "upcoming"]] },
  { t: "Identity and Authentication", items: [["Single sign-on", "SAML 2.0 and OpenID Connect.", "available"], ["SCIM 2.0 provisioning", "Create and remove accounts from your identity system.", "available"], ["Multi-factor authentication", "One-time codes for sign-in, with step-up for sensitive actions.", "available"]] },
  { t: "Communication", items: [["Email notifications", "Sent through your mail server settings.", "setup"], ["In-app notifications", "Inside the product.", "available"], ["WhatsApp and push", "Recorded today but not sent: no provider is connected.", "upcoming"]] },
  { t: "APIs and Developer Tools", items: [["Read-only API keys", "Hashed, shown once, revocable and limited in scope; an OpenAPI document describes them.", "available"], ["Webhooks", "Event delivery with history and replay.", "available"], ["Job feed", "An XML feed of open jobs from the careers page.", "available"]] },
];

export const pricingPlans = [
  { key: "starter", name: "Starter", for: "Small teams starting out", modules: ["Core HR", "Leave", "Attendance", "Self-service"] },
  { key: "growth", name: "Growth", for: "Growing companies adding payroll and approvals", modules: ["Everything in Starter", "Payroll", "Workflows", "Reports"] },
  { key: "business", name: "Business", for: "Established companies with several locations", modules: ["Everything in Growth", "Recruitment", "Performance", "Talent", "Learning"] },
  { key: "enterprise", name: "Enterprise", for: "Complex organisations", modules: ["Everything in Business", "SSO and provisioning", "Dedicated hosting option", "Custom configuration"] },
];
export const pricingFactors = ["Number of employees", "Modules you use", "Payroll included or not", "Implementation and migration scope", "Hosting model", "Training and support arrangements"];

export const securityItems = [
  ["Multi-tenant architecture", "Every company works in its own space. Employees, payroll and documents belong to one company and are never mixed with another."],
  ["Database-level data isolation", "Row-level security in the database separates companies, and automated tests try to read across companies to prove it cannot happen."],
  ["Multi-factor authentication", "One-time codes at sign-in, with step-up verification for sensitive actions."],
  ["Password controls", "A strong-password policy, throttling of repeated attempts and protection against timing leaks."],
  ["Role-based access", "Built-in and custom roles decide what each person can do."],
  ["Data access scope", "Access can be limited to oneself, a team or the whole company."],
  ["Field-level permissions", "Sensitive fields such as pay and identity numbers can be restricted separately from the rest of a record."],
  ["Audit logging", "Changes are recorded with who, what and when."],
  ["Single sign-on and SCIM", "SAML 2.0, OpenID Connect and SCIM 2.0 provisioning for organisations with an identity system."],
  ["Read-only API keys", "Keys are stored hashed, shown once, scoped and revocable, and expose no pay, bank, ID or contact data."],
  ["Data-subject requests", "A workflow to handle requests about personal data."],
  ["Encryption of sensitive data", "Sensitive values are encrypted with a key per company."],
];
export const securityNotAClaim = "AiHxM does not claim any third-party certification, penetration test or regulatory approval, and publishes no uptime figure.";

export const lifecycle = [
  { key: "hire", label: "Hire", text: "Open a requisition, publish the job, move candidates through a pipeline and make an offer.", modules: ["recruitment", "workflows"] },
  { key: "onboard", label: "Onboard", text: "Turn a hire into an employee record and run a checklist across HR, IT and the manager.", modules: ["onboarding-offboarding", "documents-agreements"] },
  { key: "manage", label: "Manage", text: "Keep records, leave, attendance and approvals current in one place.", modules: ["core-hr", "leave", "attendance"] },
  { key: "pay", label: "Pay", text: "Run payroll with tax, statutory contributions and reconciled payments.", modules: ["payroll", "expenses-travel", "compensation"] },
  { key: "develop", label: "Develop", text: "Set goals, review performance, close skill gaps and plan succession.", modules: ["performance", "talent", "learning"] },
  { key: "retain", label: "Retain", text: "Listen through surveys, recognise good work and keep a help desk responsive.", modules: ["surveys-engagement", "recognition-announcements", "hr-help-desk"] },
];

export const industriesList = ["Manufacturing", "Healthcare", "Retail", "Information Technology", "Construction", "Professional Services", "Education", "Hospitality"];
