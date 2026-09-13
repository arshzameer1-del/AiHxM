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

## Decision #4 — Two-tier RBAC (`can()` + `resolveFieldAccess()`), most-permissive combination, and no Platform Admin bypass

**Date:** Phase 4, RBAC + Field-Level Permission Engine
**Status:** Accepted

### Context

The plan doc's Section 2 enforcement order and Section 7 Phase 4 row call
for two distinct checks, not one: whether a user can touch an object at
all (`can(user, permission, target)`), and — separately — which of that
object's *fields* they can see or edit
(`resolveFieldAccess(user, field, record)`), including fields whose
visibility depends on another field's value (e.g. "show Termination
Reason only when Status = Terminated"). Section 3 also states plainly that
Platform Admin "never touches a tenant's HR data" — a real security
property, not a UI convenience, since Platform Admin accounts are Our
Company's own ops staff, not the client's.

Phase 4 has no real HR object yet (Employee Core doesn't exist until Phase
7), so this phase builds the engine and proves it against a purpose-built
`dummy_records` table rather than deferring the engine's own design and
test suite to whichever phase happens to need it first.

### Decision

- **`RbacService.can(claims, permissionKey, target?)`** — object/record
  level. Permission keys carry a `.self`/`.all` scope suffix
  (`dummy_record.view.self` vs `dummy_record.view.all`); `.self` also
  compares `target.ownerId` against the caller. Backed by
  `user_role_assignments` (which role(s) a user holds in a company) joined
  through `role_permissions` to the `permissions` catalog — both seeded by
  migration `0004_rbac.sql`, both Platform-Admin/service-write-only like
  every other catalog table in this schema.
- **`RbacService.resolveFieldAccess(claims, objectKey, fieldKey, record)`**
  — field level, independent of object-level access. Rules live in
  `field_permission_rules`, each scoped to a role + object + field, with
  an access level (`hidden` / `view` / `edit`) and an optional JSONB
  `condition` (e.g. `{"field": "status", "equals": "unlocked"}`) evaluated
  in application code, not SQL — Decision #1 already put conditional,
  hard-to-test business logic in the API layer rather than in policy
  expressions, and this is the same call.
