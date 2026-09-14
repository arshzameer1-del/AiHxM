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

**Record-level N+1 still exists in `DummyService.list()` — deliberately left as-is.**
`DummyService.list()` still calls `filterRecordFields()` once per row, so
the `.self`/`.all` object-level `can()` checks still run once per record
even though the caller's granted scope doesn't actually vary per record.
**Resolved for the object that actually matters, not for `dummy`:** per
this entry's own "revisit when Phase 7 is built" trigger, Phase 7's
`EmployeesService.list()` fetches the caller's scope and field-permission
rules exactly ONCE per request (`RbacService.resolveViewScope()` /
`loadFieldPermissionRules()`) and evaluates every row's visibility/field
access from those in memory (`filterRecordFieldsWithScope()` /
`evaluateFieldAccess()`, both added this phase) — zero further
permission-holding queries per row. `dummy_records` itself was
intentionally left untouched: it's scaffolding with a handful of test
rows, not a real object, and retrofitting the fix there was never the
point (see Decision #7 in `DECISIONS.md` for the full writeup, including
why this doesn't change `RbacService`'s existing `.self`/`.all` behavior
for any other caller).

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
payload size limits (helmet doesn't set these — Phase 7's own document
upload endpoint is the first place this got a real, explicit limit; see
below), structured audit logging of authz denials (currently only the
Platform Provisioning actions in `AuditModule` are logged — RBAC/
entitlement denials are not), and dependency audit automation (this was
done by hand; a CI job running `npm audit --audit-level=high` on a
schedule, rather than only during manual audit passes like this one,
would catch new advisories on existing pins without waiting for the next
manual pass).

## 2026-09 — Phase 7 (Employee Core): first file-upload endpoint, and what came with it

### Fixed: `multer`'s DoS advisories, ahead of the "revisit when" trigger arriving

The Phase 5 audit's multer entry above said, explicitly: "**Revisit when:**
the first file-upload endpoint is built." Phase 7's document vault
(`POST /employees/:id/documents`) is that endpoint, so this got fixed now
rather than deferred again. `@nestjs/platform-express@10.4.22` pins an
exact `multer@2.0.2`, vulnerable to several real DoS advisories (crafted
multipart field names/array indices causing uncontrolled resource
consumption — GHSA-wc9g-mqfw-jrwm, GHSA-535w-7cp7-47q4, and others, all
fixed in `multer@2.3.0`). Rather than the full `@nestjs/*` v12 major
upgrade `npm audit`'s own `fixAvailable` suggests (the same major-upgrade
question already deferred for the unrelated `qs`/react-router/file-type
advisories below), a root `package.json` `overrides` entry
(`"multer": "^2.3.0"`) forces just that one transitive dependency to a
patched version while leaving `@nestjs/platform-express@^10.4.4` alone —
multer 2.0→2.3 is a minor-version range, and `@nestjs/platform-express`'s
`FileInterceptor` only uses multer's stable public API.

**Not just trusted — verified the same way every dependency change in
this log has been:** `npm ls multer` confirms `2.3.0 overridden` is what's
actually installed; the full 62-test suite passes unchanged; and the new
upload endpoint was driven with a real multipart `curl` request against a
live `npm run dev` server, with the downloaded file's bytes diffed
byte-for-byte against the original — proof the override didn't change
`FileInterceptor`'s actual behavior, not just proof `npm install` didn't
error. `npm audit`'s count for `apps/api` dropped from 26 (Phase 6's
count) to 21 findings — multer's high-severity findings are gone entirely,
not just reclassified.

### Deferred (documented, not fixed): a low-severity `body-parser` advisory, same bucket as the others

`body-parser` (transitively via `@nestjs/platform-express`, low severity —
GHSA-v422-hmwv-36x6, a DoS possible only if an invalid `limit` value is
passed to it, which this codebase never does) joins the existing
`@nestjs/core`/`@nestjs/platform-express`/`@nestjs/common`/`@nestjs/testing`
bucket from the Phase 5 audit above — same forced-major-upgrade-to-`@nestjs/*`-v12
fix path, same "not worth it as a side effect of a routine change" reasoning,
same revisit trigger (a deliberate, planned `@nestjs/*` v12 upgrade).

### New, real gap surfaced while building the document vault: orphaned files on cascade delete

