// Commercial structure: how a quote is built, what is priced separately, implementation phases and support tiers.
// PRICES: no price, rate, fee, discount, support hour, channel or response time is approved yet. Every such value below is
// `null`. When the business approves one, set it here (and flip the matching flag in flags.mjs) and the estimator and
// tables start showing it. Nothing is ever filled in with a guess.

export const priceModels = [
  ["Subscription", "Charged for using the software. Structured by number of employees and by which modules you use. Approved rates: not yet published."],
  ["Implementation", "A one-off project to set up your company: structure, policies, workflows, payroll. Priced by scope."],
  ["Data migration", "Moving employee records from spreadsheets or an older system. Priced by how much data you have and how clean it is."],
  ["Training", "Sessions for HR, payroll, managers and employees. Priced by groups and sessions."],
  ["Hosting", "Standard managed hosting is part of the subscription. Dedicated hosting is a scoped service with its own quote."],
  ["Support", "After go-live help, in the tier you choose. Channels, hours and response targets are set in your agreement."],
];

// The module-based plan builder. `tier` sets the smallest plan structure that contains the module.
export const planModules = [
  { key: "core-hr", label: "Core HR", tier: 0 }, { key: "leave", label: "Leave", tier: 0 }, { key: "attendance", label: "Attendance", tier: 0 }, { key: "self-service", label: "Employee and manager self-service", tier: 0 },
  { key: "payroll", label: "Payroll", tier: 1 }, { key: "workflows", label: "Approvals and workflows", tier: 1 }, { key: "reports", label: "Reports and analytics", tier: 1 },
  { key: "recruitment", label: "Recruitment", tier: 2 }, { key: "performance", label: "Performance", tier: 2 }, { key: "talent", label: "Talent and succession", tier: 2 }, { key: "learning", label: "Learning", tier: 2 },
  { key: "sso", label: "Single sign-on and provisioning", tier: 3 }, { key: "dedicated", label: "Dedicated hosting", tier: 3 },
];
export const planNames = ["Starter", "Growth", "Business", "Enterprise"];
export const employeeBands = [["1-50", "1 to 50", 1], ["51-200", "51 to 200", 2], ["201-500", "201 to 500", 3], ["501-1000", "501 to 1,000", 4], ["1000+", "More than 1,000", 5]];

// Approved prices. All null until the business approves them.
export const approvedPrices = {
  plans: { Starter: null, Growth: null, Business: null, Enterprise: null }, // each: { perEmployeeMonth, minimumMonthly, currency }
  implementation: null, // { fixed: {}, perDay: n, currency }
};

export const hostingOptions = [
  ["Standard managed hosting", "Your company runs in AiHxM's shared, managed environment, separated from other companies at the database level.", "Included in the subscription"],
  ["Dedicated hosting", "A separate environment for your company. A scoped service: location, plan and recovery arrangements are agreed in writing.", "Quoted separately"],
];

export const quoteWorkflow = [
  ["Scope conversation", "We ask about your employees, locations, modules, payroll and any integrations or hosting needs."],
  ["Written scope and assumptions", "We write down what is included, what you provide, and what we assumed."],
  ["Quotation", "A written quotation for subscription and services, using only approved rates."],
  ["Your review", "Your finance, IT and legal reviewers go through it. We answer security and data questions in writing."],
  ["Agreement", "Terms, hosting arrangements and support tier are agreed in writing before work starts."],
  ["Kick-off", "Implementation begins with the discovery phase."],
];

