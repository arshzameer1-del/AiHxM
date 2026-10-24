import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** BACKLOG52 - the employee asks, HR answers, the employee sees the answer. Every request is finished so none is left waiting. */
test.describe("Requests to HR", () => {
  test("a loan request becomes a real loan, a letter is uploaded, and a bad form is caught before sending", async ({ browser }) => {
    const stamp = Date.now();
    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const hrCtx = await browser.newContext();
    const hr = await hrCtx.newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));

    await ess.goto("/app/ess");
    await ess.getByRole("link", { name: /Request a Loan or Advance/ }).click();
    await expect(ess.getByRole("form", { name: "Request a loan or advance" })).toBeVisible();
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByRole("alert").filter({ hasText: "Enter the amount" })).toBeVisible();
    await ess.getByLabel("Amount (PKR)").fill("12000");
    await ess.getByLabel("Pay back over (months, optional)").fill("4");
    await ess.getByLabel("Why do you need it?").fill(`Laptop repair ${stamp}`);
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByText("Your request was sent to HR.")).toBeVisible();
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `Laptop repair ${stamp}` })).toContainText("Waiting for HR");

    await ess.getByRole("button", { name: "Letter or certificate" }).click();
    await ess.getByLabel("Which letter?").selectOption("employment_letter");
    await ess.getByLabel("Why do you need it?").fill(`Embassy ${stamp}`);
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `Embassy ${stamp}` })).toBeVisible();

    // HR: approve the loan
    await hr.goto("/app/employees/requests");
    const loanCard = hr.getByTestId("queue-card").filter({ hasText: `Laptop repair ${stamp}` });
    await expect(loanCard).toBeVisible();
    await loanCard.getByRole("button", { name: "Approve and create loan" }).click();
    await loanCard.getByRole("button", { name: "Create the loan" }).click();
    await expect(hr.getByTestId("queue-card").filter({ hasText: `Laptop repair ${stamp}` })).toHaveCount(0);

    // HR: upload the letter
    await hr.getByRole("tab", { name: "Letters and certificates" }).click();
    const letterCard = hr.getByTestId("queue-card").filter({ hasText: `Embassy ${stamp}` });
    await letterCard.getByRole("button", { name: "Upload signed letter" }).click();
    await letterCard.locator('input[type="file"]').setInputFiles({ name: `letter-${stamp}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 letter") });
    await letterCard.getByRole("button", { name: "Issue letter" }).click();
    await expect(hr.getByTestId("queue-card").filter({ hasText: `Embassy ${stamp}` })).toHaveCount(0);

    // the employee sees both answers
    await ess.reload();
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `Laptop repair ${stamp}` })).toContainText("Done");
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `Laptop repair ${stamp}` })).toContainText("set up the loan");
    const letterRow = ess.getByTestId("service-request-row").filter({ hasText: `Embassy ${stamp}` });
    await expect(letterRow).toContainText("Done");
    await expect(letterRow.getByRole("button", { name: "Download letter" })).toBeVisible();
  });

  test("a request can be refused with a reason or withdrawn, and a privacy request goes through to completed", async ({ browser }) => {
    const stamp = Date.now();
    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const hrCtx = await browser.newContext();
    const hr = await hrCtx.newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));

    await ess.goto("/app/ess/requests?new=letter");
    await ess.getByLabel("Which letter?").selectOption("noc");
    await ess.getByLabel("Why do you need it?").fill(`NOC refuse ${stamp}`);
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `NOC refuse ${stamp}` })).toBeVisible();
    await ess.getByRole("button", { name: "Letter or certificate" }).click();
    await ess.getByLabel("Which letter?").selectOption("address_proof");
    await ess.getByLabel("Why do you need it?").fill(`Withdraw me ${stamp}`);
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `Withdraw me ${stamp}` })).toBeVisible();
    await ess.getByTestId("service-request-row").filter({ hasText: `Withdraw me ${stamp}` }).getByRole("button", { name: "Withdraw" }).click();
    await expect(ess.getByTestId("service-request-row").filter({ hasText: `Withdraw me ${stamp}` })).toContainText("Withdrawn");

    await hr.goto("/app/employees/requests?tab=letters");
    const card = hr.getByTestId("queue-card").filter({ hasText: `NOC refuse ${stamp}` });
    await card.getByRole("button", { name: "Not approve" }).click();
    await card.getByRole("button", { name: "Not approve" }).last().click();
    await expect(card.getByRole("alert")).toContainText("Tell the employee why");
    await card.getByLabel("Reason the employee will see").fill("Please ask your manager first");
    await card.getByRole("button", { name: "Not approve" }).last().click();
    await expect(hr.getByTestId("queue-card").filter({ hasText: `NOC refuse ${stamp}` })).toHaveCount(0);

    await ess.reload();
    const refused = ess.getByTestId("service-request-row").filter({ hasText: `NOC refuse ${stamp}` });
    await expect(refused).toContainText("Not approved");
    await expect(refused).toContainText("Please ask your manager first");

    // privacy request
    await ess.getByRole("button", { name: "Privacy request" }).click();
    await ess.getByLabel("Details").fill(`Send me my data ${stamp}`);
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByTestId("privacy-request-row").filter({ hasText: `Send me my data ${stamp}` })).toContainText("Being reviewed");

    await hr.goto("/app/employees/requests?tab=privacy");
    const dsr = hr.getByTestId("privacy-card").filter({ hasText: `Send me my data ${stamp}` });
    await dsr.getByRole("button", { name: "Approve", exact: true }).click();
    const approved = hr.getByTestId("privacy-card").filter({ hasText: `Send me my data ${stamp}` });
    await approved.getByLabel("What was done").fill("Emailed the export");
    await approved.getByRole("button", { name: "Mark completed" }).click();

    await ess.reload();
    const done = ess.getByTestId("privacy-request-row").filter({ hasText: `Send me my data ${stamp}` });
    await expect(done).toContainText("Done");
    await expect(done).toContainText("Emailed the export");
  });
});
