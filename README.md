# BoostFactor

Multi-tenant HR, payroll, attendance, and performance management platform
for Pakistan SMBs — an affordable, locally-compliant counterpart to SAP
SuccessFactors.

This repo is the real product codebase (not the clickable prototype). The
full architecture and phase plan live in the `BoostFactor` Claude Project
as `claude/development-plan.md`; the reasoning behind every irreversible
technical call lives in [`DECISIONS.md`](./DECISIONS.md).

**Current phase: Phase 2 — Platform Provisioning Panel.**
Exit criterion: a Platform Admin can create a new company end-to-end
through the real UI and it appears correctly isolated from every other
company — enforced by Postgres Row Level Security, not just application
code.

## Stack

| Layer | Choice |
|---|---|
| Database | Postgres (Supabase-managed in staging/prod; local Postgres for dev) — raw SQL migrations, no ORM (Decision #2) |
| Auth | Phase 2: one shared dev-only platform-admin credential (see `apps/api/src/auth`). Supabase Auth (JWT, MFA, OTP) replaces this in Phase 3 |
| File storage | Supabase Storage — wired when a module needs it |
| Business-logic API | NestJS (TypeScript) — owns RBAC, field permissions, workflow engine, WRICEF framework |
| Background jobs | Redis + BullMQ |
| Frontend | React + Vite + Tailwind + React Router, Apple HIG design tokens |
| Monorepo | Turborepo (npm workspaces) |

See `DECISIONS.md` Decision #1 for why the backend splits between Supabase
infrastructure and a NestJS business-logic layer with RLS as
defense-in-depth, and Decision #2 for why the database layer is raw SQL
migrations + `pg` rather than an ORM.

## Repo layout

```
apps/
  api/
    migrations/   Hand-written SQL migrations (tables + RLS policies together)
    src/
      auth/       Phase 2 stand-in platform-admin login (JWT issue + guard)
      database/   pg Pool, per-request tenant-context (RLS claims), migration runner
      companies/  Platform Admin API: create/list/config/admins/impersonate
      audit/      Append-only audit log service + endpoint
  web/
    src/
      pages/      Login, Dashboard, Create Company, Company Config, Audit Log
      auth/       Token storage + auth context
      api/        Typed fetch client against the API
packages/
  shared-types/   TypeScript types shared between api and web
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
# Then change PLATFORM_ADMIN_DEV_PASSWORD and JWT_SECRET to real values —
# the checked-in defaults are dev-only placeholders, not secrets.

# 4. Apply database migrations (creates tables, the app_role login, and
#    every RLS policy in one step)
npm run migrate --workspace=@boostfactor/api

# 5. Run everything (API on :4000, web on :5173)
npm run dev
```

Open http://localhost:5173, sign in with `PLATFORM_ADMIN_DEV_PASSWORD`,
and create a company. Create a second one and you'll see the Dashboard
list both — that's the UI half of the exit criterion. The isolation half
is enforced two rows down in Postgres, not just by this screen: see
`apps/api/migrations/0001_platform_admin_core.sql`'s RLS policies, and
`DECISIONS.md` Decision #1 for why that matters.

## Connecting a real Supabase project

Local Postgres is a stand-in. To point this at a real Supabase project
once one exists: create the project, copy its connection strings into
`DATABASE_URL` and `APP_DATABASE_URL` in `apps/api/.env` (Settings →
Database → Connection string — the owner/service-role string for
`DATABASE_URL`, and a scoped connection for `APP_DATABASE_URL` once
Phase 3 wires Supabase Auth roles in), then run the migration again. The
SQL itself doesn't change — see Decision #1's portability note. This
needs the project owner's own Supabase account — provisioning it hasn't
happened yet.

## What's next

Phase 3 — Auth & Identity: replace the Phase 2 shared dev password with
real Supabase Auth, wire JWT `company_id` claims from actual sessions
instead of a hand-signed token, add the User-vs-Employee identity split,
and enforce MFA for Platform Admin and Company Super Admin tiers. See
`claude/development-plan.md` Section 7 for the full phase plan.
