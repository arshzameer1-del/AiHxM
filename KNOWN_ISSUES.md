# Known issues & audit log

This file tracks *operational* concerns — security hardening, dependency
vulnerabilities, performance risks, things intentionally deferred — as
opposed to [`DECISIONS.md`](./DECISIONS.md), which is reserved for
architecture-level decisions that are expensive to reverse. Anything here
can, in principle, change without touching the architecture.

Format: each entry says what the concern is, what (if anything) was done
about it, and — for anything deferred — the reasoning and the condition
that should trigger revisiting it.

## 2026-09 — Phase 5 security & quality audit

Triggered by an explicit self-review pass after Phase 5 shipped (module
licensing), before starting Phase 6. Below is everything found, in two
groups: fixed now, and deliberately deferred.

### Fixed

**CORS was wide open to every origin.** `main.ts` shipped in Phase 1 as
bare `app.enableCors()` with a comment promising it would be "locked down
... once real auth exists." Phase 3 built real auth and this was never
revisited — a genuine regression, not a documented tradeoff. Fixed:
`CORS_ORIGIN` is now a comma-separated allowlist env var, defaulting to
the local Vite dev origin only (`http://localhost:5173`), never to
"allow everything." Documented in `.env.example`. Verified with real
`curl` calls: a request with `Origin: http://localhost:5173` gets
`Access-Control-Allow-Origin` echoed back; a request with
`Origin: http://evil.example.com` gets no such header at all.

**No security headers.** Nothing set HSTS, `X-Content-Type-Options`,
`X-Frame-Options`, etc. Fixed: added `helmet()` as the first thing
`bootstrap()` does in `main.ts` (`helmet@^8.3.0`, framework-agnostic, no
coupling to the pinned `@nestjs/*` `^10.4.x` versions). Verified with
`curl -D -` against `/health`: `Strict-Transport-Security`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and
`X-DNS-Prefetch-Control: off` are all present.

**No rate limiting anywhere.** Every endpoint, including the entirely
public auth flow, could be hit at unlimited speed. Fixed in two layers:
- A global default guard (`@nestjs/throttler@^6.5.0`, `ThrottlerModule`
  registered in `app.module.ts` as `{ name: "default", ttl: 60_000,
  limit: 100 }`, applied via `APP_GUARD`) — a generic abuse guard on
  every route.
- A stricter per-route override on every `AuthController` endpoint
  (`@Throttle({ default: { limit: 10, ttl: 60_000 } })`, `5/min` on
  `password-reset/request` specifically to blunt email-enumeration/spam).
  This closes a real, specific gap: `AuthService`'s account lockout
  (5 failed attempts / 15-min cooldown) only protects a *known* account's
  password. It does nothing for (a) a horizontal sweep of login attempts
  across many harvested emails, or — the sharper issue — (b) brute-forcing
  a TOTP code. An `mfa_ticket` is issued right after a correct password
  check and is valid for 5 minutes; the code space is only 1,000,000
  combinations; `verifyMfa`/`confirmMfaEnrollment` had *zero*
  attempt-limiting of their own. Without a throttle, an attacker who
  already has a valid password could try all 1,000,000 codes inside that
  5-minute window with nothing stopping them, defeating MFA's purpose as
  an independent second factor. At 10/min, an attacker gets ~50 guesses
  in that window — infeasible — while a real user fat-fingering a code
  twice never notices.

  Verified with real HTTP calls: 12 rapid `POST /auth/login` requests
  returned `401` for requests 1–10 and `429` for requests 11–12 — the
  limit trips exactly where configured, not approximately. A follow-up
  request to `/auth/mfa/verify` in the same window returned `401`, not
  `429`, confirming each route has its own independent bucket rather than
  sharing one counter.

**N+1 queries in the RBAC field-permission engine.**
`RbacService.filterRecordFields()` was calling `resolveFieldAccess()`
once per sensitive field, and each call did its own DB round trip — so
`DummyService.list()` issued up to `N records × M sensitive fields`
separate queries. Harmless at Phase 5's tiny `dummy_records` test
volumes, but a real scaling concern once Phase 7 (Employee Core)
introduces real row counts and a wider set of sensitive fields (salary,
CNIC, bank details, etc.).

