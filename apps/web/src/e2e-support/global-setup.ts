import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import {
  createHrAdminSession,
  createRoleSession,
  SHARED_SESSIONS_DIR,
  SHARED_SESSIONS_FILE,
  type TenantRoleKey,
} from "./real-session";

/**
 * Playwright `globalSetup` (wired in `playwright.config.ts`) — runs ONCE
 * before any test file, in its own process, and mints exactly one real
 * signed-up session per tenant role for the whole run.
 *
 * Why this has to be a global step rather than each spec file calling
 * `createSessionFor()` itself (which is what an earlier version of this
 * fix did): `/signup` and `/auth/login` are both rate-limited to 10
 * requests/minute per IP (`signup.controller.ts`, `auth.controller.ts` —
 * real anti-abuse throttling, not a test-only restriction). With
 * `fullyParallel: true` across several spec files each minting their own
 * 4 role sessions, the real API calls alone blow straight through that
 * limit and the run becomes flaky with `429 ThrottlerException`,
 * independent of anything the tests are actually checking. Minting the 4
 * sessions exactly once and sharing them across every test keeps the
 * whole suite at a constant, small number of real signups no matter how
 * many spec files or tests use them.
 *
 * The shared sessions are written to a JSON file in the OS tmp dir (never
 * inside the repo) that `real-session.ts`'s `getSharedSession()` reads
 * back; by the time any test file runs, this has already completed.
 * `SHARED_SESSIONS_DIR`/`_FILE` live in `real-session.ts` (not here) so
 * neither file needs to import the other's constant back out of the
 * module that already imports it.
 *
 * Re-signing-up on every `npx playwright test` invocation — including a
 * single-file dev run, run back to back a few times while iterating on
 * one spec — adds up to the same `/signup`/`/auth/login`/
 * `/auth/mfa/enroll/confirm` throttling this whole file exists to avoid,
 * just spread across invocations instead of within one. Real session
 * JWTs here are valid for 12 hours (`issueSessionToken`'s `exp`), so a
 * sessions file younger than `MAX_AGE_MS` is reused as-is rather than
 * reminted — set `E2E_FORCE_RESIGNUP=1` to force a fresh batch (e.g. in
 * CI, or after an API restart wipes the dev database these tokens'
 * `company_id` points at).
 */

const MAX_AGE_MS = 10 * 60 * 1000;

export default async function globalSetup(): Promise<void> {
  if (!process.env.E2E_FORCE_RESIGNUP && existsSync(SHARED_SESSIONS_FILE)) {
    const age = Date.now() - statSync(SHARED_SESSIONS_FILE).mtimeMs;
    if (age < MAX_AGE_MS) return;
  }

  const hrAdmin = await createHrAdminSession();

  const sessions: Record<TenantRoleKey, string> = {
    hr_admin: hrAdmin.token,
    line_manager: await createRoleSession(hrAdmin, "line_manager"),
    employee_self_service: await createRoleSession(hrAdmin, "employee_self_service"),
    system_admin: await createRoleSession(hrAdmin, "system_admin"),
  };

  mkdirSync(SHARED_SESSIONS_DIR, { recursive: true });
  writeFileSync(SHARED_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}
