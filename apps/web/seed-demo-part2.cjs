const { j, login } = require("./demo-auth.cjs");

async function main() {
  console.log("Logging in as Ayesha (hr_admin)...");
  const hrToken = await login("ayesha@zamantextiles.pk", "DemoPass12345");
  console.log("✓ hr_admin session established");

  const employees = await j("GET", "/employees", undefined, hrToken);
  const hira = employees.find((e) => e.email === "hira.malik@zamantextiles.pk");
  const usman = employees.find((e) => e.email === "usman.tariq@zamantextiles.pk");

  // --- Default leave policy (required before any leave request can route) ---
  await j(
    "POST",
    "/leave-policies",
    { name: "Standard Policy", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true },
    hrToken
  ).then(
    () => console.log("✓ Default leave policy created"),
    (e) => {
      if (String(e.message).includes("409")) console.log("… leave policy already exists, skipping");
      else throw e;
    }
  );

  // --- Workflow template: leave requests route to hr_admin for decision ---
  // (hr_admin itself can't call /system-admin/roles — that's system_admin-
  // only — so this ID is looked up directly; it's a fixed, migration-seeded
  // catalog row, not tenant data.)
  const hrAdminRole = { id: "8f74e59e-55ad-4442-9242-ce919ea583cf" };
  {
    const existing = await j("GET", "/workflow/templates/leave_request", undefined, hrToken).catch(() => null);
    if (existing) {
      console.log("… leave_request template already exists, skipping");
    } else {
      await j(
        "POST",
        "/workflow/templates",
        {
          key: "leave_request",
          name: "Leave Request Approval",
          objectKey: "leave_request",
          steps: [
            { stepOrder: 1, name: "HR Review", approvers: [{ approverType: "role", roleId: hrAdminRole.id }] },
          ],
        },
        hrToken
      );
      console.log("✓ Leave request workflow template created");
    }
  }

  // --- Leave requests ---
  const existingLeave = await j("GET", "/leave-requests", undefined, hrToken).catch(() => []);
  const leaveList = Array.isArray(existingLeave) ? existingLeave : existingLeave.requests ?? [];
  if (leaveList.some((r) => r.employeeId === hira.id)) {
    console.log("… Hira's leave request already exists, skipping");
  } else {
    const leaveReq = await j(
      "POST",
      "/leave-requests",
      { employeeId: hira.id, leaveType: "annual", startDate: "2026-09-22", endDate: "2026-09-24", reason: "Family wedding out of town" },
      hrToken
    );
    console.log("✓ Leave request submitted:", JSON.stringify(leaveReq).slice(0, 200));
  }

  await j("POST", `/employees/${usman.id}/account`, { initialPassword: "EmployeeDemo123", roleKeys: ["line_manager"] }, hrToken).then(
    () => console.log("✓ line_manager login created for Usman Tariq"),
    (e) => {
      if (String(e.message).includes("409") || String(e.message).includes("already") || String(e.message).includes("duplicate")) console.log("… Usman already has a login, skipping");
      else throw e;
    }
  );

  if (leaveList.some((r) => r.employeeId === usman.id)) {
    console.log("… Usman's leave request already exists, skipping");
  } else {
    const leaveReq2 = await j(
      "POST",
      "/leave-requests",
      { employeeId: usman.id, leaveType: "sick", startDate: "2026-09-15", endDate: "2026-09-16", reason: "Fever" },
      hrToken
    );
    console.log("✓ Second leave request submitted:", JSON.stringify(leaveReq2).slice(0, 200));
  }

  // --- Recruitment ---
  {
    const existing = await j("GET", "/workflow/templates/job_requisition", undefined, hrToken).catch(() => null);
    if (existing) {
      console.log("… job_requisition template already exists, skipping");
    } else {
      await j(
        "POST",
        "/workflow/templates",
        {
          key: "job_requisition",
          name: "Job Requisition Approval",
          objectKey: "job_requisition",
          steps: [
            { stepOrder: 1, name: "HR Review", approvers: [{ approverType: "role", roleId: hrAdminRole.id }] },
          ],
        },
        hrToken
      );
      console.log("✓ Job requisition workflow template created");
    }
  }

  const existingRequisitions = await j("GET", "/job-requisitions", undefined, hrToken).catch(() => []);
  const reqList = Array.isArray(existingRequisitions) ? existingRequisitions : existingRequisitions.requisitions ?? [];
  let requisition = reqList.find((r) => r.title === "Quality Assurance Officer");

  if (requisition) {
    console.log("… Quality Assurance Officer requisition already exists, skipping creation");
    if (requisition.status !== "approved" && requisition.status !== "open") {
      await j("PATCH", `/job-requisitions/${requisition.id}/decision`, { decision: "approved" }, hrToken).catch((e) =>
        console.log("  (approval attempt:", e.message, ")")
      );
      console.log("✓ Existing requisition approved");
    }
  } else {
    requisition = await j(
      "POST",
      "/job-requisitions",
      { title: "Quality Assurance Officer", department: "Production", headcount: 1, salaryBand: "PKR 90,000 - 120,000", justification: "New export order requires a dedicated QA line.", hiringManagerId: usman.id },
      hrToken
    );
    console.log("✓ Job requisition created:", requisition.id);
    await j("POST", `/job-requisitions/${requisition.id}/submit`, {}, hrToken);
    console.log("✓ Job requisition submitted for approval");
    await j("PATCH", `/job-requisitions/${requisition.id}/decision`, { decision: "approved" }, hrToken);
    console.log("✓ Job requisition approved");
  }

  const existingCandidates = await j("GET", "/candidates", undefined, hrToken).catch(() => []);
  const candList = Array.isArray(existingCandidates) ? existingCandidates : existingCandidates.candidates ?? [];
  const candidates = [
    { firstName: "Zara", lastName: "Anwar", email: "zara.anwar@example.com", phone: "0301-1234567" },
    { firstName: "Danish", lastName: "Ali", email: "danish.ali@example.com", phone: "0333-7654321" },
  ];
  const candidateIds = [];
  for (const c of candidates) {
    const existing = candList.find((x) => x.email === c.email);
    if (existing) {
      candidateIds.push(existing.id);
      console.log(`… Candidate ${c.firstName} ${c.lastName} already exists, skipping`);
      continue;
    }
    const cand = await j("POST", "/candidates", c, hrToken);
    candidateIds.push(cand.id);
    console.log(`✓ Candidate created: ${c.firstName} ${c.lastName}`);
  }

  const existingApps = await j("GET", `/applications?requisitionId=${requisition.id}`, undefined, hrToken).catch(() => []);
  const appList = Array.isArray(existingApps) ? existingApps : existingApps.applications ?? [];
  if (appList.length > 0) {
    console.log("… Applications for this requisition already exist, skipping");
  } else {
    const app1 = await j("POST", "/applications", { requisitionId: requisition.id, candidateId: candidateIds[0] }, hrToken);
    await j("POST", "/applications", { requisitionId: requisition.id, candidateId: candidateIds[1] }, hrToken);
    await j("PATCH", `/applications/${app1.id}/stage`, { stage: "interview" }, hrToken);
    console.log("✓ Applications created; one moved to Interview stage");
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
