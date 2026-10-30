// Business facts and deployment settings. Values the owner must supply come from the environment and are NEVER given a
// made-up default: an unset contact detail simply does not appear on the site.
const env = process.env;
const clean = (v) => (v || "").trim();

export const site = {
  name: "AiHxM",
  display: "AI HXM",
  legalName: "AiHxM", // replace with the registered company name once confirmed
  url: (env.MARKETING_SITE_URL || "https://aihxm.com").replace(/\/+$/, ""),
  appUrl: (env.MARKETING_APP_URL || "https://app.aihxm.com").replace(/\/+$/, ""),
  apiUrl: (env.MARKETING_API_URL || "https://api.aihxm.com").replace(/\/+$/, ""),
  contactEmail: clean(env.MARKETING_CONTACT_EMAIL),
  contactPhone: clean(env.MARKETING_CONTACT_PHONE),
  whatsapp: clean(env.MARKETING_WHATSAPP).replace(/\D/g, ""),
  indexable: env.MARKETING_INDEXABLE === "true",
  privacyReviewed: env.MARKETING_PRIVACY_REVIEWED === "true",
  termsReviewed: env.MARKETING_TERMS_REVIEWED === "true",
  tagline: "Intelligent Human Capital Management",
  description:
    "AiHxM brings HR, payroll, attendance, leave, recruitment, performance and more into one connected platform, built for Pakistani businesses and configurable around the way you work.",
  // Social accounts appear in the footer only when an official account exists.
  social: [],
  publishedOn: "2026-10-30",
};