- **Most-permissive combination across roles**: if a user holds multiple
  roles that each produce a result for the same field, the highest-ranked
  result wins (`hidden` < `view` < `edit`) — additive, never subtractive.
  Absent any matching rule, the default is `hidden` (safe-deny). Resolving
  two *conditional* rules on the *same* role that both match the same
  record ("most-specific-match-wins", the plan doc's own phrase) is an
  intentionally out-of-scope gap for this phase — none of the seeded demo
  roles produce that scenario, and it's flagged here rather than guessed
  at so it isn't rediscovered as a surprise later.
- **`RbacService.filterRecordFields(...)`** is the actual enforcement
  point services call before returning a record: it builds the response
  object key-by-key, only ever setting a sensitive field's key when its
  resolved access is not `hidden`. A hidden field's key is genuinely
  **absent** from `Object.keys()`/`JSON.stringify()` — never set to
  `null` — matching the exit criterion's literal wording ("absent from
  the raw API response," not "nulled out").
- **No Platform Admin bypass, structurally, not by convention.** A
  Platform Admin session's `RequestClaims.company_id` is always `null`
  (true since Decision #3). `user_role_assignments` rows always carry a
  real `company_id`, and SQL's `= NULL` is never true — so a Platform
  Admin session cannot match any role assignment in any tenant, in any
  query, ever. This was deliberately *not* built as
  `if (claims.is_platform_admin) return true` in `RbacService` — that
  would be one accidental line away from silently giving Our Company's
  ops staff god-mode over every client's HR data. The structural version
  can't be "fixed" into a bypass by someone who doesn't understand why it
  looks incomplete; a `describe("...no bypass")` test in
  `rbac.service.spec.ts` pins this down as intentional, not a gap someone
  should close.
- **`SessionGuard`** (`apps/api/src/auth/session.guard.ts`), new
  alongside `PlatformAdminGuard`: accepts any valid session JWT regardless
  of tier. RBAC governs ordinary end-user roles (Company Super Admin now;
  Employee/Manager once Phase 7 exists) — gating the demo endpoints behind
  `PlatformAdminGuard` would make it impossible to ever prove the "should
  allow" half of the test suite. Both guards keep the same discipline:
  `req.claims` is built field-by-field from the verified JWT
  (`sub`, `is_platform_admin`, `company_id ?? null`), never a spread of
  the decoded payload, so `is_service` can never be smuggled in through a
  client-supplied token.
- **`field_key` is the API-facing camelCase name, not the DB column
  name** (`testField`, not `test_field`). `RbacService` never sees a
  database column — only the keys of the already-mapped JS record object
  a service hands it — so the catalog has to speak that language too.

### A bug this surfaced, and the fix

The seed data in migration `0004_rbac.sql` was first written with
snake_case `field_key` values (`'test_field'`, `'secret_field'`),
matching the DB column names out of habit from writing the SQL right
above them. `resolveFieldAccess` calls always passed the camelCase names
services actually use, so no rule ever matched and every field silently
resolved to `hidden` — the safe-deny default masked the bug instead of
surfacing it as an error. Caught by the test suite itself (three
"should allow view" cases failed, expecting `"view"` and getting
`"hidden"`), fixed by editing migration 0004's seed `INSERT`s directly
(not a new migration — 0004 was still uncommitted/in-draft in this same
session, unlike migration 0003's fix-via-new-file for the already-shipped
migration 0002 in Decision #3) plus a one-time `UPDATE` against the
already-migrated dev database to match. The lesson generalizes: any table
whose rows describe *application-layer* keys (as opposed to columns of
some other table) needs its seed data reviewed against the application's
naming convention, not the schema's.

### A second bug this surfaced, unrelated to RBAC itself

Writing this phase's real Jest suite (`npm run test`, not just
`ts-jest --check`) surfaced two infrastructure gaps, both fixed as part
of this phase rather than worked around:

- **No DELETE grant/policy on `user_accounts` at all.** Migration 0002
  granted SELECT/INSERT/UPDATE only. Test-fixture cleanup needing to
  delete a user account hit "permission denied for table user_accounts" —
  a genuine product gap (no way to remove a compromised or
  mistakenly-created account, even at the DB layer), not just a test
  inconvenience. Closed by migration `0005_user_accounts_delete.sql`,
  Platform-Admin-or-service only, matching every other write surface in
  this schema.
- **Jest couldn't parse `otplib`'s dependency chain** (`@scure/base`,
  `@noble/hashes` ship ES modules) in any test that transitively imports
  `AuthModule` — which any full-app e2e test does. `ts-jest` only
  transforms this package's own `.ts` sources; `babel-jest` was added for
  matching `node_modules` packages, per Jest's documented escape hatch.
  That alone still failed with the exact same "Unexpected token export,"
  because this is a Turborepo monorepo: `@scure/base` resolves from the
  **hoisted root** `node_modules`, one directory above `apps/api`, and
  Babel's default config-file search is root-relative to the API
  package's own directory — it silently finds no config for a file
  outside that tree and "transforms" it with zero presets applied. Fixed
  by pointing `babel-jest` at `apps/api/babel.config.js` explicitly
  (`["babel-jest", { configFile: require.resolve("./babel.config.js") }]`
  in `jest.config.js`) instead of relying on Babel's own search. Any
  future package with the same shape (ships ESM, lives in the hoisted
  root, gets pulled in by a test) will hit this identically — the fix
  generalizes, the underlying cause (monorepo hoisting vs. package-local
  config search) does not go away.

### Why this doesn't weaken anything from Decisions #1–#3

RLS still backs every one of the new tables
(`roles`/`permissions`/`role_permissions`/`field_permission_rules`/
`user_role_assignments`/`dummy_records`) the same way every tenant-owned
table in this schema has since Decision #1 — RBAC is a second,
independent gate on top of RLS, not a replacement for it. Nothing here
touches `RequestClaims`, `runInTenantContext`, or the Supabase
portability story from Decision #1; the engine reads claims the same way
every other service does.

### Alternatives considered

- **A single `can()` check, with field visibility just another
  permission key** (e.g. `dummy_record.testField.view`). Rejected —
  doesn't model *conditional* field visibility (the Termination Reason
  case) without smuggling condition logic into the permission-key string
  itself, and conflates "can you see this record" with "can you see this
  specific field on it," which the exit criterion treats as genuinely
  separate questions.
- **`if (claims.is_platform_admin) return true` short-circuit in
  `can()`/`resolveFieldAccess()`.** Rejected outright — see "No Platform
  Admin bypass" above. The plan doc's Section 3 boundary is a promise to
  every client, not an implementation detail.

### What this unblocks

Phase 4's exit criterion — "a dummy record's test field is visible to one
role and absent from the raw API response for another, proven by an
automated test, not manual clicking" — is verified three ways: an
integration test suite against real Postgres
(`rbac.service.spec.ts`, 18 tests), a full-HTTP-stack e2e test through
actual guards/controllers (`dummy.e2e.spec.ts`, 4 tests), and a manual
run against a live `npm run dev` server with real `curl` calls (not just
supertest's in-process request) confirming the same four outcomes: 401
with no token, `testField`/`secretField` present in the full-access
role's raw JSON, both keys entirely absent (not null) in the view-only
role's raw JSON, and 404 (not 403) for a Platform-Admin-shaped token
probing a record it holds no role in. All 22 tests are wired into CI
(`.github/workflows/ci.yml`), which previously had no test step at all.
Phase 7 (Employee Core) is the first phase that points this engine at a
real HR object instead of `dummy_records`.

---

## Decision #5 — Real module licensing (`tenant_module_entitlement`) as the enforcement order's first gate, ahead of RBAC

**Date:** Phase 5, Module Provisioning & Licensing
**Status:** Accepted

### Context

Plan doc Section 4's enforcement order has always read "is the module even
licensed → can the role touch this object → which fields can they see →
does a sibling field's value hide this one" — but until this phase, the
first step didn't exist. `company_config.enabled_modules` (migration
0001) was seeded from day one with a comment admitting exactly this: "a
cached read view only... written directly by the Platform Admin panel
until [Phase 5] exists." Phase 4 built the second and third steps
(`can()`/`resolveFieldAccess()`) with no licensing gate in front of them
at all — a Platform Admin could uncheck every box on the Modules tab and
nothing downstream would notice.

### Decision

Three tables, named to match the plan doc's own Section 7 phase row
exactly (`apps/api/migrations/0006_module_entitlement.sql`):

- **`module_catalog`** — every module BoostFactor can license, including
  `dummy` (see "What this reuses," below).
- **`package_tier`** — the four sellable tiers, promoted from a bare
  CHECK-constrained string on `companies.package_tier` to a real catalog
  table (same column, same values, same tenant-facing behavior — only how
  "is this a real tier" gets enforced changes, from a CHECK to a foreign
  key). `package_tier_modules` hangs each tier's default module set off
  it.
- **`tenant_module_entitlement`** — the actual source of truth. This is
  the only table `EntitlementsService.isModuleEnabled()` ever reads.
  `package_tier`/`package_tier_modules` are a template, consulted exactly
  once, when a company is created — never on the request path. A Platform
  Admin can override a tenant's entitlement at any time independent of
  its tier (extra module without moving the whole plan, or the reverse);
  the tier is a starting point, not a ceiling.

`EntitlementsService.isModuleEnabled(claims, moduleKey)` is the gate
itself, and it runs *before* `RbacService.can()` in every module-owning
service — enforcement-order Section 4 spelled out from the start, now
actually built in that order rather than assumed. A missing entitlement
row (never seeded, or a catalog module retired after a tenant's row was
last touched) resolves to disabled — safe-deny, the same posture
`RbacService.resolveFieldAccess` already takes for an unmatched field.

**No Platform Admin bypass here either**, for the identical reason as
Decision #4: a Platform Admin session has no `company_id`, so
`isModuleEnabled` returns `false` immediately rather than checking
anything — Section 3's "never touches a tenant's HR data" includes never
getting to skip past its own licensing gate.

**A disabled module 404s, it does not 403 or silently degrade.** Section
4 states this outright ("it should look like the feature doesn't exist,
not like it exists and you're blocked"), and it's a real design choice
with a real alternative that was rejected: `DummyService.list()` throws
`NotFoundException` rather than returning an empty array when the module
is off, specifically because an empty array is genuinely ambiguous with
"this tenant just has no records yet" — the one response shape Section
4's own goal can't tolerate being confused with.

### What this reuses, and what it's honest about not building yet

`module_catalog` includes a `dummy` entry alongside the nine real
modules, gating Phase 4's `rbac-demo/dummy-records` endpoints — the exact
same reasoning as Phase 4's `dummy_records` table: Employee Core (the
first real module) doesn't exist until Phase 7, so this phase needs
something concrete and *running* to prove "disabled → 404" against,
rather than a table nothing ever queries. It was added to
`packages/shared-types`' `MODULE_KEYS` so the Company Config "Modules"
screen Phase 2 already built could toggle it with zero new UI — a
Platform Admin can watch the real API 404 by unchecking a box in the same
screen this exit criterion's automated tests exercise programmatically.

The exit criterion's other half — "makes it vanish from their app
switcher" — is honestly not fully provable yet: there is no tenant
workspace UI with an app switcher, because that starts at Phase 7
(Employee Core), the same gap Phase 2's "Login As" impersonation
disclosed for the same reason. What Phase 5 actually delivers and proves
is the API-side half in full: the endpoint a disabled module owns is
gone, not merely hidden behind a client-side check that a direct request
could route around.

### Why this doesn't weaken anything from Decisions #1–#4

`tenant_module_entitlement` is RLS'd exactly like every other tenant
table since Decision #1 (tenant-scoped read, Platform-Admin/service-only
write). Nothing here touches `RequestClaims`, `RbacService`, or the
Supabase portability story — this is a new, independent gate that runs
*before* Decision #4's engine, not a replacement for any part of it, and
a module being enabled says nothing about which records or fields within
it a given role can see.

