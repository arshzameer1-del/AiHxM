// RELEASE FLAGS: the one place that decides what the public site may claim.
//
// Every capability on the site carries a status. A feature written as "Name|setup" in the content files takes the status
// after the bar; no bar means "available". `overrides` changes a status for the WHOLE site by feature name, without editing
// any page, so a feature that is pulled back (or finally released) is changed here only.
//
//   available  works in the product today
//   setup      works once the company enters its own data, rates or devices
//   partial    some of it works
//   upcoming   planned, not in the product: shown only when `showUpcoming` is true
//
// Source of truth for the statuses: docs/marketing/capability-inventory.md (kept in step with the code).

export const STATUS = {
  available: { label: "Available", tone: "ok" },
  setup: { label: "Needs your setup", tone: "setup" },
  partial: { label: "Partly built", tone: "part" },
  upcoming: { label: "Upcoming", tone: "soon" },
};

export const flags = {
  showUpcoming: true,
  // Pages that exist as structure but have nothing real to show yet stay out of navigation and sitemap until switched on.
  caseStudies: false, // no customer has approved a story
  webinars: false, // none recorded
  careers: false, // "when available"
  newsletter: false, // no mailing service connected; the form is not rendered
  pricingPublished: false, // prices are not approved: the pricing page shows the quote route
  servicesApproved: false, // services are proposed offerings; pages say scope and fees are agreed per engagement
  overrides: {
    // "Feature name": "partial",
  },
};

export function statusOf(name, declared = "available") {
  return flags.overrides[name] || declared;
}
