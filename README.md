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

**Current phase: Phase 10 — Recruitment & Onboarding (complete).** Exit
criterion: a job requisition can be created and routed through a real
tenant-defined approval chain (the Phase 6 workflow engine, reused
completely unchanged — no new approver type needed this phase, unlike
Phase 9), a candidate can be moved through a real forward-only Kanban
pipeline (`applied` → `screening` → `interview` → `offer`, plus
`rejected`), an offer can be extended and either declined or accepted,
and accepting an offer creates a real Employee record — via
`EmployeesService.create()`, the second real caller of Phase 7's Employee
Number assignment machinery — all proven against real Postgres with no
mocks, plus a real-HTTP e2e round trip over the actual guards/controllers/
`ValidationPipe` stack (see Decision #10).

The interesting design question this phase turned out to hinge on wasn't
new engine capability (there is none — Section 10's "don't let the
workflow engine become over-general" guardrail cuts toward reusing what
already exists, not adding to it) but a genuinely new kind of
participant: a candidate has no login, no session, and no RBAC scope of
their own, so every permission check across requisitions, candidates,
applications, and offers is the recruiter's own `recruitment.manage.all`,
never a `.self`/`.team` scope. Offer acceptance surfaced a real,
documented cross-module permission coupling in the process — see
Decision #10 for the full writeup, including the honestly-tracked scope
limits (no candidate self-service portal, no notification dispatch on
pipeline events, forward-only Kanban moves) in `KNOWN_ISSUES.md`.

Before Phase 10, Phase 9 built Leave & Attendance — plan doc Section 7's
own **"real go/no-go checkpoint"**: a real leave request resolves its
policy via Phase 8's resolver, seeds and decrements a real leave balance,
routes for approval through a real tenant-configured workflow using a new
`manager_of_submitter` approver type (resolved against the Employee Core
hierarchy, correctly targeting the SUBJECT's manager even for an
On-Behalf submission), surfaces a non-blocking overlap notice for a
same-manager teammate's overlapping request, and a biometric/GPS/manual
attendance clock-in/out round trip works keyed off `employee_number` (see
Decision #9).

Before that, Phase 8 built Employee Groups & Leave Policy Config: a
tenant defines employee groups by attribute (department, location,
employment type), assigns a different leave policy to each, and a real
Employee record resolves to the correct policy automatically based on
which group(s) it matches — most-specific-match-wins, additive
combination per `policy_type`, and a safe-deny default policy fallback,
deliberately reusing Phase 4's own resolver pattern rather than inventing
a second one (see Decision #8).

Before that, Phase 7 built the first real HR module — an Employee
record gets a correctly tenant-scoped, immutable Employee Number assigned
automatically, appears on an org chart, has its sensitive fields (CNIC,
date of birth, salary band, bank account, Termination Reason) visible or
hidden per role exactly the way Phase 4's engine already proved for
`dummy_records`, can have a document attached to it, and has its job
history recorded — all verified end to end, including over real HTTP
against a live server, not just at the service layer (see Decision #7).
`employees`/`employee_documents`/`employee_job_history` are real,
RLS-protected tenant tables; three real RBAC roles (HR Admin, Line
Manager, Employee self-service) replace the Phase 4 demo roles for this
object, exercising a new `.team` scope (direct reports only) alongside
the existing `.self`/`.all`; a dedicated `employee_number_sequences`
table assigns Employee Numbers atomically per the plan doc's Section 5
rules, including preserving a legacy number on import and advancing the
sequence past it; and a swappable `FileStorageService` (local-filesystem
today, Supabase Storage/S3 later behind the same interface) backs the
document vault.

Before that, Phase 6 built all five buildable WRICEF pillars (Workflows,
Enhancements, Interfaces, Conversions, Forms — Reports waits for Phase 14
per Section 6), and a post-Phase-5 security & quality audit closed a
stale wide-open CORS default, added security headers (helmet) and rate
limiting (global + a stricter per-route limit on every auth endpoint,
specifically closing an MFA brute-force gap), and fixed an N+1 query
pattern in the field-permission engine — now fully resolved for a real
object by this phase's own list-endpoint design (Decision #7). Full
writeup for all of it — including dependency vulnerabilities deliberately
deferred with reasoning and revisit triggers, and the one deliberately
fixed this phase (multer's DoS advisories, once a real upload endpoint
existed to trigger that fix) — in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).

## Stack

| Layer | Choice |
|---|---|
| Database | Postgres (Supabase-managed in staging/prod; local Postgres for dev) — raw SQL migrations, no ORM (Decision #2) |
| Auth | Real self-hosted auth now — bcrypt passwords, mandatory TOTP MFA, account lockout, password reset (see `apps/api/src/auth`, Decision #3). Swappable for Supabase Auth later without touching RLS or claims |
| File storage | `FileStorageService` interface (`apps/api/src/file-storage`) — a local-filesystem implementation for now, Supabase Storage/S3 swappable in behind it later without touching callers (Decision #7) |
| Business-logic API | NestJS (TypeScript) — owns module licensing (`apps/api/src/entitlements`, Decision #5), RBAC (`apps/api/src/rbac`, Decision #4, extended with a `.team` scope in Decision #7), field permissions, the WRICEF framework (`apps/api/src/workflow`, `custom-fields`, `notifications`, `document-templates`, `import-export`, Decision #6, extended with `manager_of_submitter` routing in Decision #9), Employee Core (`apps/api/src/employees`, Decision #7), Employee Groups & Leave Policy Config (`apps/api/src/employee-groups`, Decision #8), Leave & Attendance (`apps/api/src/leave`, Decision #9), and Recruitment & Onboarding (`apps/api/src/recruitment`, Decision #10) |
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
is the only table it ever reads from — Decision #6 for the WRICEF
Workflow engine's design (a plain DB sweep instead of BullMQ/Redis for SLA
escalation, and why `manager_of_submitter` approval routing waits for
Phase 7's employee hierarchy) — Decision #7 for Phase 7's three real
calls: a dedicated `employee_number_sequences` table instead of a
`company_config` column (a real Postgres RLS-plus-`FOR UPDATE` gotcha
this phase ran into and fixed), the swappable `FileStorageService`
interface behind the document vault, and RBAC's new `.team` scope
(direct reports only, resolved generically by the caller rather than
`RbacService` knowing what an employee or a manager is) — and Decision #8
for Phase 8's resolution mechanism: most-specific-match-wins derived
structurally from condition count rather than a hand-set priority column,
additive combination independent per `policy_type`, and a database-
enforced "at most one default policy per tenant" invariant backing the
safe-deny fallback — and Decision #9 for Phase 9's three real calls:
`manager_of_submitter` as a workflow approver type resolved fresh per
instance against the Employee Core hierarchy (with a new
`subject_user_account_id` column so On-Behalf submissions route against
the actual employee, not the submitter), splitting
`EmployeeGroupsService.resolvePolicy()` into a thin admin-gated wrapper
and an ungated `resolvePolicyInternal()` for a real self-service caller,
and the leave/attendance schema's own tradeoffs (lazy balance seeding,
calendar-day counting, `employee_number`-keyed attendance) — and Decision
#10 for Phase 10's own calls: reusing the Phase 6 workflow engine
completely unchanged for requisition approval (no new approver type
needed), a forward-only Kanban pipeline where `hired` is reachable only
through accepting an offer, and offer acceptance as the second real
caller of Phase 7's Employee Number assignment (surfacing a documented
cross-module permission coupling between `recruitment.manage.all` and
`employee.manage.all`).

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
      file-storage/   Swappable FileStorageService interface + local-filesystem implementation (Decision #7)
      employees/      Employee Core: org chart, master data, document vault, job history, Employee Number assignment (Decision #7, plan doc Section 5)
      employee-groups/ Employee Groups & Leave Policy Config: attribute-based groups, leave policies, most-specific-match-wins resolution (Decision #8)
      leave/          Leave & Attendance: leave requests (policy resolution, balances, overlap notices, On-Behalf, `manager_of_submitter` routing) and biometric/GPS/manual attendance clock-in/out (Decision #9, plan doc Section 7's "real go/no-go checkpoint")
      recruitment/    Recruitment & Onboarding: requisition approval (reusing the workflow engine as-is), candidates, a forward-only Kanban pipeline, and offer extension/acceptance — the second real caller of Employee Number assignment (Decision #10)
      dummy/          Proof-of-concept object the RBAC/licensing/workflow/import-export engines were originally proven against, before Employee Core existed
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

Phase 11 — Performance & Goals (review cycles, calibration), per
`claude/development-plan.md` Section 7's own ordering. The technical
go/no-go caveat from Phase 9 still stands exactly as stated in Decision
#9 and `KNOWN_ISSUES.md`: every phase completed so far proves the
platform internally coherent enough to keep building on, not a
substitute for an actual pilot company's HR Admin, managers, and
employees using it for real. See `claude/development-plan.md` Section 7
for the full phase plan.
