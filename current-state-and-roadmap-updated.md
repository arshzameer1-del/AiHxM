# AI HXM — Full Status & Roadmap (as of 2026-09-17, post–Task #52)

*This document consolidates `development-plan.md`'s phase-by-phase build log, `mvp-gate-audit.md`'s gap analysis, and `DECISIONS.md`/`KNOWN_ISSUES.md`'s detailed findings into one place, and brings the frontend section current — `mvp-gate-audit.md` was written before Tasks #47–#51 (the tenant portal work) existed, so its "15% frontend, only the Platform Admin Panel works" finding is now out of date. Everything below is either lifted directly from those source documents (all written from real, direct repository/database/test inspection, not reconstructed from memory) or from this session's own direct verification — Playwright passes against real running dev servers, `npm test` against real Postgres, `git status`/`git log` read directly.*

---

## 1. What AI HXM is

A multi-tenant HR/payroll/attendance/performance SaaS for Pakistan SMBs — an affordable, locally-compliant counterpart to SAP SuccessFactors. One shared codebase serves every tenant (company); each tenant's data is fully isolated at the database level (Postgres Row Level Security), and each tenant is licensed for a specific set of modules. A WRICEF extensibility layer (Workflows, Reports, Interfaces, Conversions, Enhancements, Forms — SAP's own vocabulary, deliberately borrowed) lets a tenant configure the product to their own company without a code change.

## 2. Stack and infrastructure — what's real today