Deleting a company cascades `employee_documents` rows via the database's
own `ON DELETE CASCADE`, but nothing calls the new
`FileStorageService.delete()` as part of that cascade — the uploaded file
itself is left behind on disk. Caught by direct observation while manually
testing this phase (a deleted fixture company's uploaded file was still
sitting under `storage-data/` afterward), not by inspection alone. Full
reasoning and the fix's shape are in `DECISIONS.md`'s Decision #7.
Harmless at current scale (dev/test fixtures, cheap to clean up by hand);
becomes a real problem once real client data and real deletion/GDPR-style
purge requests exist. **Revisit when:** building any real "delete a
company" or "delete an employee" flow.

### Addressed proactively, not deferred: the document upload's own size limit

The "Not yet investigated" note above (from the Phase 5 audit) flagged
request/response payload size limits as unaddressed generally — this
wasn't fixed globally, but Phase 7's own upload endpoint didn't get to
inherit that gap silently: `FileInterceptor("file", { limits: { fileSize:
10 * 1024 * 1024 } })` caps a single document at 10MB, and
`EmployeesService.addDocument` independently re-checks the size on the
buffer it actually receives. The broader "no payload size limits anywhere
else" gap remains open and tracked above.

## 2026-09 — Phase 8 (Employee Groups & Leave Policy Config): deliberate scope narrowing, tracked honestly

### `resolvePolicy()` is admin-only for now, not yet exposed to self-service

**RESOLVED in Phase 9.** `EmployeeGroupsService.resolvePolicy()` stays
admin-only (`leave_policy.manage`), but Phase 9 added
`resolvePolicyInternal()` — an ungated (module-license-only) sibling that
`LeaveRequestsService` calls after authorizing its own caller against
`leave_request.create.self`/`leave_request.manage.all`. This is what a
real "my leave balance" self-service screen (`LeaveRequestsService.getBalances()`)
turned out to need, exactly as predicted below — see Decision #9's
section 2 for the full writeup of why a new method, not a widened gate
on the original one, was the right shape.

~~`EmployeeGroupsService.resolvePolicy()` — the actual "which leave policy
applies to this employee" resolver — is gated behind `leave_policy.manage`
(HR Admin only), the same as every other write/config action this phase
adds. There is deliberately no `employee.view.self`-scoped path yet for
an employee to see their own resolved policy. This is a real, currently-
missing capability, not an oversight: Phase 9 (Leave & Attendance) is
where a genuine "my leave balance" self-service screen first needs this
resolution, and it can widen the gate then against that real caller and
UI rather than this phase guessing at the right shape (does an employee
need the resolved policy_id, or a friendlier summary of what it grants?)
in the abstract. See Decision #8's "Alternatives considered" for the
reasoning.~~

### `policy_id` on `employee_group_policy_assignments` is not a real foreign key

