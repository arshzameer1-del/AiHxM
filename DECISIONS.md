# BoostFactor — Decisions Log

Every architecture-level decision that would be expensive to reverse gets
recorded here: what was decided, why, and what alternatives were rejected.
This log is append-only — never edit a past decision, add a new one that
supersedes it and link back.

---

## Decision #1 — Supabase for infrastructure, NestJS for business logic, RLS as defense-in-depth (not the only guard)

**Date:** Phase 1, Infrastructure Setup
**Status:** Accepted

### Context

Two documents in the project pointed in different directions on the backend:

- The original build roadmap called for a fully custom backend — hand-rolled
  auth, hand-rolled multi-tenancy, a hand-rolled `can()` RBAC engine. Total
  control, but everything is undifferentiated heavy lifting before a single
  HR feature exists.
- A later backend-architecture brief called for Supabase (Postgres + Row
  Level Security + Supabase Auth) to own tenant isolation and auth outright.

Building a genuine multi-tenant SaaS platform for Pakistan SMBs — with
per-company module licensing and per-company WRICEF extensibility — needs
both a fast path to real infrastructure and a place for HR-specific
business rules (object permissions, field-level visibility, workflow
routing) that are too complex and too testable to live only as SQL policy
expressions.

### Decision

Use both, each for what it is good at:

- **Supabase is the infrastructure layer**: managed Postgres, managed auth
  (JWTs, password/MFA, magic links, OTP for field staff without reliable
  email), managed file storage (documents, CNIC copies, CVs, logos), and
  realtime subscriptions where useful.
- **Row Level Security (RLS) is a second, database-level line of defense**
  on every tenant-owned table. Every such table carries a `company_id`
  column and an RLS policy restricting rows to
  `company_id = auth.jwt() ->> 'company_id'`. Even if application code has
  a bug and forgets to filter by `company_id`, the database itself refuses
  to return another tenant's rows.
- **A dedicated NestJS API service sits between the frontend and Supabase's
  Postgres**, and owns the actual HR business logic: the `can(user,
  permission, target)` object-permission engine, the
  `resolveFieldAccess(user, field, record)` field-level engine, the
  workflow/approval engine, and the WRICEF extensibility framework. RLS
  backs this up; it does not replace it.

### Why

The permission model this product needs is real business logic with real
edge cases: "a Manager sees their team's salary only if the tenant
specifically grants `salary.view.team`," "CNIC is visible to HR Admin and
to the employee themselves, to nobody else," "show Termination Reason only
when Status = Terminated," dynamic target populations, temporary
acting-manager grants, most-specific-match-wins conflict resolution.
Cramming all of that into SQL policy expressions is how a permission bug
becomes invisible until a Manager sees someone else's salary. That logic
needs a real test suite (a "should allow" and "should deny" test per
permission), and that means it needs to live in application code, not
database policy.

Net effect versus the fully-custom original plan: stop building auth,
tenant-DB-provisioning, and file storage from scratch — always
undifferentiated heavy lifting, and Supabase gives it away for free. Keep
building the actual product: the permission engine, the workflow engine,
the WRICEF framework, and the nine HR modules.

### Alternatives considered

- **Fully custom backend (original plan).** Rejected as the sole approach
  — maximum control, but months of auth/multi-tenancy plumbing before any
  HR feature ships, all of it in a space (auth, tenant DB isolation) that
  managed providers solve well already.
- **Supabase + RLS only, no separate API service.** Rejected — RLS is a
  real safety net but the wrong place to encode field-level conditional
  visibility, workflow routing, and cross-object business rules; that
  pushes complex, hard-to-test logic into SQL policy expressions.

### Consequence — deployment portability is a first-class constraint

Because a client may eventually require an AWS-hosted or self-hosted
backend (bank/regulated-client data residency is a live concern for
Pakistani clients), the NestJS API layer is built to only ever assume "a
Postgres database" and "an auth provider issuing a JWT with a `company_id`
claim" — it never assumes it is specifically talking to Supabase's managed
cloud. Supabase Auth and Supabase Storage are the only genuinely
Supabase-specific surfaces anywhere in the plan; both are thin, swappable
edges (self-hosted Supabase on the client's own AWS account, or a full
native-AWS re-platform to Cognito/RDS/S3), not load-bearing walls. Full
reasoning: `claude/development-plan.md`, Section 9, in the BoostFactor
project.

### What this unblocks

Phase 1 (this phase) stands up the monorepo, CI, and local Postgres/Redis
against this architecture. Phase 2 (Platform Provisioning Panel) is the
first phase that writes real tenant-scoped tables and RLS policies against
it.

---

## Decision #2 — Raw SQL migrations + `pg`, not Prisma, for the database layer

**Date:** Phase 2, Platform Provisioning Panel
**Status:** Accepted

### Context

Phase 1's schema was scaffolded through Prisma, on the assumption it would
carry the whole project as a type-safe ORM. Two things surfaced once Phase
2 needed to actually write tenant-scoped tables and Row Level Security
policies:

