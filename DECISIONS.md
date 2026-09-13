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

*Next decision goes here as Decision #3, appended below this line — never
inserted above it.*
