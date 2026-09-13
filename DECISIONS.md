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

*Next decision goes here as Decision #2, appended below this line — never
inserted above it.*
