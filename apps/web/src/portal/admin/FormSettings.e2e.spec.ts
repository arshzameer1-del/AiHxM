import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Form settings: HR changes a field, the employee's form follows it, and the server holds the rule too. */
test.describe("Form settings", () => {
  test("HR relabels and explains the help desk question, the employee sees it, and HR can put it back", async ({ browser }) => {
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/configuration-center/form-settings");
    await expect(hr.getByTestId("form-settings")).toBeVisible();
    const field = hr.getByTestId("fs-body");
    await field.getByLabel("Label shown").fill("Tell us more");
    await field.getByLabel("Help text").fill("Include dates and amounts if you can.");
    await field.getByRole("button", { name: /^Save / }).click();
    await expect(hr.getByRole("status")).toContainText("Saved");
    await expect(hr.getByTestId("fs-body")).toContainText("Changed");

    await ess.goto("/app/ess/helpdesk");
    await expect(ess.getByLabel("Tell us more")).toBeVisible();
    await expect(ess.getByText("Include dates and amounts if you can.")).toBeVisible();

    await hr.getByTestId("fs-body").getByRole("button", { name: "Back to default" }).click();
    await expect(hr.getByTestId("fs-body")).not.toContainText("Changed");
    await ess.goto("/app/ess/helpdesk");
    await expect(ess.getByLabel("Your question")).toBeVisible();
  });

  test("a required note is enforced by the server, not only by the screen", async ({ browser, request }) => {
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    await hr.goto("/app/configuration-center/form-settings");
    const reason = hr.getByTestId("fs-reason");
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

    await hr.getByTestId("fs-reason").getByRole("button", { name: "Back to default" }).click();
    await expect(hr.getByTestId("fs-reason")).not.toContainText("Changed");
  });
});