Deliberate, matching `custom_fields`' own JSONB-over-EAV tradeoff
(Decision #6): which table `policy_id` points into depends on
`policy_type`, and Postgres can't express a conditional FK across tables.
Application code (`assignPolicy`/`deleteLeavePolicy`) validates existence
and tenant ownership before writing or refusing to delete, so this is
covered today with exactly one `policy_type` (`leave`) in existence — but
it's worth flagging now, before a second `policy_type` arrives, that
whoever adds one must remember to extend both of those checks by hand;
nothing enforces it structurally. **Revisit when:** a second `policy_type`
is added — audit `assignPolicy`/`deleteLeavePolicy`/`resolvePolicy` for
every place that currently hardcodes `'leave'`.

### Assigning ANY future policy type currently requires `leave_policy.manage`

`EmployeeGroupsService.assignPolicy()` is gated by `leave_policy.manage`
regardless of which `policy_type` is being assigned, since `'leave'` is
the only one that exists. Documented in the method's own doc comment as a
permission choice to revisit once a second `policy_type` ships — at that
point assigning it shouldn't require holding an unrelated leave-specific
permission.

## 2026-09 — Phase 9 (Leave & Attendance): deliberate scope narrowing, tracked honestly

### Cross-service transactional non-atomicity between `WorkflowService` and `LeaveRequestsService`

`DatabaseService.withClaims()` gives each call its own pooled connection
and transaction (BEGIN/COMMIT per call) — there is no support for sharing
one transaction across service boundaries (see its own doc comment).
`LeaveRequestsService.submit()` calls `WorkflowService.submitForApproval()`
as a separate transaction from its own `leave_requests` insert, and
`LeaveRequestsService.decide()` calls `WorkflowService.decide()` as a
separate transaction from its own `leave_requests`/`leave_balances`
updates. A crash in the narrow window between these calls could leave a
leave request without a `workflow_instance_id` (submit), or an approved
workflow instance whose `leave_requests.status`/`leave_balances.used_days`
were never updated to match (decide). This is a genuine, deliberate scope
tradeoff — see Decision #9's "Alternatives considered" for why a shared-
transaction mechanism wasn't built to close it. **Revisit when:** a real
production incident or a stricter reliability requirement makes this
worth the much larger refactor (threading an optional shared `client`
through every service in this call graph) it would take to fix properly.

### `manager_of_submitter` resolution failures on a step AFTER the first surface late

`WorkflowService.activateFromStep()` throws immediately if a
`manager_of_submitter` approver can't be resolved (no Employee record, no
manager, or a manager with no login) — but that only happens reliably
"at submission time" for the FIRST step. A later step (activated from
inside `decide()`, once an earlier step is approved) that fails to
resolve surfaces its `BadRequestException` on the PRECEDING approver's
`decide()` call instead of at the point the tenant configured the broken
template. An approver who innocently approves step 1 could unexpectedly
receive an error instead of a clean "approved" response. **Revisit when:**
multi-step `manager_of_submitter` chains (e.g. "manager, then their
manager") become a real tenant need — Section 10 explicitly keeps
escalation-to-a-manager's-manager out of scope for now (see
`EscalationApproverType`'s own comment), so this compounds with an
already-deferred capability rather than being urgent on its own.

### Calendar-day leave counting, no business-day/holiday exclusion

`inclusiveDayCount()` in `leave-requests.service.ts` counts every day
between `startDate`/`endDate` inclusive, including weekends and public
holidays — there is no company-holiday-calendar object anywhere in this
codebase to exclude against. A 5-day leave request over a week containing
a weekend consumes 5 days of entitlement, not 3. **Revisit when:** a
holiday-calendar object is built for some other reason (payroll, most
likely) — retrofitting this calculation to use it then is straightforward;
inventing one solely for this calculation now would be scope creep ahead
of actual demand.

### Balance year = the request's start date's year, for a request spanning a year boundary

A leave request from Dec 30 to Jan 3 draws its ENTIRE `daysRequested`
against the START year's balance (`leave_balances` keyed by `year`) —
it is not split proportionally across the two years' entitlements. A
documented simplification, not a bug: most SMB leave requests don't
span a calendar year boundary, and getting the split "right" (which
year's balance should a shared day draw from, and does that change if
the tenant's leave year isn't the calendar year at all?) is a real design
question with no obvious answer, better deferred until a tenant actually
hits it. **Revisit when:** a real year-boundary-spanning request comes up
in practice, or a tenant needs a non-calendar leave year.

### Cancellation is `leave_request.manage.all`-only — no self-cancel-your-own-pending-request path

An employee cannot cancel their own still-pending leave request even
before any approver has acted on it — only a caller holding
`leave_request.manage.all` (HR Admin) can cancel any request, matching
that permission's own seeded description exactly.
`0016_leave_attendance_seed.sql` has no `leave_request.cancel.self`
permission; adding one now would be inventing scope ahead of actual
demand rather than in response to it (Section 10's guardrail). See
Decision #9's "Alternatives considered." **Revisit when:** a real tenant
asks for self-cancellation — add the permission, seed it to
`employee_self_service`, and gate `cancel()` on either it (with an
ownership + still-pending check) or `manage.all`.

### Cancelling a leave request does not touch its workflow instance

`LeaveRequestsService.cancel()` sets `leave_requests.status = 'cancelled'`
directly without informing `WorkflowService` — the underlying workflow
instance (if still `in_progress`) is left exactly as it was, status and
all. This is harmless today (nothing re-reads a cancelled leave request's
workflow instance for any decision), but an approver who still has a
pending approval line on it could, in principle, still "approve" a
workflow step whose parent leave request is already cancelled — that
approval would just have no effect, since `decide()` only writes back to
`leave_requests` when it's still `pending`. **Revisit when:** a "cancel
the underlying workflow instance too" capability is added to
`WorkflowService` for some other object's benefit — leave requests should
adopt it too.

### An employee with no `user_account_id` can never have a leave request submitted for them

`LeaveRequestsService.submit()` throws `BadRequestException` outright for
any employee record with `user_account_id IS NULL` — routing (both
`subjectUserAccountId` and `manager_of_submitter` resolution) needs a
real login to key against, and there is no meaningful way to route an
approval for someone with no account at all. This is a genuine, if
unusual, gap for a tenant that maintains "ghost" employee records (e.g.
payroll-only staff who never use self-service) and wants leave tracked
for them anyway. **Revisit when:** a real tenant needs leave tracking for
employees without logins — likely needs a separate "record leave
directly, no approval routing" HR-only path rather than forcing every
leave request through the workflow engine.