Fixed: added a private `resolveFieldAccessBatch()` that fetches every
`field_permission_rules` row applicable to *any* of a record's sensitive
fields in one query (`field_key = ANY($4::text[])`), then evaluates
conditions and picks the most-permissive access level in memory —
exactly the logic `resolveFieldAccess()` already had, just batched.
`resolveFieldAccess()` itself is untouched: it's still the public
single-field API and still covered standalone by
`rbac.service.spec.ts`. This turns each `filterRecordFields()` call from
`2 + M` queries into 3 (the `.self`/`.all` object-level checks, plus one
batched field query), regardless of how many sensitive fields the object
has. All 31 existing tests (`entitlements.service.spec.ts`,
`dummy.e2e.spec.ts`, `rbac.service.spec.ts`) still pass unchanged.

### Deferred (documented, not fixed)

**Record-level N+1 still exists.** `DummyService.list()` calls
`filterRecordFields()` once per row, so the `.self`/`.all` object-level
`can()` checks still run once per record even though the caller's
granted scope doesn't actually vary per record — only the ownership
match (in-memory) does. Fully collapsing this means hoisting those
`can()` checks out of the per-record loop and changing
`filterRecordFields()`'s call sites, which is a larger, riskier change
than this audit's scope justified for a proof-of-concept object with a
handful of test rows. **Revisit when:** Phase 7 (Employee Core) is built
— design its list-endpoint permission checks to fetch the caller's
granted scope once per request up front, and have this fix ride along
rather than being bolted onto `dummy`.

**`npm audit` reports 24 vulnerabilities (7 high, 13 moderate, 4 low,
0 critical) that all require a forced major-version bump to fix** (a
plain `npm audit fix` makes zero changes — confirmed via `git status` on
the lockfiles). Each was checked for actual reachability in this
codebase rather than reflexively forced:

