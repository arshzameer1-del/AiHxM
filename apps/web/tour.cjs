const { chromium } = require("playwright");
const { generateSync } = require("otplib");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:5173";
const OUT = path.join(__dirname, "screenshots");
const SECRETS_FILE = path.join(__dirname, ".demo-secrets.json");

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSecret(email, secret) {
  const s = loadSecrets();
  s[email] = secret;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log("📸", name);
}

async function loginFlow(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(1000);

  // Either mfa_setup_required (first time) or mfa_required (returning)
  const secretCode = page.locator("code");
  const hasSetup = await secretCode.count().then((c) => c > 0).catch(() => false);
  if (hasSetup) {
    const secret = (await secretCode.first().innerText()).trim();
    saveSecret(email, secret);
    await shot(page, `mfa-setup-${email.split("@")[0]}.png`);
    const code = generateSync({ secret });
    await page.locator('input[inputmode="numeric"]').fill(code);
    await page.getByRole("button", { name: /Confirm & sign in/i }).click();
  } else {
    const secrets = loadSecrets();
    const secret = secrets[email];
    const code = generateSync({ secret });
    await page.locator('input[inputmode="numeric"]').fill(code);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.waitForTimeout(1500);
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // 1. Public signup page
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle" });
  await shot(page, "01-signup.png");

  // 2. Login page
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await shot(page, "02-login.png");

  // 3. Log in as hr_admin (Ayesha) — already MFA-enrolled
  await loginFlow(page, "ayesha@zamantextiles.pk", "DemoPass12345");
  await shot(page, "03-portal-home-hr-admin.png");

  // 4. Employee list
  await page.goto(`${BASE}/app/employees`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "04-employee-list.png");

  // 5. Employee detail (first row)
  const firstRow = page.locator("table tbody tr, [role='row']").first();
  const rowLink = page.locator("a[href^='/app/employees/']").first();
  if (await rowLink.count()) {
    await rowLink.click();
    await page.waitForTimeout(800);
    await shot(page, "05-employee-detail.png");
  }

  // 6. Leave & Attendance
  await page.goto(`${BASE}/app/leave`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "06-leave-attendance.png");

  // 7. Recruitment
  await page.goto(`${BASE}/app/recruitment`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "07-recruitment.png");

  // 8. Payroll
  await page.goto(`${BASE}/app/payroll`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await shot(page, "08-payroll.png");

  // 9. Performance
  await page.goto(`${BASE}/app/performance`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "09-performance.png");

  // 10. System Admin
  await page.goto(`${BASE}/app/system-admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "10-system-admin.png");

  // 11. Log out and log in as employee_self_service (Hira) — first-time MFA setup
  await page.evaluate(() => localStorage.clear());
  await loginFlow(page, "hira.malik@zamantextiles.pk", "EmployeeDemo123");
  await shot(page, "11-portal-home-employee.png");

  await page.goto(`${BASE}/app/profile`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "12-my-profile.png");

  await page.goto(`${BASE}/app/payroll`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "13-my-payslips.png");

  await browser.close();
  console.log("\nAll screenshots saved to", OUT);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