1. **Prisma's schema language cannot express RLS policies at all.** RLS
   lives entirely outside `schema.prisma` — every real Prisma+RLS project
   ends up hand-writing the policy SQL anyway, usually as a raw-SQL
   migration step bolted on beside Prisma's generated migrations. Section
   2 of the plan makes RLS a load-bearing part of the architecture (a
   second, database-level line of defense), not a nice-to-have, so the
   tool that owns "what the schema looks like" needs to own the policies
   too, not treat them as an afterthought in a different file.
2. **Prisma's CLI needs to download a native schema-engine binary from
   `binaries.prisma.sh`** to run `generate` or `migrate`. In this build
   environment that host is blocked by network policy, and `prisma
   generate` fails outright. That is an environment-specific trigger, but
   it generalizes: enterprise and regulated clients — banks, in
   particular, already flagged as a live sales target in Pakistan — run
   locked-down networks and CI runners themselves. A tool whose core
   workflow silently depends on reaching one specific external binary
   host is a fragile thing to build a client-facing product's schema
   pipeline on.

### Decision

Drop Prisma. The database layer is now:

- **Hand-written SQL migration files** (`apps/api/migrations/NNNN_*.sql`),
  applied in order by a small, dependency-free runner
  (`apps/api/src/database/migrate.ts`) that tracks what's already applied
  in a `_migrations` table. Each migration owns its tables, indexes, *and*
  its RLS policies together, in one file, so the isolation rule for a
  table is never separated from the table's own definition.
- **`pg` (node-postgres) as the query layer**, used directly from NestJS
  services. No ORM abstraction between the API and the SQL — every query
  the API sends is visible in the codebase as SQL, which for a
  permission-and-isolation-critical system is a feature, not a gap: it
  means a reviewer checking "does this query filter by `company_id`" is
  reading the actual query, not trusting a query builder to have done it
  correctly underneath.

### Why this doesn't weaken anything from Decision #1

Decision #1 already committed to RLS as the database-level backstop and
the NestJS API as the sole owner of business logic on top of it. Nothing
here changes that split — it just removes a middle layer (the ORM) that
added a native-binary dependency without adding anything the RLS-heavy
schema in this project actually needed. Type safety across the API and
web app still comes from `packages/shared-types`, hand-written per
domain object as those objects are designed (starting with the Company /
CompanyConfig / AuditLog shapes in this phase) — slightly more manual
than generating types from a schema, but exact, and it costs nothing at
migration time.

### Alternatives considered

- **Keep Prisma, work around the download.** Rejected — there's no
  reachable mirror for the engine binary from this network, and even
  where it is reachable, Prisma still can't express RLS policies, so the
  raw-SQL escape hatch would be needed either way.
- **Drizzle ORM** (SQL-like query builder, no native binary, decent RLS
  ergonomics via raw policy blocks). A reasonable alternative; not chosen
  only because plain `pg` is simpler still for a schema this size right
  now and adds one fewer dependency. Worth revisiting once the number of
  tables and query call-sites grows enough that hand-written SQL starts
  costing real time — that's an ergonomics trade, not an architecture one,
  so revisiting it later is cheap.

### What this unblocks

Phase 2's `companies` / `company_config` / `company_admins` /
`platform_admins` / `audit_log` tables and their RLS policies ship as one
migration, verified against local Postgres in this same environment that
couldn't run Prisma's CLI at all.

---

## Decision #3 — Real self-hosted authentication now, not a placeholder waiting for Supabase

**Date:** Phase 3, Auth & Identity
**Status:** Accepted

### Context

The plan doc's Phase 3 row calls for wiring Supabase Auth: password/MFA,
JWTs carrying a `company_id` claim, and mandatory MFA for the Platform
Admin and Company Super Admin tiers. Provisioning an actual Supabase
project needs the account owner's own Supabase account and credentials,
which still doesn't exist (same blocker Decision #1 and the plan doc's
progress log already flagged for Phase 1). Phase 2 shipped with a single
shared dev-only platform-admin password specifically as a stand-in for
this, explicitly documented as temporary in code and in the plan doc.

Phase 3 cannot simply wait for that Supabase project to exist: the plan
doc's own exit criterion for this phase — "a locked/disabled account
cannot authenticate; a password reset never exposes the old credential" —
describes real per-account authentication behavior, not infrastructure
wiring. A shared dev password has no concept of "an account" to lock, and
nothing to reset.

### Decision

Build genuine, non-throwaway authentication against local/self-hosted
Postgres now, designed from the start to be swappable for Supabase Auth
later without touching `RequestClaims`, RLS policies, or
`runInTenantContext` (the portability discipline Decision #1 already
committed to):

