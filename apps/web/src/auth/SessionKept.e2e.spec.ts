import { expect, test } from "@playwright/test";
import { createHrAdminSession } from "../e2e-support/real-session";

/**
 * A stored session survives a server that cannot be reached (phone offline, free server still waking up): the person sees a Retry screen
 * instead of being signed out. Only a real 401 ends the session.
 */
const TOKEN_KEY = "aihxm.platformAdminToken";
let token = "";
test.beforeAll(async () => {
  token = (await createHrAdminSession()).token;
});

async function openWithToken(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.evaluate(([k, t]) => localStorage.setItem(k, t), [TOKEN_KEY, token]);
}

test("when the identity check cannot connect, the session is kept and Try again signs back in", async ({ page }) => {
  await openWithToken(page);
  await page.route("**/api/auth/me", (route) => route.abort("connectionfailed"));
  await page.goto("/app");
  await expect(page.getByTestId("server-unreachable")).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBe(token);

  await page.unroute("**/api/auth/me");
  await page.getByTestId("server-retry").click();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
});

test("a 503 while the server starts keeps the session too", async ({ page }) => {
  await openWithToken(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Service unavailable" }) }));
  await page.goto("/app");
  await expect(page.getByTestId("server-unreachable")).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBe(token);
});

test("a 401 still signs the person out", async ({ page }) => {
  await openWithToken(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Unauthorized" }) }));
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBeNull();
});