### Alternatives considered

- **Keep `company_config.enabled_modules` as the only structure, skip a
  separate entitlement table.** Rejected — this is exactly the
  "cached read view... until Phase 5 exists" gap the schema already
  flagged; a JSONB array on a config row has no natural place to hang a
  module catalog, per-tier defaults, or `updated_at` history off of, and
  nothing enforces that its values are even real module keys.
- **Enforce module licensing only in RLS, no NestJS-side check.** Rejected
  for the same reason Decision #1 didn't put RBAC in RLS: "is this
  endpoint even licensed" is Section 4's most business-facing rule (a
  bank might contractually be entitled to nine modules exactly, no more)
  and belongs where it can be unit-tested and reasoned about in
  application code, with RLS as backstop, not as the only place it lives.
- **`if (claims.is_platform_admin) return true` shortcut in
  `isModuleEnabled`.** Rejected outright, same reasoning as Decision #4's
  identical rejection for `RbacService`.

### What this unblocks

Phase 5's exit criterion is verified two ways: an automated suite (31
tests total now — `entitlements.service.spec.ts`'s 9 new tests plus 2 new
`dummy.e2e.spec.ts` cases proving the live HTTP 404/200 flip) wired into
the same CI test step Phase 4 added, and a manual run against a live
`npm run dev` server driving the actual Platform Admin HTTP API end to
end (create a starter-tier company, confirm its seeded entitlement,
assign a role, create a record, disable `dummy` via the real Company
Config PATCH endpoint, watch `GET /rbac-demo/dummy-records` flip from 200
to 404 for the exact same caller and record, then re-enable and watch it
flip back). Phase 6 (WRICEF Framework Skeleton) and every product phase
from Phase 7 onward now has a real gate to register new modules against
instead of an unenforced placeholder.