- **`user_accounts`** table — the login identity, deliberately a separate
  object from the `platform_admins`/`company_admins` profile rows it
  links to via a new `user_account_id` column (migration
  `0002_auth_identity.sql`). This is also the first half of the
  User-vs-Employee identity split (plan doc Section 3): Employee (Phase 7)
  links to this same table rather than inventing its own identity concept.
- **Passwords**: bcrypt, 12 rounds (`apps/api/src/auth/password.ts`).
- **MFA is mandatory for both admin tiers**, no opt-out: TOTP via
  `otplib`, with the secret AES-256-GCM-encrypted at rest (scrypt-derived
  key from `MFA_ENCRYPTION_KEY` — `apps/api/src/auth/mfa-secret-crypto.ts`).
  A fresh account's very first successful password check always returns
  `mfa_setup_required`, never a bare session token.
- **Account lockout**, both manual (`status = 'locked'`, a Platform Admin
  action) and automatic (`locked_until` after 5 failed attempts, a
  15-minute cooldown) — either one blocks login outright, satisfying the
  "locked/disabled account cannot authenticate" half of the exit criterion.
- **Password reset**: single-use, SHA-256-hashed tokens (the raw token is
  never stored), 30-minute TTL, and requesting a new one invalidates any
  still-outstanding one. The old password hash is overwritten, never read
  back, logged, or returned anywhere — satisfying the "never exposes the
  old credential" half.
- **A two-step login flow** (`apps/api/src/auth/tickets.ts`): short-lived
  (5 min) JWTs carrying a `typ: "mfa_ticket"` discriminator hand state
  from password verification to MFA verification/enrollment, avoiding a
  server-side session table for what is otherwise a stateless API.
- **The `is_service` claim** (migration 0002's header comment,
  `tenant-context.ts`): login has a chicken-and-egg problem — verifying a
  password requires reading `user_accounts` before the caller has any
  valid session JWT to carry claims at all. `is_service` is how the API's
  own pre-authentication code (never a request handler acting on a
  client-supplied token) reaches those tables during that window. Every
  guard in this codebase builds `RequestClaims` field-by-field from a
  verified JWT's payload rather than spreading the decoded token
  (`PlatformAdminGuard`), so this claim can never be smuggled in through a
  client-supplied JWT — it only ever originates from a literal
  `{ is_service: true, ... }` object written in `auth.service.ts` or the
  bootstrap seed script.

### A bug this surfaced, and the fix

Running the real login flow end to end (not a hypothetical) crashed with
`invalid input syntax for type uuid: "auth-service"`. `user_accounts`'s
RLS policies (migration 0002) checked
`app.is_platform_admin() OR app.is_service() OR id = ...::uuid` — but
Postgres does not guarantee `OR` short-circuits its operands, so the
`::uuid` cast on the third operand still ran (and threw) even though
`is_service()` was already `true`, because `SERVICE_CLAIMS.sub` is the
literal string `"auth-service"`, not a UUID. Fixed in migration
`0003_fix_user_accounts_sub_cast.sql` by rewriting those two policies
around `CASE WHEN ... THEN true ELSE <cast> END`, which Postgres's own
docs recommend precisely for this "only evaluate this if that other thing
is false" shape (the same idiom as guarding a division by zero). This is
a database-level fix, not a call-site workaround — any future
`is_service`/`is_platform_admin` caller with a non-UUID `sub` hits the
same safety net, not the same crash.

### Why this doesn't weaken anything from Decision #1

Nothing here is Supabase-specific. `user_accounts`, the RLS policies, and
`runInTenantContext` all speak the same `request.jwt.claims` convention
Decision #1 already established. When a real Supabase project exists, the
standard move is to let Supabase Auth's `auth.users` become the identity
source of truth (`user_accounts.id` pointing at the same id, or folding
this table into the app-side profile pattern Supabase projects already
use) — a swap at the edge, not a rewrite of anything that reads claims.

### Alternatives considered

- **Keep the Phase 2 shared password until Supabase is provisioned.**
  Rejected — the exit criterion itself requires per-account lock/reset
  behavior that a shared password structurally cannot express.
- **A minimal fake "sessions" table instead of stateless MFA tickets.**
  Rejected as unnecessary complexity — a signed, short-lived JWT with a
  `typ` discriminator carries exactly as much state (which account, which
  step) with no additional table, no cleanup job, and no additional
  RLS surface to reason about.

### What this unblocks

Phase 3's exit criterion is verified end to end (see the plan doc's
progress log): the full password → MFA-enrollment → session flow, the
same flow on a second login (now MFA-required, not setup), automatic
lockout after 5 failed attempts, manual lock via the Platform Admin API,
password reset (old credential rejected, new one works, the token is
single-use), and RLS-level tenant isolation across the new
`user_accounts`/`password_reset_tokens` tables — verified both through
the real UI's own HTTP path and by calling `DatabaseService.withClaims()`
directly with a scoped claims object, the same two-level verification
standard Phase 2 set.

---

*Next decision goes here as Decision #4, appended below this line — never
inserted above it.*
