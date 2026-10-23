# AiHxM marketing site (aihxm.com)

A static site with no framework and no runtime dependencies. `scripts/build.mjs` turns the page modules in `src/pages`
into plain HTML in `dist/`, with hashed CSS, JS, fonts and images, a sitemap, `robots.txt`, `llms.txt`, Cloudflare
`_headers` and `_redirects`.

```
npm run build -w @ai-hxm/marketing     # build into apps/marketing/dist
npm run check -w @ai-hxm/marketing     # metadata, headings, images, links, forbidden placeholder text
npm run dev   -w @ai-hxm/marketing     # build, then preview on http://127.0.0.1:4321
```

Local preview against a local API and app:

```
MARKETING_API_URL=http://localhost:4000 MARKETING_APP_URL=http://localhost:5173 npm run dev -w @ai-hxm/marketing
```

(add `http://127.0.0.1:4321` to the API's `CORS_ORIGIN` for that.)

## Rules for content

- `docs/marketing/capability-inventory.md` is the source of truth. A feature may be described only if that table lists
  it, and with its status (Available / Needs your setup / Partly built / Not built yet).
- Screenshots in `src/assets/screens` are real captures of the running app with the seeded demo company (sample people,
  sample numbers, company name and email domains replaced). No stock photos, no mock-ups.
- No invented customers, logos, quotes, statistics, certifications or prices.
- Business facts (contact email, phone, legal name) come from `.env`/`src/site.config.mjs`, never hard-coded in a page.

## Layout

- `src/site.config.mjs` settings, navigation, footer
- `src/layout.mjs` page shell, head metadata, JSON-LD, shared components
- `src/pages/*.mjs` one module per page; `_product.mjs` is the shared product-page template
- `src/styles.css`, `src/app.js` (menu and demo form, no dependencies)

See `docs/marketing/deployment.md` for putting it on aihxm.com.
