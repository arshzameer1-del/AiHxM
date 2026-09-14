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

## Decision #8 — Employee Groups & Leave Policy Config: reusing Phase 4's resolver pattern instead of inventing a second one

**Context.** Plan doc Section 12 (Phase 8's own "immediate next action"
entry) is explicit and prescriptive in a way most phase descriptions
aren't: build a generic per-group policy resolution mechanism "that
reuses Phase 4's own resolver pattern — most-specific-match-wins,
additive combination, safe-deny default — rather than inventing a second
resolution algorithm for policies." `RbacService.resolveFieldAccess()`'s
own doc comment had already named "most-specific-match-wins" as a real
gap, deliberately left unbuilt for `field_permission_rules` ("a
documented gap for whenever a real module first needs it"). This is that
module — the first place in the codebase where two configured rules can
both structurally match the same record and something has to decide
which one actually wins, not just whether either wins.

**The call.** Three concrete pieces, each mapped onto Phase 8's actual
schema (`0012_employee_groups_leave_policy.sql`, `0013_employee_groups_seed.sql`,
`apps/api/src/employee-groups/`):

1. **Most-specific-match-wins.** An `employee_group` is defined by one or
   more ANDed `employee_group_conditions` rows. A group's specificity is
   simply `COUNT(*)` of its own conditions — no separate priority column
   to keep in sync by hand, and no ambiguity about what "more specific"
   means: a group conditioning on both `department` AND `location` is,
   by construction, more specific than one conditioning on `department`
   alone. When more than one group's full condition set matches the same
   employee for the same `policy_type`, `EmployeeGroupsService.resolvePolicy()`
   picks the one with more conditions. A genuine tie (two groups, same
   specificity, both matching, different assignments) is broken
   deterministically by earliest-created group (`ORDER BY g.created_at ASC`
   feeding a `Map` iterated in that order, with `>` not `>=` in the
   winner comparison) — an explicit, tested rule, not left to whatever
   order Postgres's query planner happens to return joined rows in.
2. **Additive combination.** Resolution is independent per `policy_type`
   (`employee_group_policy_assignments.policy_type` — only `'leave'`
   exists yet). A caller resolving two different policy types for the
   same employee gets each resolved on its own by the identical
   most-specific-match rule, and the two results simply combine — one
   group's leave-policy assignment never competes with a different
   group's assignment for some other policy type, the same way RBAC's
   own field-permission rules never compete across different `field_key`
   values. `policy_id` is deliberately NOT a real foreign key (which
   table it points into depends on `policy_type`) — the same pragmatic,
   documented tradeoff `custom_fields`' JSONB-over-EAV design already
   made (Decision #6), not a real gap: application code validates the
   referenced row exists and belongs to the caller's tenant before
   writing the assignment, and `deleteLeavePolicy()` explicitly refuses
   to delete a policy that's still assigned to a group rather than
   leaving a dangling reference.
3. **Safe-deny default.** If no group matches at all, or none of the
   matching groups carries an assignment for the requested `policy_type`,
   resolution falls back to the tenant's explicitly-designated default
   (`leave_policies.is_default`) — never an arbitrary guess. A database-
   level partial unique index (`idx_leave_policies_one_default`) makes
   "at most one default per tenant" a real invariant, not just an
   application convention; `createLeavePolicy`/`updateLeavePolicy`
   proactively un-default the previous default when a new one is set,
   rather than erroring, so this reads as "the tenant just changed their
   mind" instead of a conflict to fight through. If a tenant hasn't
   designated a default at all, resolution returns `policyId: null` —
   the same "hidden unless something explicitly grants otherwise"
   posture `resolveFieldAccess()` already takes for an unmatched field.

**Two module gates, deliberately different.** `employee_group.manage`
(create/edit/delete a group and its conditions) is gated behind the
`employee` module — segmenting employees by attribute is generic
infrastructure any future module could hang a policy off of, not
leave-specific. `leave_policy.manage` (create/edit/delete a leave policy,
and — for now — assign any policy to a group) is gated behind `leave`,
since leave policies are this phase's only concrete, licensed consumer.
Both permissions are deliberately scope-less (no `.self`/`.all`/`.team`
suffix) — `RbacService.can()`'s own doc comment already covers a
permission with neither suffix as "sufficient on its own," which is
exactly right for a tenant-wide configuration action with no per-record
ownership concept. Both are granted to `hr_admin` only, matching Section
3's Module Admin tier.

**A genuinely new employee attribute, added deliberately.** Section 12's
own canonical example ("employees in Department=Engineering,
Location=Karachi get Policy X") names `location`, which `employees`
didn't have before this phase, and `employment type` doesn't exist as an
attribute in Phase 7's schema at all — a plain-text `department`/
`designation` pair was all that phase needed. Rather than avoid the
example or fake it with a workaround, `0012_employee_groups_leave_policy.sql`
adds both as real columns (`location text`, `employment_type text` with
a `CHECK` over `permanent`/`contract`/`probation`/`intern`, defaulting to
`permanent`) — genuinely useful attributes for a multi-branch SMB or one
that distinguishes permanent from contract staff, not scaffolding
invented only to make this phase's demo work.

**A fixed, validated condition-field set, not "any employee field."**
`employee_group_conditions.field` is constrained by a `CHECK` to exactly
five values (`department`, `location`, `designation`, `employmentType`,
`employmentStatus`), mirrored by a `class-validator` `@IsIn()` on the DTO
and a `CONDITION_FIELD_TO_COLUMN` map in the service. This is a direct
response to the exact bug Phase 4 hit and fixed for real
(`0011_employee_seed.sql`'s header comment): seeding a `field_key` as a
database column name instead of the API-facing camelCase silently
resolved to the safe-deny default instead of erroring. Typo-ing a
condition's `field` here would have the same silent-failure shape — a
group that can never match anything, with no error to surface it — so
it's closed off at both the database and the DTO layer instead of
trusted to careful typing.

### Alternatives considered

- **A `priority` integer column on `employee_groups`**, set by hand,
  instead of deriving specificity from condition count. Rejected:
  it moves the actual rule ("more specific wins") out of the data model
  and into "whatever number an HR Admin typed in," which can silently
  drift out of sync with what the conditions themselves would imply —
  the whole point of borrowing "most-specific-match-wins" from Phase 4's
  vocabulary was to make specificity a structural property, not a manual
  one.
- **A single JSONB `condition` column per group** (an array of
  `{field, equals}` pairs), matching `field_permission_rules.condition`'s
  own shape exactly, instead of a separate `employee_group_conditions`
  table. Rejected: `field_permission_rules.condition` only ever needs to
  express ONE condition (Section 2's Termination Reason example is a
  single `{field, equals}` pair); this phase's own canonical example
  needs at least two ANDed together, and a real table gives "how many
  conditions does this group have" (specificity) as a plain `COUNT(*)`
  rather than requiring a `jsonb_array_length()` everywhere that number
  matters.
- **Exposing `resolvePolicy()` to a self-service employee** viewing their
  own record, gated by `employee.view.self` instead of admin-only
  `leave_policy.manage`. Rejected for now: there's no real "my leave
  balance" screen yet for that resolution to feed into — Phase 9 (Leave &
  Attendance) is where that caller actually exists, and it can widen this
  gate then with a real UI in hand rather than this phase guessing at the
  right shape now. Tracked in `KNOWN_ISSUES.md`.

### What this unblocks

Phase 8's exit criterion is verified the same way Section 12 itself asks
for — "proven by an automated test the same way every prior phase's
resolver logic was": `employee-groups.service.spec.ts`'s 13 tests against
real Postgres, covering most-specific-match-wins (including a genuine
same-specificity tie), the safe-deny default fallback, the "at most one
default policy" invariant and its un-default-on-set behavior, group CRUD
including condition replacement on update, the two module/permission
gates, and additive independence across repeated resolutions. Full suite
now **75/75 passing**; `npm run build`/`npm run lint` clean across all
three workspaces. Phase 9 (Leave & Attendance) now has real,
tenant-configurable policy groups with a real resolution mechanism to
attach actual leave entitlements and balances to, instead of having to
invent a flat one-policy-fits-all model it would later have to retrofit.

---

## Decision #9 — Phase 9 (Leave & Attendance): `manager_of_submitter` routing, the `resolvePolicy`/`resolvePolicyInternal` split, and the leave/attendance schema

**Context.** Plan doc Section 7 calls Phase 9 "the real go/no-go
checkpoint" — the first phase where every pillar built so far (Phase 4's
RBAC, Phase 5's module licensing, Phase 6's workflow engine, Phase 7's
Employee Core hierarchy, Phase 8's policy resolver) has to serve one real
object together, not in isolation. Three real design decisions came out
of actually wiring that up, none of them visible from any single prior
phase's own exit criterion.

**1. `manager_of_submitter`: a workflow approver type resolved fresh, per
instance, against the Employee Core hierarchy — not against `role_id`/
`user_account_id` at all.**

Decision #6 explicitly deferred this ("a real approver-type case Phase 7
will need once a real manager hierarchy exists") rather than guessing at
its shape ahead of that hierarchy existing. Now that it does, the actual
design: `workflow_template_step_approvers.approver_type` gains a third
value that, uniquely among the three, carries neither `role_id` nor
`user_account_id` at template-configuration time (a widened CHECK
constraint in `0014_workflow_manager_of_submitter.sql` enforces this
shape). Resolution happens at step-activation time, via a new private
`WorkflowService.resolveManagerOfSubmitter()` that queries the
`employees` table directly — a deliberate, narrow exception to this
engine's own "never touches an arbitrary object's own table" rule
(`WorkflowService`'s class doc comment), justified the same way it
already queries `roles`/`user_role_assignments` for the `role` type:
`employees` is a well-known platform table now, not an arbitrary
caller-owned one.

The harder problem this exposed: "the manager of whom?" A workflow
instance previously only recorded who clicked submit
(`submitted_by_user_account_id`) — fine when that's always also who the
record is about, but Phase 9's own On-Behalf requirement (an HR Admin
submitting a leave request for an employee who may not use the
self-service portal at all) breaks that assumption outright. Resolving
`manager_of_submitter` against the HR Admin's own manager (or lack of
one) would be a real correctness bug, not a style choice. The fix: a new
`workflow_instances.subject_user_account_id` column, distinct from
`submitted_by_user_account_id`, defaulting to the caller
(`claims.sub`) but overridable via `submitForApproval()`'s new optional
`subjectUserAccountId` parameter — Phase 9's `LeaveRequestsService`
passes the actual employee's `user_account_id` here for every
submission, self or On-Behalf alike, so `manager_of_submitter` always
resolves against the right person regardless of who physically clicked
submit.

Unresolvable cases (no Employee record, no manager on file, or a manager
with no login) throw `BadRequestException` immediately at
step-activation time rather than silently creating an approval line
nobody can ever act on — safe-deny, the same posture every resolver in
this codebase takes for "nothing applicable found." One honestly-scoped
limitation, not silently glossed over: this only happens reliably for the
FIRST step at submission time; if a later step (activated from `decide()`)
fails to resolve, the error surfaces on the preceding approver's
`decide()` call instead of at submission time. Tracked in
`KNOWN_ISSUES.md`, not fixed now — doing so would mean making `decide()`
itself capable of leaving a workflow instance in a genuinely stuck state
with a clear remediation path, which is more machinery than this phase's
actual approver chains (never more than two steps deep) need yet.

**2. Splitting `EmployeeGroupsService.resolvePolicy()` into a thin
admin-gated wrapper and an ungated `resolvePolicyInternal()` — instead of
just widening the original method's permission gate.**

Decision #8's own "Alternatives considered" section predicted this
moment and explicitly deferred it: `resolvePolicy()` was built
admin-only (`leave_policy.manage`) because Phase 8 had no real caller
that needed resolution from a non-admin context. Phase 9's
`LeaveRequestsService.submit()` is exactly that caller — an ordinary
self-service employee, holding only `leave_request.create.self`, needs
their own policy resolved in order to submit their own leave request at
all. Widening `resolvePolicy()`'s gate to accept `leave_request.create.self`
was rejected outright: that permission has nothing to do with resolving
policy for an ARBITRARY employee over HTTP, and `resolvePolicy()` is
directly HTTP-reachable via `GET /employees/:employeeId/resolved-policy`.
Doing so would let any authenticated self-service employee resolve any
OTHER employee's leave policy just by changing the URL's `:employeeId`.

The actual fix mirrors `WorkflowService`'s own established division of
labor (its class doc comment: "whether the caller may submit or view a
given record at all is explicitly NOT this service's job"): a new
`resolvePolicyInternal()` holds the entire resolution algorithm
(unchanged from Phase 8, just re-homed) and checks only that the `leave`
module itself is licensed — no permission gate at all. It is never
exposed through any controller; `resolvePolicy()` becomes a thin
wrapper that still requires `leave_policy.manage` before delegating to
it. `LeaveRequestsService` calls the internal method only AFTER it has
already authorized its own caller against `leave_request.create.self`/
`leave_request.manage.all` — the calling module decides who may ask for
a resolution, `EmployeeGroupsService` just resolves it. This is the same
shape as every "authorization is the calling module's job" boundary
already in this codebase, applied for the first time to a boundary
between two feature modules rather than between a generic engine and its
caller.

**3. The leave/attendance schema itself: lazy balance seeding, calendar-day
counting, and `employee_number`-keyed attendance.**

`leave_balances` rows are created lazily — the first time
`LeaveRequestsService` needs one for a given employee/leave_type/year,
seeded from whatever `resolvePolicyInternal()` currently resolves to at
that moment — rather than pre-populated for every employee on a
schedule. Most SMB employees never touch most leave types in a given
year; pre-populating three rows per employee per year regardless would
be pure waste, and would also freeze that year's entitlement at
whatever the policy happened to say on some arbitrary seeding date
rather than at actual first-use time. An existing balance row's
`entitled_days` is never silently overwritten by a later resolution —
once created, only `used_days` moves (via approval), preserving room for
a manual HR adjustment to stick.

Day counting is calendar-day, inclusive of both ends, with no business-
day or public-holiday exclusion — there is no holiday-calendar object
anywhere else in this codebase, and inventing one solely to make this
calculation more realistic would be exactly the ahead-of-demand
over-building Section 10 warns against. Similarly, a request spanning a
year boundary (e.g. Dec 30 – Jan 3) draws its entire balance from the
START date's year rather than being split proportionally across two
years' entitlements — a documented simplification, not an oversight.
Both are tracked in `KNOWN_ISSUES.md`.

`attendance_records` stores `employee_number` denormalized alongside the
resolved `employee_id` FK, per plan doc Section 5's rule that any
external interface (a biometric device, a kiosk) speaks the number it
scanned, never the internal UUID — the two-IDs-two-jobs split Section 5
already established, applied to a real external-facing surface for the
first time. "Already clocked in" is enforced by checking for an existing
open row (`clock_out_at IS NULL`) rather than a separate status flag, and
a partial index (`idx_attendance_records_open`) keeps that check cheap
regardless of how large the table grows.

### Alternatives considered

- **Making `WorkflowService.submitForApproval()`/`decide()` and
  `LeaveRequestsService`'s own `leave_requests`/`leave_balances` writes
  share one transaction.** Rejected: `DatabaseService.withClaims()`
  deliberately gives each call its own pooled connection/transaction (its
  own doc comment: "there is deliberately no 'give me a raw client with
  no claims' escape hatch... a new, explicitly-named method, not a
  default nobody has to opt into"). Making cross-service transaction
  sharing possible would mean threading an optional `client` parameter
  through every method of every service this call graph touches, a much
  larger and riskier change than this phase's actual reliability needs —
  a crash in the narrow window between the workflow call and the balance
  update is a real but rare failure mode, honestly documented in
  `KNOWN_ISSUES.md` rather than either silently accepted or used to
  justify a disproportionate refactor.
- **Auto-approving leave requests for a tenant with no `leave_request`
  workflow template configured**, instead of letting
  `WorkflowService.submitForApproval()`'s existing `NotFoundException`
  ("No active workflow template with that key") surface as-is. Rejected:
  silently skipping approval routing because configuration is missing is
  a worse failure mode than a clear setup error — an HR Admin who hasn't
  configured a leave approval workflow yet needs to be told that, not
  have every leave request quietly rubber-stamp itself.
- **Allowing self-cancellation of a still-pending leave request** (an
  employee changed their mind before any approver acted), gated by a new
  `leave_request.cancel.self` permission. Rejected for now: not asked for
  by this phase's exit criterion, and `0016_leave_attendance_seed.sql`'s
  permission set doesn't include it — adding it now means inventing a new
  permission ahead of actual demand rather than in response to it.
  Cancellation is `leave_request.manage.all`-only, matching that
  permission's own seeded description. Tracked in `KNOWN_ISSUES.md`.

### What this unblocks

Phase 9's exit criterion is verified two ways, both against real
Postgres with no mocks: `leave-requests.service.spec.ts` (14 tests) at
the service level — policy resolution via `resolvePolicyInternal`,
lazy balance seeding, `manager_of_submitter` routing through a real
tenant-configured workflow template, balance decrement strictly on
approval (not on rejection), non-blocking overlap notices for a
same-manager teammate, On-Behalf submission correctly routed against the
subject rather than the caller, the "no login" safe-deny case, and
attendance clock-in/out including the "already clocked in" conflict —
plus `leave.e2e.spec.ts` (3 tests), the real-HTTP layer this phase's own
plan doc entry calls for on top of service-level tests: a full submit ->
manager-approves -> balance-decrements round trip through the actual
guards/controllers/`ValidationPipe` stack, not just direct service
calls. Full suite now **96/96 passing**; `npm run build`/`npm run lint`
clean across all three workspaces. Every pillar built since Phase 4 now
has one real object actually depending on all of them at once — the
"go" the plan doc's own go/no-go framing asked this phase to earn.

---

## Decision #10 — Phase 10 (Recruitment & Onboarding): reusing the workflow engine as-is, candidates with no login at all, and the second real caller of Employee Number assignment

**Context.** Plan doc Section 7's Phase 10 row is terse: "Requisition →
offer → hire, Kanban pipeline... Employee number gets assigned here, at
offer acceptance." Unlike Phase 9, nothing in this phase's own
description asks for a new engine capability — no new approver type, no
new RBAC scope. The interesting design questions turned out to be about
what this phase does NOT need to build, and about a genuinely new kind
of participant in the system: a person with no login at all.

**1. Requisition approval reuses the Phase 6 workflow engine completely
unchanged — no new approver type, unlike Phase 9's `manager_of_submitter`.**

`RecruitmentService.submitRequisition()` calls
`WorkflowService.submitForApproval()` exactly the way
`LeaveRequestsService.submit()` does, with a plain `role` approver (e.g.,
"HR Admin approves any new requisition"). Section 10's own "don't let the
workflow engine become over-general" guardrail is usually read as a
reason to hold back from ADDING capability; here it cuts the other way —
the engine already does everything a requisition-approval chain needs, so
the right move is to add nothing and just use it, exactly the discipline
that made Phase 9's own `manager_of_submitter` addition justified in the
first place (it was added because the engine genuinely couldn't do that
yet, not preemptively).

**2. A candidate has no login, no session, and no RBAC scope of their
own — every permission check in this whole object graph is the
recruiter's, never a `.self`/`.team` scope.**

Every other object built since Phase 7 (`employees`, `leave_requests`,
`attendance_records`) has, at minimum, a plausible self-service caller —
the record is ABOUT a `user_accounts` row that can also act on it. A
candidate breaks that pattern entirely: they are a real person the system
tracks, but they never authenticate into BoostFactor, so there is no
`candidate.view.self` to build, and `candidates` deliberately has no
`user_account_id` column at all (unlike `employees`, which has a
nullable one for exactly the "not every record has a login" case Phase 9
also hit). Every write and read across `job_requisitions`, `candidates`,
`applications`, and `offers` is gated by a single scope-less
`recruitment.manage.all`, granted to `hr_admin` — the recruiter's own
permission, standing in for the whole pipeline the way `leave_policy.manage`
stands in for policy configuration. A real "candidate self-service
portal" (checking their own application status, e.g.) is a plausible
future need, deliberately not built now — see `KNOWN_ISSUES.md`.

**3. The Kanban pipeline is a forward-only state machine, not a free
graph — and `hired` is reachable only through accepting an offer, never
through a direct stage move.**

`ApplicationStage`'s five working stages (`applied` → `screening` →
`interview` → `offer`, plus the terminal `rejected`) form a fixed forward
order (`FORWARD_STAGES` in `recruitment.service.ts`); moving backward is
refused outright, and `rejected` is reachable from any non-terminal stage
at any point (a candidate can drop out, or be dropped, at any stage — that
one transition doesn't respect the forward order). `hired` is refused as
a direct target from `moveApplicationStage()` specifically: it is set
ONLY by `decideOffer()` accepting an offer, which is also the moment the
real `Employee` record gets created. Allowing a direct "mark this
`hired`" stage move would create a Kanban card claiming a hire happened
with no Employee record behind it — a data-integrity gap worse than the
inconvenience of forcing every hire through the one real path.

**4. Offer acceptance is the second real caller of
`EmployeesService.create()`'s Employee Number assignment — and it
surfaced a real cross-module permission coupling, documented rather than
silently worked around.**

`RecruitmentService.decideOffer()` calls `this.employees.create(claims,
...)` directly when a candidate accepts — reusing Phase 7's Employee
Number assignment machinery exactly as built, proving it against a
second real caller (the first being direct HR-Admin creation/bulk
import) rather than assuming it still works unchanged. `EmployeesService.create()`
enforces its OWN `employee.manage.all` gate, which `RecruitmentService`
does not — and cannot — bypass, since object-level authorization for
creating an Employee record is `EmployeesService`'s job, not
`RecruitmentService`'s to second-guess. Today's only `recruitment.manage.all`
holder (`hr_admin`) also holds `employee.manage.all`, so this coupling is
invisible in practice — but it is a real, documented gap for a future
dedicated "Recruiter" role that isn't also HR Admin: such a role could
manage the entire pipeline right up to the moment of acceptance, then
hit a confusing `ForbiddenException` at the one step that actually
matters. `decideOffer()` catches that specific case and re-throws a
clearer message naming both permissions, rather than letting
`EmployeesService`'s generic "not permitted to manage employees" message
surface out of context. Tracked in `KNOWN_ISSUES.md` with a concrete
revisit trigger.

### Alternatives considered

- **Giving `RecruitmentService.decideOffer()` its own employee-creation
  SQL**, bypassing `EmployeesService.create()` entirely, to sidestep the
  permission coupling above. Rejected: that would duplicate Employee
  Number assignment logic (`employee_number_sequences`' atomic
  `FOR UPDATE` locking, the tenant's configured prefix/padding format) in
  a second place, which is exactly the kind of drift Section 5's "Employee
  Number... fixed before Employee Core is built, not left to fall out of
  whatever the ORM defaults to" rule exists to prevent. A documented
  permission coupling is a smaller, more honest cost than a second,
  parallel Employee Number implementation that could silently diverge
  from the first.
- **A `candidate.view.self` permission and a lightweight candidate login**,
  so a candidate could check their own application status. Rejected for
  now: no BPD or plan doc section asks for a candidate-facing portal in
  this phase, and building one means inventing an entirely new,
  lower-trust identity type (a candidate is not a tenant employee) with
  its own auth considerations — real scope, not a small addition,
  deliberately deferred rather than guessed at ahead of demand.
- **Allowing `moveApplicationStage()` to move an application backward**
  (e.g., "interview" back to "screening" after a scheduling mixup).
  Rejected for this phase: a real ATS often wants this, but it's not
  asked for by the exit criterion, and getting the semantics right (does
  a backward move un-rescind a rescinded offer? does it matter which
  stage you're moving back FROM?) is a real design question better
  answered against actual pilot-client friction than guessed at now.

### What this unblocks

Phase 10's exit criterion is verified two ways, both against real
Postgres with no mocks: `recruitment.service.spec.ts` (9 tests) at the
service level — requisition approval through a real tenant-configured
workflow template, the forward-only Kanban pipeline including the
refused backward move and the refused direct jump to `hired`, offer
extension/rescission/re-extension, and a full accept-creates-Employee
round trip confirming the resulting record's Employee Number, department,
and designation all trace back correctly to the requisition and
candidate — plus `recruitment.e2e.spec.ts` (1 test), the same real-HTTP
layer Phase 9 established: a full requisition → approval → candidate →
pipeline → offer → hire round trip through the actual guards/controllers/
`ValidationPipe` stack. Full suite now **106/106 passing**; `npm run
build`/`npm run lint` clean across all three workspaces. Phase 11
(Performance & Goals) now has a second, independently-proven example of
a tenant-configured workflow approval chain to build against, and a
second real caller confirming Phase 7's Employee Number machinery
generalizes beyond its original single call site.

---

*Next decision goes here as Decision #11, appended below this line —
never inserted above it.*