---

## Decision #6: Phase 6's Workflow engine — a plain DB sweep instead of BullMQ/Redis, and what "skeleton" deliberately leaves out

**Context.** Plan doc Section 6 calls for a generic, tenant-configurable
approval-routing engine with SLA escalation ("sequential/parallel/
conditional steps, SLA escalation, delegate-on-leave"), and Section 8's
stack table names Redis + BullMQ for "Background jobs / SLA timers." This
phase builds the engine (`apps/api/src/workflow`,
`0007_wricef_workflow.sql`/`0008_workflow_seed.sql`) and has to decide
what actually drives the timeout.

**The call: `@nestjs/schedule`'s cron decorator plus a plain SQL sweep,
not BullMQ/Redis.** `WorkflowService.escalateOverdue()` is one query —
"every `workflow_step_approvals` row still `pending` past its `due_at`"
— run every 5 minutes by `WorkflowEscalationScheduler`
(`workflow.module.ts`). No queue, no Redis dependency, no job-retry
semantics to reason about. This is a real deviation from Section 8's
stack table, made the same way Decision #2 deviated from Prisma: because
the simpler tool is actually correct for what this phase needs, not
because the harder path was skipped.

**Why this is the right call, not a shortcut.** A single idempotent
sweep query has nothing a job queue adds value for: no retry-with-backoff
is needed (the query naturally reruns on the next tick and finds the same
row if it wasn't escalated), no distributed workers are coordinating
(one API instance, one Postgres), and the "job" itself is instantaneous
(a `date < now()` comparison, not a slow task worth queuing off the
request path). Introducing Redis and BullMQ now would mean a second piece
of infrastructure to run, monitor, and explain in the README's "Getting
started," for a capability a five-line cron handler already provides
correctly. `escalateOverdue()` is also directly callable — exactly how
`workflow.service.spec.ts`'s forced-timeout test proves it, by backdating
one row's `due_at` and calling the method once, rather than waiting on a
real timer or standing up a test Redis instance.

**What this doesn't close off.** Redis + BullMQ are still the right
tool the moment a real job needs retry semantics, backoff, or meaningful
work per job (sending an actual email through a rate-limited provider,
generating a real payslip PDF) — Phase 12's payroll runs or a real
notification-provider integration are the likely trigger for actually
standing up that infrastructure. Nothing in `WorkflowService`'s public
shape (`escalateOverdue(): Promise<number>`) would need to change if the
*caller* of that method later became a BullMQ repeatable job instead of
an `@nestjs/schedule` cron — the swap is at the scheduling layer, not the
engine.

**Dependency note.** `@nestjs/schedule@3.0.4` is the newest major
compatible with this project's pinned `@nestjs/core@^10.4.x` (v4+
requires Nest v11/v12). Its own `peerDependencies` ask for
`reflect-metadata@^0.1.12`; this project is on `0.2.2` (a transitive
`@nestjs/core` dependency, not something this project pins directly).
Installed with `--legacy-peer-deps` after confirming `reflect-metadata`'s
public API hasn't changed in a way `@nestjs/schedule` depends on (it
doesn't call anything version-sensitive — `Reflect.getMetadata`/
`defineMetadata`, stable since 0.1) and verifying the app actually boots
and the cron actually registers (`[InstanceLoader] ScheduleModule
dependencies initialized` in a live run), not just that npm's static
peer-version check would have blocked it. Same judgment call as
`@nestjs/throttler` in the Phase 5 audit pass.