| Layer | Choice | Status |
|---|---|---|
| Database | Postgres 16, RLS `FORCE`d on every tenant-owned table | Real, running locally via Docker Compose |
| Auth | Self-hosted (bcrypt + mandatory TOTP MFA), not Supabase Auth yet | Real, tested |
| File storage | A swappable `FileStorageService` interface; local-filesystem implementation stands in for the eventual Supabase Storage | Real for local dev; Supabase itself never provisioned |
| Business-logic API | NestJS (TypeScript), raw SQL migrations + `pg` (Decision #2 — no ORM; Prisma's schema-engine binary was blocked by this build environment) | Real |
| Background jobs | A plain `@nestjs/schedule` cron sweep, not Redis/BullMQ yet (Decision #6 — deliberate, revisit when real retry/backoff semantics are needed) | Real for what exists (SLA escalation only) |
| Frontend | React + Vite + Tailwind, Apple HIG design tokens | Real for the portal it covers (Section 4) |
| Monorepo | Turborepo — `apps/api`, `apps/web`, `packages/shared-types` | Real |
| CI | GitHub Actions — install, lint, build, test | Real |

**A real Supabase project has never been provisioned.** The original architecture decision (Decision #1) was to use Supabase for managed Postgres/Auth/Storage with NestJS owning business logic on top — but no Supabase account exists yet, so Phase 3 built real self-hosted auth instead of waiting (Decision #3), and file storage uses a local-disk stand-in behind a swappable interface. Nothing about the RLS design or the API code assumes Supabase specifically; the escape hatch (development-plan.md Section 9) for self-hosting on a client's own AWS account, or dropping Supabase-specific pieces (Auth, Storage) for native AWS equivalents, remains fully intact because the codebase never leaned on anything Supabase-proprietary.

**Scale, right now:** 24 migrations, 21 backend modules (`apps/api/src/*`), 20 git commits, 20 recorded architectural decisions (`DECISIONS.md` — numbered 1–20, with #14 permanently reserved for the paused Payroll work), **131/131 backend tests passing** against real Postgres, 17 backend test files.

---

## 3. Backend module status — Phases 1–11 (all complete, tested, committed)

Every module below is real: real Postgres tables with `FORCE ROW LEVEL SECURITY`, a real NestJS service/controller enforcing module-licensing-then-permission-then-field-visibility in that order, and a real passing Jest suite (service-level against live Postgres, plus e2e through the actual HTTP guards/controllers/`ValidationPipe` stack). Nothing below is scaffolding or a stub.

| Phase | Module | Backend permission model | Key design decisions |
|---|---|---|---|
| 1 | Infrastructure | — | Monorepo, CI, Decision #1/#2 |
| 2 | Platform Provisioning | Platform-Admin-only tier | Companies, config, admins, audit log, RLS baseline, scoped "Login As" impersonation |
| 3 | Auth & Identity | — | Password + mandatory TOTP MFA, lockout, password reset, single-use tokens (Decision #3) |
| 4 | RBAC + field-level engine | `roles`/`permissions`/`role_permissions`/`field_permission_rules`/`user_role_assignments` — the engine every later module reuses unchanged | `can()` (object/record scope: `.self`/`.team`/`.all` suffixes baked into the permission key) + `resolveFieldAccess()` (conditional field rules, e.g. "Termination Reason only when Status=Terminated"); Platform Admin has **no bypass, structurally** — its session carries no `company_id`, so it cannot match any role assignment, full stop (Decision #4) |
| 5 | Module Provisioning & Licensing | `tenant_module_entitlement`, checked *before* RBAC everywhere | A disabled module 404s, never 403 or an empty list (Decision #5) |
| — | Security & quality audit | — | CORS allowlist, `helmet()`, rate limiting (global + stricter on auth endpoints), an N+1 fix |
| 6 | WRICEF framework skeleton | — | Generic workflow engine (role/specific_user approvers, parallel + conditional steps, SLA escalation via cron sweep), custom fields (JSONB, not EAV), notification logging (stubbed, no real provider), document templates (`{{field}}` substitution), CSV import/export (Decision #6) |
| 7 | Employee Core | `hr_admin` (`.all`), `line_manager` (`.team`), `employee_self_service` (`.self`) — the three real tenant roles every later module reuses | Org chart, document vault, job history, Employee Number assignment (atomic sequence table, immutable, never reused, tenant-configurable prefix/padding, preserves imported legacy numbers) — Decision #7 |
| 8 | Employee Groups & Leave Policy Config | `employee_group.manage.all`, `leave_policy.manage.all` — both `hr_admin`-only | Most-specific-match-wins resolver (condition count = specificity, deterministic tie-break, safe fallback to tenant default), reused unchanged by every later "policy" concept (Decision #8) |
| 9 | Leave & Attendance | `leave_request.create.self`/`.manage.all`, `attendance.*` | Full lifecycle: submit (self or On-Behalf) → resolve policy → seed/check balance → non-blocking overlap notice → route through workflow (`manager_of_submitter`, newly added to the engine here) → decide → decrement balance strictly on approval; clock in/out keyed on Employee Number (Decision #9) |
| 10 | Recruitment & Onboarding | `recruitment.manage.all` — `hr_admin`-only, **no** `.self`/`.team` scope at all (candidates never log in) | Requisition → candidate → application (Kanban, forward-only, "hired" reachable only via offer acceptance) → offer; offer acceptance is the second real caller of Employee Number assignment (Decision #10) |
| 11 | Performance & Goals | Same three roles as Employee Core, field-visibility gated on `status='released'` | Review cycles, goals (self/team/all scoped, parent-goal cascade), self/manager assessments, calibration; deliberately does **not** use the workflow engine (single-actor RBAC-gated actions only) — Decision #11 |

**Full narrative detail for every phase above — line-item build notes, exact test names, every bug found and fixed during backend construction — lives in `development-plan.md`'s Progress Log (Section 13) and is not repeated here.**

---

## 4. Frontend — what actually exists today

**Six portal tasks have been built, tested (via live Playwright passes against real running dev servers, not just code review), and committed:**

| Task | Screen(s) | Roles served | Status |
|---|---|---|---|
| #47 | Portal shell — `GET /auth/me`, role-aware nav, `/app` routing split from Platform Admin's `/` routes | All three tenant roles | ✅ Committed, verified |
| #48 | Employee Core — list, create, detail/edit, self profile, login provisioning | `hr_admin` (full), `line_manager` (team view), `employee_self_service` (own profile) | ✅ Committed, verified (a real rendering-order bug found and fixed — Decision #16) |
| #49 | Admin Center — Employee Groups + Leave Policies (create/edit/delete/assign) | `hr_admin`-only | ✅ Committed, verified (a real void-endpoint bug found and fixed in the shared API client — Decision #17) |
| #50 | Leave & Attendance — submit/on-behalf/approve/reject/cancel, balances, clock in/out, overlap notices | All three tenant roles, one screen, server-driven RBAC scoping | ✅ Committed, verified (a real RBAC bug found and fixed — Decision #18) |
| #51 | Recruitment — requisitions, candidate pool, Kanban pipeline, offers | `hr_admin`-only | ✅ Committed, verified (a real transient-state bug found and fixed — Decision #19) |
| #52 | System Admin — Workflow Templates configuration + Roles & Access panel | `system_admin`-only; **closes Section 6's approval-configuration gap** | ✅ Committed, verified (Decision #20) |

**Design pattern used throughout (Decision #15, reused every time since):** one list/detail screen serves every role. The API already RBAC-scopes what comes back (which rows, which fields); the frontend renders one component and only gates cosmetic buttons on `identity.roleKeys`. This is why Recruitment (single-audience) and Leave & Attendance (three-audience) could reuse the identical pattern.

**Still `ComingSoonPage` placeholders, not yet built:**
- **Performance & Goals UI** (Task #53) — Phase 11's backend is complete and tested (125/125 relevant tests passing as of that phase; still passing today), but no frontend exists yet. This is the next natural task.
- **Payroll UI** — doesn't exist and won't until Payroll itself resumes (Section 7).

**What every real login sees today:** a genuine login page (email + password + mandatory MFA, enforced server-side, not a convenience toggle), then a portal whose nav is built from the caller's actual `roleKeys` and licensed modules (`PortalLayout.buildNavItems()`) — not a demo role-switcher. (A separate, explicitly-labeled interactive HTML prototype was also built this session to demonstrate the full intended UX including not-yet-built screens; it is a mockup with in-memory mock data, not connected to the real API, and is clearly out of scope for this technical status document.)

---

## 5. Authorization model — current state and the decision made this session

This session's user supplied a "SuccessFactors-style Role-Based Permissions (RBP)" specification and asked whether AI HXM follows the same model. It does not, structurally — the comparison and the resulting decision are recorded in full in Decision #20's section on RBP; summarized here because it's directly relevant to "what's missing, deferred to post-pilot":

**What we have:** a fixed, migration-seeded catalog. Roles and permissions are hardcoded rows added via SQL migration, not administrable through any UI. Target population (`.self`/`.team`/`.all`) is baked into the permission key itself rather than being an independent, swappable dimension on the role. Only 3 of the spec's 8 target-population types exist (no All-Reports/hierarchical, Department, Location, User-Group, or Custom-Rule scoping). No Permission Groups or group-based role grants — only direct user→role assignment (though a user can hold multiple roles). No data-driven Resources/Actions catalog — a new permission means a new migration, not a UI action.

**What we have that the spec doesn't emphasize:** Postgres `FORCE ROW LEVEL SECURITY` as the tenant-isolation backstop (the spec's own schema only shows app-layer `WHERE` clauses), and every module already goes through one shared `RbacService` rather than rolling its own security per module (the spec's own Rule 1).

**The decision (user had no preference on either sub-question; both defaulted to the recommended path):** keep the current fixed-catalog engine rather than rebuild toward the full RBP spec now — a full rebuild (data-driven resources/actions, Permission Groups, 8 target-population types, a custom rule engine, and an admin UI to manage all of it) would be a project on the scale of Phases 4–11 combined, solving a problem (enterprise-scale configurability for large, complex orgs) that doesn't match AI HXM's actual target market (a Pakistan SMB with one flat HR admin, not a dedicated HRIS/IT team). Instead: add a `system_admin` role **additively** on top of the current engine — a company can assign it to the same person as `hr_admin`, or split it, since `user_role_assignments` already supports multiple roles per user and nobody loses access either way. **The full RBP-spec rebuild is explicitly deferred to a future, dedicated phase — see Section 7.**

---

## 6. The single most urgent functional gap — NOW CLOSED by Task #52

**Previous state (before Task #52):** No real tenant role, and no screen anywhere in the product, could create the `workflow_templates` row that both Leave approval and Recruitment requisition-approval require. `workflow_template.manage.all` was granted only to `rbac_demo_full_access`, a Phase 4 proof-of-concept role never assigned to any real company.

**Current state (Task #52 complete):** The `system_admin` role now holds `workflow_template.manage.all`, and a full Workflow Templates configuration UI exists in the System Admin panel. A real tenant's System Admin (or an HR Admin with both roles assigned) can now create approval workflows without calling the API directly or having access to demo-only roles.

**Concrete effect:** a brand-new company onboarded through the product today can now complete the full workflow: create employees → submit leave requests / open requisitions → route them through configured approval workflows → decide → complete. This session's verification work for Tasks #50 (Leave) and #51 (Recruitment) had to use workarounds before Task #52 existed; that workaround is now obsolete.

**Impact on pilot readiness:** Section 6's approval-configuration gap is closed. PILOT is no longer blocked on Section 6; the remaining blockers are Section 8's testing gaps and a pilot-realistic seed-data script.

---

## 7. Everything explicitly deferred to a later phase — including everything to revisit "after at least one pilot is live"

Organized by when each was decided and why, so nothing here reads as an oversight:

### Decided in `development-plan.md` (Section 11), before any pilot exists
- **Billing & subscription metering.** Nothing collects money anywhere in the product yet — `tenant_module_entitlement` gates which modules a tenant can use, not payment. Stripe/Chargebee don't serve Pakistani merchants well; the likely real answer is JazzCash/Easypaisa/bank transfer, or manual invoicing for the first few pilot clients. **Revisit at:** approaching Pilot Launch (Phase 16) — a real paying client needs *some* answer, even a manual one.
- **Subdomain/custom-domain tenant routing.** Every tenant currently logs in through one shared URL; tenancy resolves from the JWT's `company_id` claim, not a subdomain. **Revisit when:** a client specifically asks for their own URL, or tenant count makes a shared login page awkward.
- **Search infrastructure (Elasticsearch/OpenSearch) and localization (multi-language UI, multi-currency).** Plain Postgres text search is assumed sufficient at SMB scale; the product is Pakistan-only, PKR-only, by design. **Revisit search when:** directory/document search genuinely outgrows Postgres. **Revisit localization when:** there's a concrete plan to expand outside Pakistan or a client asks for an Urdu UI.
- **Person-vs-Employment split** (SAP/SF's distinction between a human and one of their possibly-multiple employment contracts). Deliberately not built — Pakistani SMBs in the 50–2,000 range essentially never need it in year one. **Revisit when:** a client actually needs concurrent/global assignments (flagged as a Phase 17/Scale item).

### Decided this session
- **The full RBP-spec authorization rebuild** (Section 5) — Permission Groups, group-based role grants, all 8 target-population types, a data-driven resources/actions catalog, a custom-rule engine, and a Permission Administration UI. Deferred as a deliberate, dedicated future phase, not something to build speculatively ahead of a real customer need for it.

### Already named in the phase plan, simply not yet reached
- **Phase 13 — Succession, Learning, Exit & Offboarding.** Priority order to be set by actual pilot-client demand, not doc order.
- **Phase 14 — BI & Analytics**, including the custom report builder (the sixth WRICEF pillar, deliberately deferred since Phase 6 — nothing existed yet worth building a report builder against).
- **Phase 15 — Mobile/PWA**, plus real (non-stubbed) notification dispatch — email/WhatsApp/push providers are not wired up; today's `notification_log` only records that a notification *would* have fired.
- **Phase 17 — Scale**: SSO/SAML, an integration marketplace, multi-region, advanced compliance reporting, and the Person-vs-Employment split if a client actually needs it.
- **Real job queue (Redis/BullMQ)** in place of the current plain cron sweep for workflow SLA escalation (Decision #6). **Revisit when:** real retry/backoff semantics are needed — flagged examples are Payroll or a real notification-provider integration.

### Narrower, module-level gaps recorded honestly rather than silently left
- Leave & Attendance: submit-and-route-to-workflow is two separate, non-atomic database transactions — a failed routing step can leave an orphaned "Pending" leave request with no real approval chain behind it (observed directly, twice, during Task #50's own verification). Leave-day counting is calendar-day, no business-day/holiday exclusion. No self-cancel path for an employee's own pending request (cancel is `hr_admin`-only today).
- Recruitment: no `GET /offers` (or `GET /offers?applicationId=`) endpoint exists — an already-extended offer's id/salary/status cannot be retrieved after a page reload, only within the session that extended it. No "hiring manager reviews their own requisition's pipeline" view (`recruitment.manage.all` has no `.team` scope at all — a deliberate scope narrowing, not an oversight, per `0018_recruitment_seed.sql`'s own comment).
- Employee Core: deleting a company cascades `employee_documents` rows at the database level, but nothing calls `FileStorageService.delete()` as part of that cascade — orphaned files on disk. **Revisit when:** any real deletion/GDPR-style purge flow is built.
- Performance: a review that never reaches `completed` is silently skipped forever when its cycle closes, with no report surfacing the gap. A launched cycle's participant population is frozen at launch — no re-sync for a mid-cycle hire, transfer, or exit. Rating scale is a fixed 1–5 integer, not tenant-configurable.

### Payroll (Phase 12) — paused, explicitly not to resume until the MVP gate clears
Real, substantial work already exists **uncommitted** in the working tree (per explicit instruction, never committed, never touched again until told to resume): `apps/api/migrations/0021_leave_unpaid_type.sql`, `0022_payroll.sql`, `0023_payroll_seed.sql` (written and already applied to the local dev database), `apps/api/src/payroll/` (service, DTOs, controller, module — type-checks cleanly, wired into `app.module.ts`, but has **no tests yet**), and a `LeaveType` widening (adds `"unpaid"`) in `packages/shared-types`. Separately, statutory-rate research was done (`claude/statutory-payroll-rates-pakistan.md`) covering FBR income tax slabs (high confidence — matches multiple advisory sources), EOBI's 5%/1% employer/employee split (high confidence on the split, **low confidence on the current wage-base figure** — several conflicting numbers found, no EOBI-specific circular located), and PESSI/Punjab (6%) / SESSI/Sindh (7%) rates (**medium-low confidence** — official sites were unreachable during research, figures come from secondary sources). **Before this can run with real money:** a real accountant/labour-law consultant must verify every rate against a primary gazette/circular, not an advisory-firm summary — this is stated as non-negotiable in `development-plan.md`'s own guardrails (Section 10) and repeated here deliberately.

---

## 8. Known gaps that are really about testing and pilot-readiness process, not a specific module

Carried forward from `mvp-gate-audit.md`, still true as of this session (nothing in Tasks #47–#52 touched testing infrastructure):

- **No automated test anywhere proves cross-tenant isolation** by actually authenticating as Company A and asserting a request against Company B's record fails. RLS is sound by inspection and by the structural "no bypass" arguments in Decisions #4/#5, but that is a different claim from a real negative test proving it under load-bearing conditions. **This is the top security-adjacent P0 item.**
- No dedicated test files for `auth`, `companies`, `platform-admins`, `audit`, `notifications`, `document-templates`, or `file-storage` — these modules are exercised indirectly through other modules' tests, not with their own regression suite.
- No pilot-realistic seed-data script — `database/seed.ts` only bootstraps the first Platform Admin account. There is no one-command way to stand up a demo company with departments, 20–100 employees, managers, groups, policies, and a few in-flight leave/recruitment/performance records for a real demo or onboarding rehearsal.
- **Zero automated frontend or browser tests exist.** Every verification of Tasks #47–#52's frontend (and the bugs those passes found — Decisions #16–#20) was a manual, throwaway Playwright script written for that task and deleted afterward, per this project's discipline against committing scratch artifacts. Nothing in CI would catch a regression in any of these six screens today. Building a real, committed, CI-integrated browser regression suite is still an open, named gap (Decision #16's own closing line, repeated at each subsequent frontend task since).
- No UX consistency pass, accessibility review, or mobile-responsiveness review has been done on any of the six tenant-portal screens.

---

## 9. Honest completion estimate

Using the same rubric `mvp-gate-audit.md` used, updated for what Tasks #47–#52 actually closed:

- **Backend: ~85%.** Phases 1–11 are real, tested, and passing right now (131/131). What's missing is test coverage for the modules named in Section 8, the cross-tenant negative-test suite, and Payroll (paused, ~40% built but zero tests and uncommitted).
- **Frontend: ~60%** (up from the audit's 15%, then 55% after Task #51). Employee Core, Admin Center, Leave & Attendance, Recruitment, and System Admin all have real, working, Playwright-verified screens. Performance has none. Payroll has none. No screen has had a UX/accessibility/responsiveness pass, and there is no automated regression suite protecting any of it.
- **Security: ~65%**, unchanged from the audit — RLS/RBAC/field-permissions/CORS/headers/rate-limiting are real and sound by inspection, but the cross-tenant negative-test gap named in Section 8 is still open.
- **Testing: ~55–60%.** 131/131 backend tests pass; the gaps are the same ones the audit named (Section 8) plus zero automated frontend/browser coverage.
- **The functional gap in Section 6 (approval-configuration) is now closed by Task #52.** The remaining urgent gaps are Section 8's testing gaps and a pilot-realistic seed-data script — these are what actually close the MVP gate's remaining P0 items.
- **Overall pilot readiness: roughly 55%**, up from ~50% at Task #51 — real, substantial forward progress. PILOT is no longer blocked on Section 6's approval-configuration gap; it is now blocked specifically on Section 8's testing/seed-data gaps and Performance UI.

---

## 10. Immediate roadmap, in order

1. ✅ **System Admin role** — **COMPLETE (Task #52, Decision #20)** — workflow template management, role assignment, user creation. Section 6's approval-configuration gap is now closed.
2. **Performance & Goals UI** (Task #53) — the last remaining `ComingSoonPage` for a module with complete, tested backend.
3. **A formal verification pass** — the cross-tenant negative-test suite, missing backend test coverage (`auth`, `companies`, `platform-admins`, `audit`), and a real pilot-realistic seed-data script. This is what actually closes the MVP gate's remaining P0 items.
4. **Resume Payroll (Phase 12)** — only after the above, and only with the statutory-rate verification and accountant sign-off Section 7 describes as non-negotiable before real money moves.
