import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Form settings: HR changes a field, the employee's form follows it, and the server holds the rule too. */
const TOUCHED = ["helpdesk_ticket/body", "leave_request/reason", "travel_request/destination", "travel_request/estOtherCost"];

test.describe("Form settings", () => {
  // These settings live on the shared test company, so put them back even when a test fails half way.
  test.afterEach(async ({ request }) => {
    for (const k of TOUCHED) {
      await request.delete(`http://localhost:4000/form-settings/${k}`, { headers: { Authorization: `Bearer ${getSharedSession("hr_admin")}` } });
    }
  });

  test("HR relabels and explains the help desk question, the employee sees it, and HR can put it back", async ({ browser }) => {
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/configuration-center/form-settings");
    await expect(hr.getByTestId("form-settings")).toBeVisible();
    const field = hr.getByTestId("fs-helpdesk_ticket-body");
    await field.getByLabel("Label shown").fill("Tell us more");
    await field.getByLabel("Help text").fill("Include dates and amounts if you can.");
    await field.getByRole("button", { name: /^Save / }).click();
    await expect(hr.getByRole("status")).toContainText("Saved");
    await expect(hr.getByTestId("fs-helpdesk_ticket-body")).toContainText("Changed");

    await ess.goto("/app/ess/helpdesk");
    await expect(ess.getByLabel("Tell us more")).toBeVisible();
    await expect(ess.getByText("Include dates and amounts if you can.")).toBeVisible();

    await hr.getByTestId("fs-helpdesk_ticket-body").getByRole("button", { name: "Back to default" }).click();
    await expect(hr.getByTestId("fs-helpdesk_ticket-body")).not.toContainText("Changed");
    await ess.goto("/app/ess/helpdesk");
    await expect(ess.getByLabel("Your question")).toBeVisible();
  });

  test("a required note is enforced by the server, not only by the screen", async ({ browser, request }) => {
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    await hr.goto("/app/configuration-center/form-settings");
    const reason = hr.getByTestId("fs-leave_request-reason");
    await reason.getByLabel("Required").check();
    await reason.getByRole("button", { name: /^Save / }).click();
    await expect(hr.getByRole("status")).toContainText("Saved");

    // the same rule applies when the API is called directly, not only on the screen
    const res = await request.post("http://localhost:4000/leave-requests", {
      headers: { Authorization: `Bearer ${getSharedSession("employee_self_service")}` },
      data: { employeeId: "00000000-0000-0000-0000-000000000000", leaveType: "annual", startDate: "2031-03-03", endDate: "2031-03-03" },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("New Note is required");

    await hr.getByTestId("fs-leave_request-reason").getByRole("button", { name: "Back to default" }).click();
    await expect(hr.getByTestId("fs-leave_request-reason")).not.toContainText("Changed");
  });

  test("travel: HR hides one field and relabels another, the travel form follows, and HR puts both back", async ({ browser }) => {
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/configuration-center/form-settings");
    const other = hr.getByTestId("fs-travel_request-estOtherCost");
    await other.getByLabel("Hide this field").check();
    await other.getByRole("button", { name: /^Save / }).click();
    await expect(hr.getByRole("status")).toContainText("Saved");
    const dest = hr.getByTestId("fs-travel_request-destination");
    await dest.getByLabel("Label shown").fill("Where to?");
    await dest.getByRole("button", { name: /^Save / }).click();
    await expect(hr.getByTestId("fs-travel_request-destination")).toContainText("Changed");

    await ess.goto("/app/travel");
    await ess.getByRole("button", { name: "Ask to travel" }).click();
    await expect(ess.getByLabel("Where to?")).toBeVisible();
    await expect(ess.getByLabel("Other expected costs (PKR)")).toHaveCount(0);

    await hr.getByTestId("fs-travel_request-estOtherCost").getByRole("button", { name: "Back to default" }).click();
    await hr.getByTestId("fs-travel_request-destination").getByRole("button", { name: "Back to default" }).click();
    await expect(hr.getByTestId("fs-travel_request-destination")).not.toContainText("Changed");
    await ess.goto("/app/travel");
    await ess.getByRole("button", { name: "Ask to travel" }).click();
    await expect(ess.getByLabel("Destination")).toBeVisible();
    await expect(ess.getByLabel("Other expected costs (PKR)")).toBeVisible();
  });
});
