const { generateSync } = require("otplib");

const API = "http://localhost:4000";

async function j(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function loginWithMfaSetup(email, password) {
  const first = await j("POST", "/auth/login", { email, password });
  if (first.status !== "mfa_setup_required") {
    throw new Error(`expected mfa_setup_required, got ${JSON.stringify(first)}`);
  }
  const code = generateSync({ secret: first.secretForManualEntry });
  const confirmed = await j("POST", "/auth/mfa/enroll/confirm", {
    mfaTicket: first.mfaTicket,
    code,
  });
  return confirmed.token;
}

async function main() {
  console.log("Logging in as hr_admin (Ayesha)...");
  const hrToken = await loginWithMfaSetup("ayesha@zamantextiles.pk", "DemoPass12345");
  console.log("✓ hr_admin session established");

  const me = await j("GET", "/auth/me", undefined, hrToken);
  console.log("Identity:", JSON.stringify(me));

  // --- Employees ---
  const employeesToCreate = [
    { firstName: "Bilal", lastName: "Sheikh", email: "bilal.sheikh@zamantextiles.pk", department: "Executive", designation: "Chief Executive Officer", employmentType: "permanent", dateOfJoining: "2019-01-15" },
    { firstName: "Sana", lastName: "Iqbal", email: "sana.iqbal@zamantextiles.pk", department: "Human Resources", designation: "HR Manager", employmentType: "permanent", dateOfJoining: "2020-03-01" },
    { firstName: "Usman", lastName: "Tariq", email: "usman.tariq@zamantextiles.pk", department: "Production", designation: "Production Manager", employmentType: "permanent", dateOfJoining: "2019-06-10" },
    { firstName: "Hira", lastName: "Malik", email: "hira.malik@zamantextiles.pk", department: "Finance", designation: "Finance Executive", employmentType: "permanent", dateOfJoining: "2021-02-20" },
    { firstName: "Fahad", lastName: "Qureshi", email: "fahad.qureshi@zamantextiles.pk", department: "Sales", designation: "Sales Executive", employmentType: "contract", dateOfJoining: "2022-08-01" },
    { firstName: "Mariam", lastName: "Yousaf", email: "mariam.yousaf@zamantextiles.pk", department: "Production", designation: "Line Supervisor", employmentType: "permanent", dateOfJoining: "2020-11-05" },
  ];

  const created = [];
  for (const emp of employeesToCreate) {
    const result = await j("POST", "/employees", emp, hrToken);
    created.push({ ...emp, id: result.id, employeeNumber: result.employeeNumber });
    console.log(`✓ Employee created: ${emp.firstName} ${emp.lastName} (${result.employeeNumber})`);
  }

  // Set manager for a couple of employees (Usman & Mariam report to Bilal/Sana chain informally skipped for simplicity)
  const ceo = created.find((e) => e.email.startsWith("bilal"));
  for (const emp of created.filter((e) => e.email !== ceo.email)) {
    await j("PATCH", `/employees/${emp.id}`, { managerId: ceo.id }, hrToken);
  }
  console.log("✓ Reporting lines set (CEO as manager for demo simplicity)");

  // --- Payroll: compensation for everyone ---
  const salaries = {
    "bilal.sheikh@zamantextiles.pk": 850000,
    "sana.iqbal@zamantextiles.pk": 180000,
    "usman.tariq@zamantextiles.pk": 220000,
    "hira.malik@zamantextiles.pk": 130000,
    "fahad.qureshi@zamantextiles.pk": 95000,
    "mariam.yousaf@zamantextiles.pk": 75000,
  };
  for (const emp of created) {
    await j(
      "POST",
      "/payroll/compensation",
      { employeeId: emp.id, monthlySalary: salaries[emp.email], effectiveFrom: emp.dateOfJoining },
      hrToken
    );
  }
  console.log("✓ Compensation set for all employees");

  // --- Payroll run: create, calculate, finalize for last month ---
  const run = await j(
    "POST",
    "/payroll/runs",
    { periodStart: "2026-08-01", periodEnd: "2026-08-31" },
    hrToken
  );
  console.log("✓ Payroll run created:", run.id);
  const calculated = await j("POST", `/payroll/runs/${run.id}/calculate`, {}, hrToken);
  console.log("✓ Payroll run calculated:", JSON.stringify(calculated).slice(0, 300));
  const finalized = await j("POST", `/payroll/runs/${run.id}/finalize`, {}, hrToken);
  console.log("✓ Payroll run finalized:", finalized.status);

  // A second, current-period run left in draft so the UI shows both states
  const draftRun = await j(
    "POST",
    "/payroll/runs",
    { periodStart: "2026-09-01", periodEnd: "2026-09-30" },
    hrToken
  );
  console.log("✓ Draft payroll run created for September:", draftRun.id);

  // --- Leave requests ---
  const employeeSelfId = created.find((e) => e.email.startsWith("hira")).id;
  const leaveReq = await j(
    "POST",
    "/leave-requests",
    { employeeId: employeeSelfId, leaveType: "annual", startDate: "2026-09-22", endDate: "2026-09-24", reason: "Family wedding out of town" },
    hrToken
  ).catch((e) => {
    console.log("leave-requests create failed (non-fatal for tour):", e.message);
    return null;
  });
  if (leaveReq) console.log("✓ Leave request created:", leaveReq.id ?? JSON.stringify(leaveReq));

  // --- Employee login for self-service tour (Hira) ---
  const hira = created.find((e) => e.email.startsWith("hira"));
  await j("POST", `/employees/${hira.id}/account`, { initialPassword: "EmployeeDemo123", roleKeys: ["employee_self_service"] }, hrToken);
  console.log("✓ employee_self_service login created for Hira Malik:", hira.email);

  console.log("\n=== DEMO CREDENTIALS ===");
  console.log("HR Admin:  ayesha@zamantextiles.pk / DemoPass12345");
  console.log("Employee:  hira.malik@zamantextiles.pk / EmployeeDemo123");
  console.log("Company slug:", "zaman-textiles");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