- `multer` (high, via `@nestjs/platform-express`) — DoS/resource-exhaustion
  advisories. `grep` confirms multer/file-upload is not used anywhere yet
  (no `FileInterceptor`, no upload endpoint exists). Dormant. **Revisit
  when:** the first file-upload endpoint is built (Supabase Storage
  integration, per the README's "wired when a module needs it" note) —
  upgrade `@nestjs/platform-express` (and re-verify the rest of the
  pinned `@nestjs/*` `^10.4.x` family still works with it) at that point,
  not before.
- `qs` (moderate, same Express/Nest dependency chain) — same reasoning,
  same trigger condition as multer.
- `@nestjs/core` / `@nestjs/platform-express` / `@nestjs/common` /
  `@nestjs/testing` (moderate/high) — the advisories here are the multer
  and `qs` ones surfacing again through the dependency graph, plus one
  "improperly neutralizes special elements in output" advisory on
  `@nestjs/core` itself tied to a `file-type` transitive dependency,
  which is also unused (no file-type-sniffing code in this repo).
  Forcing these to their fixed versions means jumping to `@nestjs/*` v12,
  a major-framework upgrade with its own migration effort — not something
  to do as a side effect of a routine audit. **Revisit when:** doing a
  deliberate, tested `@nestjs/*` major-version upgrade as its own planned
  piece of work, or when the multer/file-upload trigger above forces the
  question anyway.
- `tmp`, `webpack`, `glob`, `inquirer`, `external-editor`,
  `@angular-devkit/*`, `@nestjs/schematics`, `picomatch`, `ajv` (mostly
  via `@nestjs/cli` → `@angular-devkit/schematics-cli` → `inquirer` →
  `external-editor` → `tmp`, and separately via `webpack`) — this entire
  chain is `@nestjs/cli`, dev-only build tooling that never ships to
  production. The `webpack` advisory specifically is in its `buildHttp`/
  module-federation feature, which this project doesn't use at all
  (no module federation config anywhere in the repo). Low priority.
  **Revisit when:** `@nestjs/cli` ships a non-major patch that pulls
  these in as a side effect (cheap to just re-check periodically), or as
  part of the same planned `@nestjs/*` v12 upgrade above.
- `react-router` / `react-router-dom` (moderate) — open redirect via
  backslash in `<Link>`/`useNavigate`, and an SSR hydration constructor-
  injection advisory. Checked every `Link`/`Navigate`/`useNavigate` call
  site in `apps/web/src` via `grep`: every target is either a hardcoded
  literal route or built from a server-generated UUID (`company.id`),
  never raw user input — and the app is client-side-rendered only, no
  SSR, so the hydration advisory doesn't apply to this app's deployment
  shape at all. Both non-exploitable in this app's actual surface today.
  **Revisit when:** any future page ever builds a route/redirect target
  from raw user input (a "redirect back to where you came from" query
  param, for instance) — that's the point this stops being theoretical,
  regardless of whether the upgrade has happened yet. React Router v7 is
  a real migration, not a patch bump.
- `esbuild` / `vite` (moderate/high) — dev-server-only advisories (a
  malicious website could read responses from the Vite dev server, or
  bypass `server.fs.deny` on Windows). Only reachable while `npm run dev`
  is running and someone visits a malicious page in the same browser at
  the same time; doesn't affect any built/production artifact. Low
  priority for a team developing behind normal network hygiene.
  **Revisit when:** doing a deliberate Vite major-version upgrade, or
  immediately if development ever happens on an untrusted/shared network.

**Password-reset dev-mode token gating was checked, not a gap.**
`AuthService.requestPasswordReset` already correctly withholds the raw
reset token outside `NODE_ENV === "production"`
(`const devModeToken = process.env.NODE_ENV === "production" ? undefined
: rawToken;`) — confirmed by reading the code, not assumed. Listed here
only so it's clear this was checked during the audit, not missed.

## 2026-09 — Phase 6 dependency addition

Adding `@nestjs/schedule@3.0.4` (Decision #6 in `DECISIONS.md` has the
full reasoning for why this package exists at all) moved `npm audit`'s
count from 24 to 26 findings, both newly-introduced and both checked the
same way as every other entry in this file — for actual reachability,
not reflexively force-upgraded:

- **`@nestjs/schedule` (moderate)** — the advisory here is `@nestjs/core`'s
  already-documented "improperly neutralizes special elements" finding
  (see the September audit above) resurfacing through a second dependency
  path now that `@nestjs/schedule` also depends on `@nestjs/core`. Same
  root cause, same dormant/unused-feature reasoning, same revisit
  trigger — not a second distinct problem.
- **`uuid` (moderate, transitive via `@nestjs/schedule`)** —
  "Missing buffer bounds check in v3/v5/v6 when `buf` is provided"
  (GHSA-w5hq-g745-h8pq), affecting `uuid@<11.1.1`; this project pulls in
  `uuid@9.0.1`. Checked via `grep` in `node_modules/@nestjs/schedule`:
  the only call site is `uuid_1.v4()`, called with zero arguments, to
  generate cron-job names. The vulnerable code path only triggers when a
  caller supplies their own output buffer to `v3`/`v5`/`v6` — `v4` isn't
  in the affected function list at all, and even it is never called with
  a buffer here. Dormant. **Revisit when:** upgrading `@nestjs/schedule`
  to a major version that changes its `uuid` usage (unlikely — job naming
  is not a moving part of that library), or as part of the same eventual
  `@nestjs/*` v12 upgrade already tracked above.

### Not yet investigated

Nothing else was in scope for this pass. The obvious next candidates for
a future audit, once Phase 6/7 land more surface area: request/response
payload size limits (helmet doesn't set these), structured audit logging
of authz denials (currently only the Platform Provisioning actions in
`AuditModule` are logged — RBAC/entitlement denials are not), and
dependency audit automation (this was done by hand; a CI job running
`npm audit --audit-level=high` on a schedule, rather than only during
manual audit passes like this one, would catch new advisories on
existing pins without waiting for the next manual pass).
