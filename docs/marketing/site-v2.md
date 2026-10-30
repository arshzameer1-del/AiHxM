# Brand website (apps/site): scope, status and launch notes

Built 2026-10-30 from the "Ultimate Marketing Website" brief. It is a new app; `apps/marketing` was left as it was and can be
retired once this site is live.

## What exists

86 pages: home; platform overview; 22 product pages (all product areas plus Employee and Manager Self-Service); 8 solution and
8 industry pages with their hubs; services hub and 8 service pages; 4 Pakistan pages; resources hub, blog with 10 articles,
topic pages, knowledge center and FAQs; pricing, integrations, about, contact, book a demo, security, privacy, terms and a 404.
Also sitemap, robots, `llms.txt`, a search index for the site search, `_headers` (CSP, caching) and `_redirects`.

Design: the product's own palette (purple, plum, magenta, indigo, teal, soft pink), Bricolage and Inter, real product
screenshots from the demonstration company, glass cards and a parallax hero, 22 custom animated module icons, mega menus, a
lifecycle tab strip, a payroll-step tab strip, a module filter and counters. Motion is restrained and turned off for reduced
motion. Without JavaScript everything is still readable.

## Verified (local, 2026-10-30)

- `npm run test`: 87 HTML files, about 15,000 internal references, 87 unique titles, content rules all pass.
- axe-core (WCAG 2 A/AA, 2.1 AA, best practice) on 16 representative pages at 1440 and 390 wide: no violations.
- Lighthouse on this machine (simulated throttling, preview build): home mobile 90 / desktop 100 performance, accessibility
  100, best practices 100; payroll page mobile 97; demo page mobile 99. SEO 92-93 only because the preview is `noindex`.
- Lead form against the local API: validation, a saved request (confirmed in `demo_requests`), network failure and server
  error shown as "nothing has been sent".
- No-JavaScript and reduced-motion modes checked.

Not measured: real-device testing, Safari, production network speed, production API CORS.

## Before it goes live

1. Deploy the Form designer (FORMDESIGN1) and the GAPC builds first. The site describes the Form Designer and the Talent,
   Surveys, Recognition and Help desk areas. Do not publish ahead of the product.
2. Confirm each capability status in `flags.mjs` against `capability-inventory.md`; add the Oct 30 features there.
3. Owner decisions: legal company name (`site.config.mjs`), contact email, phone, WhatsApp, social accounts, services scope,
   pricing publication.
4. Legal review of the privacy and terms templates, then set `MARKETING_PRIVACY_REVIEWED` and `MARKETING_TERMS_REVIEWED`.
5. Articles are short (about two minutes each). They carry no tax or contribution rates by design. Have an editor extend them.
6. New Cloudflare Pages project, build `npm install && npx turbo run build --filter=@ai-hxm/site`, output `apps/site/dist`.
   Environment as in `apps/site/.env.example`. Follow `deployment.md` for the domain move, CORS and the redirect checks.
   `MARKETING_INDEXABLE=true` only at launch.
7. The CSP allows inline `style` attributes (needed by the icon animation delay and card tilt variables) and one inline
   script by hash. Moving those into the stylesheet would allow a stricter policy.

## Deliberately not on the site

Competitor names and comparisons, customer logos, testimonials, statistics, ratings, certifications, uptime figures, support
hours and SLAs, prices, statutory rates, claims of government filing or named-bank file formats, a newsletter form, case
studies, webinars, careers.
