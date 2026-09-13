# BoostFactor

Multi-tenant HR, payroll, attendance, and performance management platform
for Pakistan SMBs — an affordable, locally-compliant counterpart to SAP
SuccessFactors.

This repo is the real product codebase (not the clickable prototype). The
full architecture and phase plan live in the `BoostFactor` Claude Project
as `claude/development-plan.md`; the reasoning behind every irreversible
technical call lives in [`DECISIONS.md`](./DECISIONS.md).

**Current phase: Phase 1 — Infrastructure Setup.**
Exit criterion: `npm run dev` boots an empty API and web shell against a
live database.

## Stack

| Layer | Choice |
|---|---|
| Database | Postgres (Supabase-managed in staging/prod; local Docker for dev) |
| Auth | Supabase Auth (JWT, MFA, OTP) — wired in Phase 3 |
| File storage | Supabase Storage — wired when a module needs it |
| Business-logic API | NestJS (TypeScript) — owns RBAC, field permissions, workflow engine, WRICEF framework |
| Background jobs | Redis + BullMQ |
| Frontend | React + Vite + Tailwind (+ shadcn/ui as screens need it), Apple HIG design tokens |
| Monorepo | Turborepo (npm workspaces) |

See `DECISIONS.md` Decision #1 for why this split (Supabase for
infrastructure, NestJS for business logic, Row Level Security as
defense-in-depth) was chosen over a fully custom backend.

## Repo layout

```
apps/
  api/    NestJS business-logic API (Prisma against Postgres)
  web/    React + Vite + Tailwind web shell
packages/
  shared-types/   TypeScript types shared between api and web
```

## Getting started

Requires Node 20+, Docker.

```bash
# 1. Install dependencies
npm install

# 2. Start local Postgres + Redis
docker compose up -d

# 3. Copy env defaults (matches docker-compose.yml)
cp .env.example .env
cp .env.example apps/api/.env

# 4. Generate the Prisma client and push the baseline schema
npm run prisma:generate --workspace=@boostfactor/api
npx prisma db push --schema apps/api/prisma/schema.prisma

# 5. Run everything (API on :4000, web on :5173)
npm run dev
```

Open http://localhost:5173 — it should show a green "OK" card fetched live
from the API's `/health` endpoint. That round trip is Phase 1's entire
exit criterion.

## Connecting a real Supabase project

Local Docker Postgres is a stand-in. To point this at a real Supabase
project once one exists: create the project, copy its connection string
into `DATABASE_URL` in `apps/api/.env` (Settings → Database → Connection
string), and fill in `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY`. This needs the project owner's own Supabase
account — provisioning it is a Phase 1 task that hasn't happened yet.

## What's next

Phase 2 — the Platform Provisioning Panel (company creation, company
config, module entitlements, audit log) — is the first phase that writes
real tenant-scoped tables and RLS policies on top of this scaffold. See
`claude/development-plan.md` Section 7 for the full phase plan.