**Two scope decisions the schema/engine make, stated here rather than
left implicit:**

- **`manager_of_submitter` is not a supported approver type yet.**
  `workflow_template_step_approvers.approver_type` only allows `role` and
  `specific_user` (`0007_wricef_workflow.sql`'s header comment has the
  full reasoning). Resolving "the submitter's manager" needs an
  employee/manager reporting hierarchy, and that hierarchy doesn't exist
  until Employee Core (Phase 7) defines it. Building it against no real
  hierarchy now would mean inventing a throwaway one and then replacing
  it — worse than waiting. **Revisit when:** Phase 7 ships the
  employee→manager relationship; adding a third `approver_type` value and
  a resolver that walks it is additive, not a breaking change to anything
  built now.
- **A step rejection fails the whole workflow instance immediately**,
  rather than only failing that one step and letting other in-flight
  parallel lines finish. This matches how a real rejected leave/expense
  request behaves (nobody expects the remaining approvers to still get a
  vote once one line has said no) and keeps the state machine's "what
  does 'rejected' mean" question answerable in one sentence. A workflow
  needing softer semantics (a rejection that only blocks *one branch* of
  a larger approval tree) is a real future requirement, not a
  hypothetical one, but nothing in Phase 4-6's actual BPDs needs it yet —
  per Section 10's own guardrail against over-building this engine.

