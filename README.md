# BoostFactor

Multi-tenant HR, payroll, attendance, and performance management platform
for Pakistan SMBs — an affordable, locally-compliant counterpart to SAP
SuccessFactors.

This repo is the real product codebase (not the clickable prototype). The
full architecture and phase plan live in the `BoostFactor` Claude Project
as `claude/development-plan.md`; the reasoning behind every irreversible
technical call lives in [`DECISIONS.md`](./DECISIONS.md); operational
concerns — security hardening, dependency vulnerabilities, deferred
performance work — are tracked in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).

**Current phase: Phase 6 — WRICEF Framework Skeleton (complete).**
Exit criterion: Phase 4/5's own `dummy_records` scaffolding can be routed
through a tenant-defined 2-step approval chain, including a
forced-timeout escalation — proven by an automated test the same way
Phases 4 and 5 were (see Decision #6).

All six WRICEF pillars from the plan doc's Section 6 now exist:
Workflows (a generic approval-routing engine with SLA escalation),
Enhancements (tenant-defined custom fields, JSONB-backed), Interfaces
(notification dispatch — logged/stubbed, not yet wired to a real
provider), Conversions (CSV import/export, validated row-by-row with a
real per-row error report), and Forms (`{{field}}`-substitution document
templates). Reports (the field-permission-aware report builder) is
deferred until Phase 14 (BI & Analytics) actually needs it — nothing yet
generates reports to build a builder for.

Before this, a security & quality audit pass (post-Phase 5) closed a
stale wide-open CORS default, added security headers (helmet) and rate
limiting (global + a stricter per-route limit on every auth endpoint,
specifically closing an MFA brute-force gap), and fixed an N+1 query
pattern in the field-permission engine. Full writeup for both — including
dependency vulnerabilities deliberately deferred with reasoning and
revisit triggers — in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).

## Stack