// ---- implementation ----
// `ours` = what AiHxM does. `yours` = what the customer provides. No durations: a timeline depends on scope and on how
// quickly the customer's team can answer, so it is set in the project plan, not on the website.
export const phases = [
  { key: "discovery", name: "Discovery", why: "Agree what will be set up, from what, and by whom.",
    ours: ["Run workshops on your structure, policies and approval paths", "Write the scope, assumptions and open questions", "Agree the project plan with you"],
    yours: ["Name a project owner and decision-makers", "Share current policies, org chart and sample payslips", "Tell us about devices, banks and other systems involved"],
    out: ["Written scope and assumptions", "Project plan", "Data and system inventory"] },
  { key: "hr-config", name: "HR configuration", why: "Set up the company so it matches how you work.",
    ours: ["Configure organisation, jobs, locations, leave policies, attendance rules, roles and workflows", "Set up forms, documents and starter holiday calendars", "Walk you through the configuration"],
    yours: ["Confirm policy choices and approvers", "Check each area with your own scenarios", "Confirm holiday dates, including moon-dependent ones, when announced"],
    out: ["A configured company workspace", "Configuration record", "Signed-off test scenarios"] },
  { key: "migration", name: "Employee migration", why: "Bring your people records across cleanly.",
    ours: ["Map your fields to AiHxM", "Run bulk import with row-level checks", "Report errors and what came across"],
    yours: ["Provide the data and correct errors we report", "Review a sample and the final result", "Confirm the migration is complete"],
    out: ["Field-mapping sheet", "Import error report", "Reviewed employee records"] },
  { key: "payroll-setup", name: "Payroll setup", why: "Express your pay rules in the system.",
    ours: ["Build salary structures and formulas", "Enter the tax and contribution settings your accountant confirms", "Design payslips and configure the payment file layout your bank accepts"],
    yours: ["Provide salary structures, allowances and deductions", "Have your accountant confirm tax and statutory settings", "Provide your bank's file layout"],
    out: ["Salary structures and formulas", "Statutory settings record, confirmed by your accountant", "Payslip design"] },
  { key: "parallel", name: "Payroll parallel testing", why: "Compare AiHxM with your current payroll before you trust it.",
    ours: ["Run one or more payrolls in parallel", "Show every difference with its calculation", "Correct configuration where the difference is ours"],
    yours: ["Provide the current payroll's results for the same period", "Decide which differences are right", "Approve the result"],
    out: ["Comparison report", "List of resolved differences", "Your written approval to go live"] },
  { key: "training", name: "User training", why: "Show each group what it needs.",
    ours: ["Run sessions for HR, payroll, managers and employees", "Practise on your own configuration"],
    yours: ["Release people to attend", "Nominate internal champions"],
    out: ["Training sessions", "Quick-reference material for each group"] },
  { key: "go-live", name: "Go-live", why: "Switch from the old way to the new one, deliberately.",
    ours: ["Run a readiness check with you", "Open access to employees and managers", "Be available for questions during the first run"],
    yours: ["Approve go-live", "Stop using the old process for the migrated areas", "Review the first live payroll"],
    out: ["Go-live checklist", "First live payroll review"] },
  { key: "post-launch", name: "Post-launch support", why: "Keep things working after the project ends.",
    ours: ["Answer questions in the support tier you chose", "Help adjust configuration after real use"],
    yours: ["Raise questions through the agreed channel", "Tell us what real use has shown"],
    out: ["Support in your agreed tier", "Configuration adjustments"] },
];

export const packages = [
  { name: "Core HR launch", phases: ["discovery", "hr-config", "migration", "training", "go-live", "post-launch"], for: "Employee records, leave, attendance and self-service." },
  { name: "Payroll launch", phases: ["discovery", "payroll-setup", "parallel", "training", "go-live", "post-launch"], for: "Payroll with a parallel run before the first live month." },
  { name: "Full launch", phases: ["discovery", "hr-config", "migration", "payroll-setup", "parallel", "training", "go-live", "post-launch"], for: "HR and payroll together." },
];

// ---- support tiers ----
// PROPOSED structure. `channels`, `hours` and `response` stay null until the business approves them; the page then says
// "defined in your agreement" instead of inventing a commitment.
export const supportTiers = [
  { key: "standard", name: "Standard", covers: ["Questions about using the platform", "Help with configuration", "Fixes for faults in the product"], channels: null, hours: null, response: null },
  { key: "priority", name: "Priority", covers: ["Everything in Standard", "A named contact", "Faster routing of urgent payroll-period issues"], channels: null, hours: null, response: null },
  { key: "dedicated", name: "Dedicated", covers: ["Everything in Priority", "Scheduled reviews", "Support arrangements shaped to a larger or multi-site company"], channels: null, hours: null, response: null },
];
