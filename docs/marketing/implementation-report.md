# Marketing website: implementation report (BACKLOG36)

Date: 2026-10-23. Status: built and tested locally; **not deployed**, not on aihxm.com.

## What was built

- `apps/marketing`: a static, dependency-free site (20 pages plus a 404): Home, Platform overview, Core HR, Payroll,
  Time & attendance, Leave, Talent, Workflows & approvals, Self-service, Reports & analytics, Pakistan payroll, Who it's
  for, Pricing & deployment (no prices), Security & trust, Integrations, About, Book a demo, Resources, Contact & FAQ,
  Privacy notice.
- Positioning "HR, attendance and payroll, connected in one platform"; primary call to action "Book a Personalized
  Demo", secondary "Explore the Platform".
- Every capability carries a status label (Available, Needs your setup, Partly built, Not built yet). Gaps are
  listed on the Payroll, Pakistan payroll, Integrations, Reports and Security pages.
- Brand: the real AiHxM lattice mark and the blue (#2563EB) and violet (#7C3AED) of the Enterprise design system.
  Screens are shown in the Enterprise theme. The product's default "AiHxM Standard" theme is plum; the site uses the
  Enterprise look because it is the master design system's palette.
- Nine real screenshots of the running app (demo company "Sample Industries", 40 sample people). Company name and email
  domains in the seed data were replaced in the captures. Nothing is a mock-up.
- SEO: unique titles and descriptions, canonical, Open Graph and Twitter tags, a generated 1200x630 image, sitemap,
  robots.txt, `llms.txt`, JSON-LD (Organization, WebSite, SoftwareApplication, BreadcrumbList, FAQPage). Pages are
  `noindex` and robots.txt is closed until `MARKETING_INDEXABLE=true`.
- Security headers and a strict CSP in `_headers`; redirects for the old app addresses in `_redirects`.

## Demo request backend (new, in the API)

- Migration `0163_demo_requests.sql`: platform-level table, row-level security enabled and forced (service or Platform
  Admin only), stores a salted hash of the visitor address, never the address.
- `POST /public/demo-requests`: validation (class-validator, unknown fields rejected), privacy consent required,
  honeypot field, 5 per minute per address, 5 new requests per hour per address, same email within 24 hours counted
  instead of duplicated, optional email to `DEMO_NOTIFY_EMAIL` when SMTP is configured (a mail failure never fails the
  visitor's request).
- Platform Admin: `GET /platform/demo-requests`, `PATCH /platform/demo-requests/:id` (status, internal notes, audited)
  and a new "Demo requests" page in the Platform Admin console.

## Tests and measurements (all run locally)

- API: `demo-requests.e2e.spec.ts` 7/7 pass (save, validation, honeypot, duplicate, per-address cap, access control and
  RLS, list/filter/update); `rls-coverage.spec.ts` passes with the new table.
- Web: type-check clean. API: Nest build clean.
- Site check script: 21 HTML files, 1,099 internal references, no broken links, one h1 per page, alt text and
  dimensions on every image, labels on every form control, no inline script or style, no placeholder text.
- Form, in a real browser against the local API: field validation (nothing sent when invalid), successful save with a
  reference, the row in the database, offline error state, pre-selection from `?interest=`.
- Lighthouse (headless Chromium, mobile profile with simulated throttling, local static server, so network figures are
  optimistic; launch configuration `MARKETING_INDEXABLE=true`): Performance 99 to 100, Accessibility 98 to 100 (the
  98s were heading-order notes fixed afterwards and re-run clean on the affected pages, except Privacy which was fixed
  but not re-measured), Best Practices 100, SEO 100 on the 15 pages measured (home, platform, core HR, payroll, talent, Pakistan payroll, who it is for, pricing, security, integrations, about, resources, contact, demo form, privacy). LCP 1.5 to 2.0 s mobile, 0.4 s desktop,
  CLS 0, TBT 0. With the preview setting (noindex) SEO shows 66 to 69 only because the page is deliberately blocked.
- Layout at 375 px: no horizontal scroll on any page measured; tables turn into stacked cards.

## Still needed from the owner

1. A real contact email (and phone if wanted): `MARKETING_CONTACT_EMAIL`. Until then the site shows none.
2. Pricing: the site says pricing is quoted on request. Confirm you are ready to respond to that.
3. Legal review of the privacy notice; set `MARKETING_PRIVACY_REVIEWED=true` afterwards. The registered company name for
   `legalName` in `src/site.config.mjs`.
4. About page: team, story, location. Only the mission statement is on it because nothing else was confirmed.
5. SMTP settings and `DEMO_NOTIFY_EMAIL` on Render if you want an email for each new request.
6. The deployment steps in `deployment.md` (new Pages project, domain move, `APP_BASE_URL`, CORS).
7. Someone must actually answer demo requests: the confirmation message says we will email the visitor.

## Limits

- No CAPTCHA (honeypot, limits and duplicate suppression only).
- Screens are from a seeded demo company; the Attendance and Leave pages use a home page and a launchpad because richer
  data was not seeded. The payroll bank-file step in the seeded data shows missing account numbers, so no screenshot of
  the payment step is used.
- Lighthouse was not run against the deployed site (not deployed yet). Re-run after launch.
- English only. No Urdu.
- Competitor notes cover four sites; two (AidenHR, eHR) could not be used.
