// Everything that is a business fact or a deployment setting lives here, so nothing is scattered through the pages.
// Values that must come from the owner are read from the environment at build time and are NEVER given a made-up default.

const env = process.env;

export const site = {
  name: "AiHxM",
  legalName: "AiHxM", // Replace with the registered company name once confirmed (used in the privacy notice).
  // The public address of the marketing site. Used for canonical links, the sitemap and social tags.
  url: (env.MARKETING_SITE_URL || "https://aihxm.com").replace(/\/+$/, ""),
  // Where the product itself lives. "Sign in" links go here.
  appUrl: (env.MARKETING_APP_URL || "https://app.aihxm.com").replace(/\/+$/, ""),
  // The API that stores demo requests (POST /public/demo-requests).
  apiUrl: (env.MARKETING_API_URL || "https://api.aihxm.com").replace(/\/+$/, ""),
  // Real contact mailbox. Deliberately empty unless the owner sets it: the site never shows an address nobody confirmed.
  contactEmail: (env.MARKETING_CONTACT_EMAIL || "").trim(),
  // Optional. Shown on the contact page only when set.
  contactPhone: (env.MARKETING_CONTACT_PHONE || "").trim(),
  // Set to "true" to let search engines index the site. Anything else keeps every page noindex (safe for previews).
  indexable: env.MARKETING_INDEXABLE === "true",
  // The privacy notice is a plain-language draft until a lawyer has reviewed it. Set to "true" once that has happened;
  // until then the page carries a visible notice saying so.
  privacyReviewed: env.MARKETING_PRIVACY_REVIEWED === "true",
  tagline: "HR, attendance and payroll, connected in one platform",
  description:
    "AiHxM is an HR, attendance and payroll platform built for Pakistani businesses. One employee record feeds leave, attendance, payroll, approvals and reports.",
};

export const nav = [
  {
    label: "Platform",
    href: "/platform/",
    children: [
      { label: "Platform overview", href: "/platform/", note: "How the modules fit together" },
      { label: "Core HR", href: "/platform/core-hr/", note: "Records, organisation, history" },
      { label: "Payroll", href: "/platform/payroll/", note: "Six-step monthly run" },
      { label: "Time & attendance", href: "/platform/attendance/", note: "Clock, shifts, timesheets" },
      { label: "Leave", href: "/platform/leave/", note: "Policies, balances, calendar" },
      { label: "Talent", href: "/platform/talent/", note: "Hiring, goals, learning, expenses" },
      { label: "Workflows & approvals", href: "/platform/workflows/", note: "One inbox, every decision logged" },
      { label: "Self-service", href: "/platform/self-service/", note: "Employee and manager home pages" },
      { label: "Reports & analytics", href: "/platform/reporting/", note: "What you can see today" },
    ],
  },
  { label: "Pakistan payroll", href: "/pakistan-payroll/" },
  { label: "Who it's for", href: "/industries/" },
  { label: "Security", href: "/security/" },
  { label: "Pricing", href: "/pricing/" },
  { label: "Resources", href: "/resources/" },
];

export const footerColumns = [
  {
    title: "Platform",
    links: [
      ["Platform overview", "/platform/"],
      ["Core HR", "/platform/core-hr/"],
      ["Payroll", "/platform/payroll/"],
      ["Time & attendance", "/platform/attendance/"],
      ["Leave", "/platform/leave/"],
      ["Talent", "/platform/talent/"],
      ["Workflows & approvals", "/platform/workflows/"],
      ["Self-service", "/platform/self-service/"],
      ["Reports & analytics", "/platform/reporting/"],
    ],
  },
  {
    title: "Solutions",
    links: [
      ["Pakistan payroll", "/pakistan-payroll/"],
      ["Who it's for", "/industries/"],
      ["Integrations", "/integrations/"],
      ["Pricing & deployment", "/pricing/"],
    ],
  },
  {
    title: "Company",
    links: [
      ["About", "/about/"],
      ["Security & trust", "/security/"],
      ["Resources", "/resources/"],
      ["Contact & FAQ", "/contact/"],
      ["Privacy notice", "/privacy/"],
    ],
  },
];
