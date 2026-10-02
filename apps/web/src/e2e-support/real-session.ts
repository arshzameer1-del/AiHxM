import type { Page } from "@playwright/test";
import { generate as generateTotp } from "otplib";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Single source of truth for where `global-setup.ts` writes the shared
// sessions file and where `getSharedSession()` below reads it back from
// — kept here (rather than each file declaring/importing the other's
// constant) so there's no import cycle between the two.
export const SHARED_SESSIONS_DIR = join(tmpdir(), "aihxm-e2e-sessions");
export const SHARED_SESSIONS_FILE = join(SHARED_SESSIONS_DIR, "sessions.json");

/**
 * Real-session e2e auth helper.
 *
 * Root-cause writeup (2026-10-01): every e2e spec in this app minted a
 * *fake* session by writing `localStorage.setItem("authToken", "test-token")`
 * (or similar) before navigating. That never worked, for two independent
 * reasons that compounded:
 *
 *   1. Wrong key. The app's real token accessor is `getToken()`/`setToken()`
 *      in `api/client.ts`, which read/write `localStorage["aihxm.platformAdminToken"]`
 *      — "authToken" is a key nothing in this app's source ever reads.
 *      `AuthProvider`'s `isAuthenticated` (`AuthContext.tsx`) is
 *      `Boolean(getToken())`, so it was `false` on every single one of
 *      these tests regardless of what they wrote to "authToken".
 *   2. Even with the right key, the value has to be a real signed JWT:
 *      `AuthProvider` calls the real `GET /auth/me` on mount whenever a
 *      token exists, and the API's `SessionGuard` (`session.guard.ts`)
 *      runs `jwt.verify(token, JWT_SECRET)` — a literal string like
 *      "test-token" fails that immediately, and the 401 triggers
 *      `logout()`, clearing the (wrong-key) token right back out.
 *
 * Together, no e2e test in this suite that depended on actually loading
 * authenticated content ever really worked — the only ones that reported
 * a pass were tests whose real assertions were wrapped in
 * `if (await x.isVisible())` guards that silently no-op when nothing
 * loads, or ones that never required auth to begin with. This explains
 * why fixing the earlier `page.evaluate`-before-`page.goto` ordering bug
 * (see PortalHomePage.e2e.spec.ts's own `loginAsRole` comment) recovered
 * only one extra passing test out of 89 — that fix was real and
 * necessary, but the auth it was trying to set up was never going to
 * take regardless of ordering.
 *
 * This helper replaces the fake token with a REAL one, minted by driving
 * this app's own public, already-shipped endpoints exactly the way a
 * real browser would — no secrets, no direct DB access, no mocking:
 *
 *   1. `POST /signup` — the public self-service flow (same one
 *      `PortalHomePage.e2e.spec.ts`'s "Create your company" link points
 *      at) creates a brand-new company with a working hr_admin login.
 *   2. `POST /auth/login` — MFA is mandatory for every account
 *      (`AuthService.login`'s own doc comment), so a fresh account always
 *      comes back `mfa_setup_required` with a one-time TOTP secret.
 *   3. `otplib`'s `generate()` computes the current 6-digit code from
 *      that secret — the same library, the same call shape, `AuthService`
 *      itself uses to verify codes, and the same approach the API's own
 *      e2e suite already relies on (see `auth/step-up-test-support.ts`).
 *   4. `POST /auth/mfa/enroll/confirm` — returns a genuine, signed session
 *      JWT, indistinguishable from one a real user would get from the UI.
 *
 * For the three other tenant roles (`line_manager`, `employee_self_service`,
 * `system_admin`), the freshly-signed-up hr_admin's own real
 * `POST /employees` + `POST /employees/:id/account` — Decision #12, the
 * HR-Admin-self-service counterpart to the Platform-Admin-only
 * `/platform/role-assignments` — create a second employee login with
 * whichever roleKey is asked for for, then the same login+MFA dance via
 * `POST /auth/login/employee` yields a real token for that role too.
 * `system_admin` is reachable this way specifically because
 * `CreateEmployeeLoginDto`'s `TENANT_ROLE_KEYS` whitelist allows it
 * (Decision #20) — none of the four roles this app's portal actually
 * gates navigation on require a Platform-Admin session to grant.
 *
 * Talks straight to the API over plain `fetch`, from the Node test
 * process (not through the browser `page`) — `API_BASE_URL` matches
 * `vite.config.ts`'s own dev-proxy target, so it tracks that file rather
 * than drifting into its own hardcoded assumption.
 */

export const API_BASE_URL = "http://localhost:4000";

export type TenantRoleKey = "hr_admin" | "line_manager" | "employee_self_service" | "system_admin";

type MfaSetupRequired = {
  status: "mfa_setup_required";
  mfaTicket: string;
  otpauthUrl: string;
  secretForManualEntry: string;
};