**What this unblocks.** Phase 6's exit criterion is verified the same
way Phases 4/5 verified theirs: `workflow.service.spec.ts`'s 8 tests
against real Postgres (permission gate, the full 2-step sequential
chain, immediate-fail-on-rejection, the forced-timeout escalation
reassigning to a configured target who can then decide, and a
conditional step being skipped), plus a live-server boot confirming the
cron actually registers and the routes actually reject unauthenticated
callers. `custom-fields.service.spec.ts` (4 tests) and
`import-export.service.spec.ts`/`dummy-import-export.spec.ts` (7 tests)
cover this phase's three remaining WRICEF pillars with real database
round trips the same way. Notifications and Forms (document templates)
are simple enough — a straight INSERT, and a regex substitution — that
their own service methods are the whole implementation; they're
exercised through the same build/lint/test pass rather than needing
dedicated specs of their own. Phase 7 (Employee Core) and every phase
after it can now route a real object through a real tenant-configured
approval chain, attach tenant-defined custom fields to it, and generate a
templated document from it, instead of building each of those three
things bespoke per module.

---

## Decision #7 — Phase 7 (Employee Core): a dedicated employee-number-sequence table, a swappable file-storage interface, and a `.team` RBAC scope

**Date:** Phase 7, Employee Core
**Status:** Accepted

### Context

