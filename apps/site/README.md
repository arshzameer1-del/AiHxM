# @ai-hxm/site: the AiHxM brand website

A multi-page, data-driven static site (86 pages). No framework and no runtime dependencies: `node scripts/build.mjs` writes
`dist/`. It is separate from `apps/marketing` (the older single-purpose site) and from the product (`apps/web`).

```
npm run build -w @ai-hxm/site      # writes apps/site/dist
npm run check -w @ai-hxm/site      # metadata, links, headings, a11y structure, content rules (competitors, claims, rates)
npm run test  -w @ai-hxm/site      # build + check
npm run dev   -w @ai-hxm/site      # build + preview on http://127.0.0.1:4330
```

## Where things live

| Path | What it holds |
| --- | --- |
| `src/content/modules-a.mjs`, `modules-b.mjs` | The 22 product areas (one page each): problems, capabilities with status, use cases, flow, FAQs |
| `src/content/audiences.mjs` | 8 solutions and 8 industries |
| `src/content/services.mjs`, `pakistan.mjs`, `articles.mjs`, `misc.mjs` | Services, Pakistan pages, the 10 articles, FAQs, integrations, pricing structure, security list |
| `src/content/flags.mjs` | **Release flags and capability statuses.** The one place that decides what the site may claim |
| `src/content/catalog.mjs` | Registry that menus, cards, related links, sitemap and search read from |
| `src/pages/*.mjs` | Page templates. `src/lib/ui.mjs` building blocks, `layout.mjs` header, mega menus, footer |
| `src/styles.css`, `src/app.js` | Design system and behaviour (menus, search, tabs, filter, counters, lead form) |
| `src/assets/` | Fonts, brand marks and real product screenshots (demonstration company only) |

Adding a module, article, service or industry means adding an entry to a content file. Navigation, cards, sitemap and search
update by themselves.

## Honest status labels

A capability is written `"Name|setup"`. Statuses: `available`, `setup` (needs the company's own data, rates or devices),
`partial`, `upcoming`. `flags.overrides` changes a status for the whole site by feature name. Capability truth lives in
`docs/marketing/capability-inventory.md`.

Flags in `flags.mjs` keep unfinished areas out: `caseStudies`, `webinars`, `careers`, `newsletter`, `pricingPublished`,
`servicesApproved` are all `false` today. Contact email, phone and WhatsApp come from the environment and are hidden when unset.

## Environment (see `.env.example`)

`MARKETING_SITE_URL`, `MARKETING_APP_URL`, `MARKETING_API_URL`, `MARKETING_CONTACT_EMAIL`, `MARKETING_CONTACT_PHONE`,
`MARKETING_WHATSAPP`, `MARKETING_INDEXABLE` (only `true` at launch), `MARKETING_PRIVACY_REVIEWED`, `MARKETING_TERMS_REVIEWED`.

## Forms

The demo, contact and consultation forms post to `POST {API}/public/demo-requests` (the existing endpoint, with honeypot, rate
limit and duplicate suppression). The page shows "received" only when the server answers `ok` with a reference. The API
`CORS_ORIGIN` must include the site origin.

## Rules the check script enforces

No competitor names anywhere, no certification, uptime, support-hours, price or testimonial claims, no statutory rate, no
government-filing claim, no third-party product names on the integrations page, one `h1` per page, no skipped heading levels,
every image has alt text and size, every control has a label, internal and hash links resolve.