| Layer | Choice |
|---|---|
| Database | Postgres (Supabase-managed in staging/prod; local Postgres for dev) — raw SQL migrations, no ORM (Decision #2) |
| Auth | Real self-hosted auth now — bcrypt passwords, mandatory TOTP MFA, account lockout, password reset (see `apps/api/src/auth`, Decision #3). Swappable for Supabase Auth later without touching RLS or claims |
| File storage | Supabase Storage — wired when a module needs it |
| Business-logic API | NestJS (TypeScript) — owns module licensing (`apps/api/src/entitlements`, Decision #5), RBAC (`apps/api/src/rbac`, Decision #4), field permissions, and the WRICEF framework (`apps/api/src/workflow`, `custom-fields`, `notifications`, `document-templates`, `import-export`, Decision #6) |
| Background jobs / SLA timers | `@nestjs/schedule` cron sweep for now, not Redis + BullMQ — see Decision #6 for why, and when that changes |
| Frontend | React + Vite + Tailwind + React Router, Apple HIG design tokens |
| Monorepo | Turborepo (npm workspaces) |

See `DECISIONS.md` Decision #1 for why the backend splits between Supabase
infrastructure and a NestJS business-logic layer with RLS as
defense-in-depth, Decision #2 for why the database layer is raw SQL
migrations + `pg` rather than an ORM, Decision #3 for why Phase 3 builds
genuine self-hosted authentication now instead of waiting on a Supabase
project that doesn't exist yet, Decision #4 for the RBAC/field-level
permission engine's design — most-permissive combination across roles,
safe-deny by default, and why Platform Admin has no bypass — and Decision
#5 for the module-licensing gate that now runs in front of it: a disabled
module 404s rather than 403ing or degrading, and `tenant_module_entitlement`
is the only table it ever reads from — and Decision #6 for the WRICEF
Workflow engine's design (a plain DB sweep instead of BullMQ/Redis for SLA
escalation, and why `manager_of_submitter` approval routing waits for
Phase 7's employee hierarchy).

## Repo layout

```
apps/
  api/
    migrations/       Hand-written SQL migrations (tables + RLS policies together)
    src/
      auth/           Real auth: password + mandatory TOTP MFA, lockout, password reset (Decision #3)
      database/       pg Pool, per-request tenant-context (RLS claims), migration runner, bootstrap seed script
      companies/      Platform Admin API: create/list/config/admins/impersonate/admin-login-creation
      platform-admins/ Our own ops team's accounts: list/create/lock
      audit/          Append-only audit log service + endpoint
      rbac/           can()/resolveFieldAccess()/filterRecordFields() engine, roles + role-assignment API (Decision #4)
      entitlements/   isModuleEnabled() licensing gate, checked before RBAC everywhere (Decision #5)
      workflow/       Generic tenant-configurable approval-routing engine + SLA escalation (Decision #6)
      custom-fields/  Tenant-defined custom fields on any object (WRICEF Enhancements)
      notifications/  Notification dispatch log — logged/stubbed, no real provider wired yet (WRICEF Interfaces)
      document-templates/ {{field}}-substitution document generation (WRICEF Forms)
      import-export/  Generic CSV parse/validate/generate utility (WRICEF Conversions)
      dummy/          Proof-of-concept object every engine above (RBAC, licensing, workflow, import/export) is proven against, pending Employee Core (Phase 7)
  web/
    src/
      pages/          Login (multi-step: password/MFA/reset), Dashboard, Create Company, Company Config, Audit Log, Platform Admins
      auth/           Token storage + auth context
      api/            Typed fetch client against the API
packages/
  shared-types/       TypeScript types shared between api and web
```

## Getting started

Requires Node 20+, Docker (or a local Postgres 16 + Redis 7 if you'd
rather not use Docker — that's what this environment used to verify
everything, since Docker-in-Docker wasn't available here).

```bash
# 1. Install dependencies
npm install

# 2. Start local Postgres + Redis
docker compose up -d

# 3. Copy env defaults (matches docker-compose.yml)
cp .env.example .env
cp .env.example apps/api/.env
# Then change JWT_SECRET, MFA_ENCRYPTION_KEY, and the PLATFORM_ADMIN_BOOTSTRAP_*
# values to real values — the checked-in defaults are dev-only placeholders,
# not secrets.

# 4. Apply database migrations (creates tables, the app_role login, and
#    every RLS policy in one step)
npm run migrate --workspace=@boostfactor/api

# 5. Bootstrap the very first Platform Admin account (idempotent — safe to
#    re-run; does nothing once PLATFORM_ADMIN_BOOTSTRAP_EMAIL already exists)
npm run seed --workspace=@boostfactor/api

# 6. Run everything (API on :4000, web on :5173)
npm run dev
```

Open http://localhost:5173 and sign in with `PLATFORM_ADMIN_BOOTSTRAP_EMAIL`
/ `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD`. The first sign-in walks through
mandatory MFA enrollment (scan the QR code with any authenticator app, or
enter the secret manually) before issuing a session — MFA is not optional
for either admin tier. From there: create a company, add a Company Super
Admin, give them a login from the Admins tab, and add more Platform Admins
from the Platform Admins page. Create a second company and you'll see the
Dashboard list both — the isolation between them is enforced two rows down
in Postgres via Row Level Security, not just by the screen: see
`apps/api/migrations/0001_platform_admin_core.sql` and
`0002_auth_identity.sql`'s policies, and `DECISIONS.md` Decision #1 for why
that matters.

Forgot your password? Use "Forgot your password?" on the login screen.
Phase 3 has no email/SMS dispatch yet (that's Phase 6's WRICEF Interfaces
work), so outside production the reset token is handed back directly in
the response and pre-filled in the form — clearly labeled as dev-mode
only, never done in production (see `AuthService.requestPasswordReset`).

## Connecting a real Supabase project

Local Postgres is a stand-in. To point this at a real Supabase project
once one exists: create the project, copy its connection strings into
`DATABASE_URL` and `APP_DATABASE_URL` in `apps/api/.env` (Settings →
Database → Connection string), then run the migrations and seed script
again. The SQL itself doesn't change — see Decision #1's portability note.
Swapping the `user_accounts` table this repo builds today for Supabase
Auth's `auth.users` as the identity source of truth is a Decision #3-scoped
follow-up once the project exists; nothing about RLS or `RequestClaims`
changes either way. This needs the project owner's own Supabase account —
provisioning it hasn't happened yet.

## What's next

Phase 7 — Employee Core: org chart, employee master data, document
vault, job history, and employee-number assignment per plan doc Section
5. The first real HR module — everything before this was infrastructure.
See `claude/development-plan.md` Section 7 for the full phase plan.
