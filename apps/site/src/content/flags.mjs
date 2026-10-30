// RELEASE FLAGS: the one place that decides what the public site may claim.
//
// Every capability on the site carries a status. A feature written as "Name|setup" in the content files takes the status
// after the bar; no bar means "available". `overrides` changes a status for the WHOLE site by feature name, without editing
// any page, so a feature that is pulled back (or finally released) is changed here only.
//
//   available    works in the product today
//   setup        "Configurable": works once the company enters its own data, rates, rules or settings
//   integration  "Requires external integration": needs a device, mail server, bank or system on the customer's side
//   partial      "Partially available": some of it works
//   dev          "In development": being built now (nothing is labelled this unless the owner confirms it)
//   upcoming     "Planned": on the list, not started: shown only when `showUpcoming` is true
//
// Source of truth for the statuses: docs/marketing/capability-inventory.md (kept in step with the code).

export const STATUS = {
  available: { label: "Available", tone: "ok", means: "Works in the product today." },
  setup: { label: "Configurable", tone: "setup", means: "Works once your company enters its own data, rates, rules or settings." },
  integration: { label: "Requires external integration", tone: "integ", means: "The product side works, but it needs something outside AiHxM: a device, a mail server, a bank or another system on your side." },
  partial: { label: "Partially available", tone: "part", means: "Some of it works today; the rest is not built." },
  dev: { label: "In development", tone: "dev", means: "Being built now. Not usable yet and not dated." },
  upcoming: { label: "Planned", tone: "soon", means: "On the list. Not started, not dated, and not promised." },
};
export const STATUS_ORDER = ["available", "setup", "integration", "partial", "dev", "upcoming"];

export const flags = {
  // Capability statuses are an INTERNAL readiness record (docs/internal/AIHXM_PRODUCT_LAUNCH_READINESS.md). The public site
  // presents the intended product and never shows these labels. Keep this false.
  showStatusLabels: false,
  showUpcoming: true,
  // Pages that exist as structure but have nothing real to show yet stay out of navigation and sitemap until switched on.
  caseStudies: false, // no customer has approved a story
  webinars: false, // none recorded
  careers: false, // "when available"
  newsletter: false, // no mailing service connected; the form is not rendered
  pricingPublished: false, // prices are not approved: the pricing page shows the quote route
  supportApproved: false, // support channels, hours and response targets are not approved: tiers show "agreed in your contract"
  servicesApproved: false, // services are proposed offerings; pages say scope and fees are agreed per engagement
  overrides: {
    // "Feature name": "partial",
  },
};

export function statusOf(name, declared = "available") {
  return flags.overrides[name] || declared;
}