async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${text}`);
  }
  return json as T;
}

/** Drives `POST /auth/login` (or `/auth/login/employee`) through to a real
 * session token by completing the mandatory first-time MFA enrollment —
 * every fresh account lands on `mfa_setup_required`, never a token
 * directly (see this file's header comment). */
async function completeMfaEnrollment(login: MfaSetupRequired): Promise<string> {
  const code = await generateTotp({ secret: login.secretForManualEntry });
  const confirmed = await apiPost<{ status: "ok"; token: string }>("/auth/mfa/enroll/confirm", {
    mfaTicket: login.mfaTicket,
    code,
  });
  return confirmed.token;
}

let counter = 0;
/** Unique-enough per-process suffix so parallel test workers signing up at
 * the same millisecond don't collide on email/slug uniqueness. */
function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now()}-${process.pid}-${counter}`;
}

export type RealHrAdminSession = {
  token: string;
  companySlug: string;
  companyId: string;
};

/** Signs up a brand-new company via the real, public `/signup` endpoint and
 * returns a genuine hr_admin session token for it. */
export async function createHrAdminSession(): Promise<RealHrAdminSession> {
  const suffix = uniqueSuffix();
  const adminEmail = `e2e-hr-admin-${suffix}@example.com`;
  const adminPassword = "E2eTestPassw0rd!";

  const signup = await apiPost<{ companyId: string; slug: string }>("/signup", {
    companyName: `E2E Co ${suffix}`,
    adminFullName: "E2E HR Admin",
    adminEmail,
    adminPassword,
    // "starter" (self-signup's own default) only enables
    // dummy/employee/leave (`package_tier_modules`) — too narrow for a
    // suite that also exercises Payroll, Performance, and Recruitment.
    // "enterprise" is the one tier whose module set is a superset of
    // every other tier's, so every spec file's nav-link assertions find
    // what they expect regardless of which module they're testing.
    packageTier: "enterprise",
  });

  const login = await apiPost<MfaSetupRequired>("/auth/login", {
    email: adminEmail,
    password: adminPassword,
  });
  const token = await completeMfaEnrollment(login);

  return { token, companySlug: signup.slug, companyId: signup.companyId };
}

/** Using an hr_admin session, provisions a second employee login and grants
 * it `roleKey`, then logs in as that employee for a real session token
 * carrying that role. For `roleKey === "hr_admin"` this is unnecessary —
 * use the session from `createHrAdminSession()` directly instead. */
export async function createRoleSession(hrAdmin: RealHrAdminSession, roleKey: TenantRoleKey): Promise<string> {
  const suffix = uniqueSuffix();
  const employee = await apiPost<{ id: string; employeeNumber: string }>(
    "/employees",
    {
      firstName: "E2E",
      lastName: roleKey.replace(/_/g, " "),
      email: `e2e-${roleKey}-${suffix}@example.com`,
    },
    hrAdmin.token
  );

  const password = "E2eTestPassw0rd!";
  await apiPost(`/employees/${employee.id}/account`, { initialPassword: password, roleKeys: [roleKey] }, hrAdmin.token);

  const login = await apiPost<MfaSetupRequired>("/auth/login/employee", {
    companySlug: hrAdmin.companySlug,
    employeeNumber: employee.employeeNumber,
    password,
  });
  return completeMfaEnrollment(login);
}

/** Convenience one-shot: a real session token for any of the four tenant
 * roles, each in its own freshly-signed-up company (so tests never share
 * or collide on fixture data). Prefer `getSharedSession()` inside any
 * actual spec file — see that function's doc comment for why calling
 * this directly from parallel test files overruns `/signup`'s real rate
 * limit. */
export async function createSessionFor(roleKey: TenantRoleKey): Promise<string> {
  const hrAdmin = await createHrAdminSession();
  if (roleKey === "hr_admin") return hrAdmin.token;
  return createRoleSession(hrAdmin, roleKey);
}

let sharedSessionsCache: Record<TenantRoleKey, string> | null = null;

/** Reads the one real session-per-role minted ONCE by `global-setup.ts`
 * (wired into `playwright.config.ts`'s `globalSetup`) rather than signing
 * up a fresh company per test. `/signup`/`/auth/login` are both
 * rate-limited to 10 requests/minute per IP — real anti-abuse throttling
 * the API applies regardless of caller — and this app's e2e suite spans
 * many spec files that `fullyParallel: true` can run at once, so every
 * spec file minting its own sessions blows through that limit almost
 * immediately. This is what every spec file's login helper should call. */
export function getSharedSession(roleKey: TenantRoleKey): string {
  if (!sharedSessionsCache) {
    sharedSessionsCache = JSON.parse(readFileSync(SHARED_SESSIONS_FILE, "utf-8")) as Record<TenantRoleKey, string>;
  }
  return sharedSessionsCache[roleKey];
}

/** Puts a real session token into the page the same way a real login
 * would, then lands on `/app` with the portal nav rendered. Visits
 * `/login` first — a fresh page/tab starts at `about:blank`, an opaque
 * origin where every storage API throws `SecurityError` — exactly the
 * ordering bug `PortalHomePage.e2e.spec.ts`'s `loginAsRole` documents; the
 * key this writes (`aihxm.platformAdminToken`) is `api/client.ts`'s real
 * `TOKEN_KEY`, not the "authToken" placeholder every spec used before. */
export async function loginToApp(page: Page, token: string): Promise<void> {
  await page.goto("/login");
  await page.evaluate((t) => {
    localStorage.setItem("aihxm.platformAdminToken", t);
  }, token);
  await page.goto("/app");
  await page.waitForSelector("nav", { timeout: 10000 });
}