Employee Core is the first real HR object, and it needed three genuine
architectural calls the plan doc's Section 5/6/2 anticipated in prose but
none of Phases 1–6 had to actually build: an atomic, tenant-configurable
Employee Number sequence (Section 5); somewhere to put uploaded documents
before a real Supabase project exists (Section 6's Forms/document vault,
and the README's long-standing "File storage: Supabase Storage — wired
when a module needs it" note); and a Manager's "see your team, not the
whole company" visibility, which Section 2 names by example
("`salary.view.team`") but Phase 4's RBAC engine only ever built `.self`
and `.all`.

### Decision — 1: `employee_number_sequences` as its own table, not a `company_config` column

The natural design was a `next_employee_sequence` column on
`company_config`, incremented atomically via `SELECT ... FOR UPDATE`
inside the same transaction as the INSERT. Building it that way and
running it against a real tenant-scoped HR Admin session immediately
failed with "Company config not found" — not a permissions bug in the
usual sense, but a genuine Postgres RLS behavior worth recording: **`FOR
UPDATE`/`FOR SHARE` under row-level security is checked against the
table's UPDATE policy, not its SELECT policy**, because Postgres treats a
row lock as "like performing a trivial update." `company_config`'s UPDATE
policy (`0001_platform_admin_core.sql`) is deliberately Platform-Admin-
only — branding and the employee-number format itself are real settings,
not something every tenant session should be able to rewrite — so a
tenant-scoped `SELECT ... FOR UPDATE` against that table returns zero rows
even though the identical query without `FOR UPDATE` returns the row
fine. This was caught by the real Jest suite against live Postgres, not
inferred — every one of Phase 7's list/get/create tests failed identically
until this was traced down to the locking clause specifically (confirmed
by isolating `FOR UPDATE` in a throwaway script against the same fixture
data).

The fix: `employee_number_sequences (company_id PK, next_sequence)` is a
new, dedicated table holding nothing but an operational counter. Its own
RLS write policy is tenant-scoped (`company_id = app.current_company_id()`),
which is safe precisely because a counter carries none of the risk that
motivated locking down `company_config`'s own UPDATE policy — a tenant
incrementing their own sequence value can't touch branding, module
entitlement caches, or the number *format* itself, only how many numbers
have been handed out so far. `EmployeesService.assignEmployeeNumber`
lazily creates a company's counter row (`INSERT ... ON CONFLICT DO
NOTHING`, seeded from that company's own `employee_number_format.startingSequence`)
the first time it's needed, rather than requiring `CompaniesService.create`
to know this table exists.

### Decision — 2: `FileStorageService` — a local-filesystem stand-in behind an interface, not a raw multer disk write

The document vault needs *somewhere* to put file bytes today, and
Supabase Storage needs a real Supabase project that doesn't exist yet
(same "waiting on the account owner's own credentials" situation as
Decision #1's Supabase Auth/RLS split, and Decision #3's real-auth-now
call). Rather than writing directly to disk from `EmployeesService`
(coupling the document vault to "local filesystem" the same way a naive
implementation would couple it to "Supabase Storage" once that exists),
`apps/api/src/file-storage/file-storage.interface.ts` defines a three-
method `FileStorageService` interface (`save`/`read`/`delete`), and
`LocalFileStorageService` is its only implementation — writing under a
gitignored, company/employee-namespaced directory
(`FILE_STORAGE_LOCAL_DIR`, default `./storage-data`), with every path
segment either a caller-supplied UUID or a sanitized filename, so a
crafted filename can't traverse outside the configured base directory.
Swapping in a Supabase-Storage- or S3-backed implementation later is a new
class behind the same interface and a one-line change to
`file-storage.module.ts`'s provider — `EmployeesService` never changes.
This is Section 9's "no module depends on a Supabase-only convenience as
its only path" discipline applied *before* Supabase Storage is even wired
up once, rather than after the fact.

**A real, honest gap this leaves, not silently:** deleting a company (or
an employee) cascades the `employee_documents` *rows* via the database's
own `ON DELETE CASCADE`, but nothing calls `FileStorageService.delete()`
as part of that cascade — the underlying files are orphaned on disk.
Manually verified while testing this phase (a deleted fixture company's
uploaded file was still sitting under `storage-data/` afterward). Harmless
at dev/test scale and cheap to clean up by hand for now; genuinely wrong
once real client data and real deletion/GDPR-style purge requests exist.
**Revisit when:** building any real "delete a company" or "delete an
employee" product flow — that flow needs to enumerate and delete the
associated files through `FileStorageService` *before* (or alongside) the
DB-level delete, not rely on the database cascade alone.

### Decision — 3: RBAC's third scope, `.team` — direct reports only, resolved by the caller, not by RbacService

Section 2 names the exact permission (`salary.view.team`) a Manager needs,
but Phase 4's `can()`/`filterRecordFields()` only ever compared a record's
`ownerId` against `claims.sub` (the `.self` case). Rather than teaching
`RbacService` what an "employee" or a "manager" is, `.team` is resolved
the same generic way `.self` already is: the CALLER (here,
`EmployeesService`) resolves a `teamOwnerId` per record — the record's own
manager's `user_account_id`, via a self-join
(`LEFT JOIN employees mgr ON mgr.id = e.manager_id`) — and hands it to
`RbacService.can()`/`filterRecordFieldsWithScope()` exactly like an
`ownerId`. `RbacService` still knows nothing about employees, managers, or
org charts; it only ever compares an opaque id to `claims.sub`. This keeps
the engine as generic as Decision #4 originally built it, and means a
future object with its own notion of "team" (a project, a cost center)
reuses `.team` the same way, by resolving its own `teamOwnerId` the same
way — no changes to `RbacService` itself.

**Deliberately shallow, not recursive:** `.team` matches DIRECT reports
only — a Manager's manager doesn't see the whole reporting chain through
this scope, only their own direct reports do. A recursive "see your entire
subtree" scope is a real, plausible future need (a VP wanting their whole
department's view) but nothing in Phase 7's actual BPD needs it yet —
Section 10's guardrail against over-building ahead of an actual
requirement. **Revisit when:** an actual role in an actual BPD needs
multi-level visibility — the fix is a recursive CTE resolving every
manager in a caller's reporting chain into a set, compared the same way,
not a change to `can()`'s branching logic itself.

### A second N+1 fix, riding along with this phase as promised

The Phase 5 security audit's "Record-level N+1 still exists" entry
(`KNOWN_ISSUES.md`) explicitly said: "Revisit when Phase 7 (Employee Core)
is built — design its list-endpoint permission checks to fetch the
caller's granted scope once per request up front, and have this fix ride
along rather than being bolted onto `dummy`." `EmployeesService.list()`
does exactly that: `RbacService.resolveViewScope()` and
`loadFieldPermissionRules()` are each called ONCE per request (not once
per row), and `filterRecordFieldsWithScope()` evaluates every row's
visibility and field access from those two already-fetched results
in memory — zero further permission-holding queries per row, and the
field-rule evaluation itself (`evaluateFieldAccess()`) is now a pure,
no-DB-access function. `dummy_records`' own `filterRecordFields()` is left
exactly as it was (still one query per row) — this was never meant to be
retrofitted onto the scaffolding object, only built correctly for the
first real one, per the audit's own wording.

### Alternatives considered

- **Loosen `company_config`'s UPDATE RLS policy to also allow tenant-scoped
  writes**, instead of a new table. Rejected: RLS is coarse (whole-row),
  so this would let any tenant session rewrite branding and the employee-
  number *format* itself, not just advance a counter — a real regression
  against Section 4/5's "module licensing lives only in the entitlement
  layer" discipline extended to company settings generally.
- **A Postgres `SEQUENCE` object per company** for the employee number
  counter instead of a table row. Rejected for now: Postgres sequences
  aren't transactional (a rolled-back INSERT doesn't give its number
  back), which is fine for surrogate keys but wrong for a number a client
  may audit gaps in; a plain locked table row rolls back cleanly with the
  rest of the transaction, matching how `next_employee_sequence`'s
  "preserve imported numbers" advance-the-counter logic already needs
  transactional correctness anyway.
- **Write straight to Supabase Storage now**, provisioning a project just
  for file storage ahead of the rest of Supabase. Rejected: no Supabase
  project exists yet for any purpose (Decision #1/#3's standing
  situation), and doing it just for storage would create exactly the kind
  of Supabase-specific coupling Section 9 warns against — better to build
  the swappable interface once and wire the real backend when the rest of
  the Supabase migration happens, not piecemeal.

### What this unblocks

Phase 7's exit criterion is verified the same way every prior phase's was:
`employees.service.spec.ts`'s 12 tests against real Postgres (sequential
number assignment, the preserve-imported-numbers collision-avoidance
path, immutability under `update()`, HR Admin/Line Manager/Employee
field-visibility scopes including the Termination Reason conditional rule
from Section 2, the module-licensing 404 flip, org-chart construction
including the "invisible manager becomes a root" case, a real document
round-tripped through `LocalFileStorageService` byte-for-byte, and
auto-recorded job history on hire/transfer/termination alongside a manual
HR-logged entry) — plus a live `npm run dev` server driven with real
`curl` requests, including a real multipart file upload verified
byte-exact on download, the module-disable-to-404 flip over live HTTP,
and a token-less request confirmed as a real 401. Phase 8 (Employee
Groups & Leave Policy Config) and everything after it now has a real
employee object, a real org chart, and a real sensitive-field model to
build against — the workflow/custom-field/document-template engines from
Phase 6 can now route, extend, and template a real record instead of only
`dummy_records`.

---

*Next decision goes here as Decision #8, appended below this line — never
inserted above it.*
