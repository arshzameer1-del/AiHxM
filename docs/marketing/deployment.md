# Putting the marketing site on aihxm.com

Nothing here has been done. It needs the owner, because it touches DNS and the live app.

## Today

`aihxm.com` is the Cloudflare Pages project **aihxm** (the web app); `app.aihxm.com` also points at it. The API is
`api.aihxm.com` on Render.

## Target

- `aihxm.com`, `www.aihxm.com`: new Pages project **aihxm-site** (this marketing site).
- `app.aihxm.com`: the existing **aihxm** project (the product). Sign-in addresses become `app.aihxm.com/<company>/login`.
- `api.aihxm.com`: unchanged.

## Steps

1. **Cloudflare Pages, new project** `aihxm-site`, connected to the same GitHub repo, branch main.
   - Build command: `npm install && npx turbo run build --filter=@ai-hxm/marketing`
   - Build output directory: `apps/marketing/dist`
   - Root directory: empty (repo root)
   - Environment variables (see `apps/marketing/.env.example`): `MARKETING_SITE_URL=https://aihxm.com`,
     `MARKETING_APP_URL=https://app.aihxm.com`, `MARKETING_API_URL=https://api.aihxm.com`,
     `MARKETING_CONTACT_EMAIL` (when real), `MARKETING_INDEXABLE=true` (only at launch),
     `MARKETING_PRIVACY_REVIEWED=true` (after legal review).
   - First deploy gives an `*.pages.dev` address. Review it there first; it stays `noindex` until `MARKETING_INDEXABLE=true`.
2. **Before moving the domain**, update Render environment: `APP_BASE_URL=https://app.aihxm.com` (password-reset and payslip
   email links use it), and check `CORS_ORIGIN` contains `https://app.aihxm.com`, `https://aihxm.com` and
   `https://www.aihxm.com` (the demo form posts from the marketing origin).
   SSO return addresses configured with identity providers that point at `aihxm.com` must be changed to `app.aihxm.com`.
3. **Run the migration** `0163_demo_requests.sql` (deploy-latest.ps1 does this) and deploy the API, so the form endpoint exists.
4. **Move the domain.** In the old **aihxm** project remove `aihxm.com` and `www.aihxm.com` (keep `app.aihxm.com`); in
   **aihxm-site** add them. Cloudflare updates the DNS records for you when the zone is on Cloudflare.
5. **Old links.** The site's `_redirects` sends `/login`, `/<company>/login`, `/signup`, `/reset-password`, `/sso/*`,
   `/app/*` and the Platform Admin paths to `app.aihxm.com`. Test a real `aihxm.com/<company>/login` and a password-reset
   link after the move. Tell users who bookmarked `aihxm.com`.
6. **Optional email on new requests:** set `DEMO_NOTIFY_EMAIL` and the `SMTP_*` settings on Render. Without them requests
   are still saved and show under Platform Admin, Demo requests.
7. **Search engines:** after launch set `MARKETING_INDEXABLE=true`, redeploy, then submit `https://aihxm.com/sitemap.xml`
   in Google Search Console.

## Rollback

Move `aihxm.com` back to the **aihxm** project (it still serves the app at `/`). The API change is additive.

## Not included

A CAPTCHA (honeypot, per-minute and per-hour limits and duplicate suppression are in place; add Cloudflare Turnstile if
spam appears), analytics (the site sets no cookies), a staging domain.
