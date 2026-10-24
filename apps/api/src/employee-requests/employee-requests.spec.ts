import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { DataSubjectRequestsService } from "../data-subject-requests/data-subject-requests.service";
import { EmployeesService } from "../employees/employees.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { PayrollDocumentsService } from "../payroll/payroll-documents.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { EmployeeRequestsService } from "./employee-requests.service";

/** BACKLOG52 against real Postgres: loan / advance / letter requests, HR decisions and what they create. */
describe("Employee requests to HR", () => {
  let f: PayrollFixture;
  let svc: EmployeeRequestsService;
  let employees: EmployeesService;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let other: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let me: { id: string; employeeNumber: string };
  let colleague: { id: string; employeeNumber: string };

  const inboxOf = async (userId: string) =>
    f.sql<{ title: string; category: string; link: string | null }>("SELECT title, category, link FROM user_notifications WHERE user_account_id = $1 ORDER BY created_at", [userId]);
  const pdf = (name = "letter.pdf") => ({ originalname: name, mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 test"), size: 13 });

  beforeAll(async () => {
    f = await buildPayrollFixture("req52");
    employees = new EmployeesService(f.db, f.rbac, f.entitlements, f.audit, new LocalFileStorageService());
    const mailer = { isConfigured: () => false, sendMail: async () => undefined } as never;
    svc = new EmployeeRequestsService(
      f.db, f.rbac, f.entitlements, f.audit, f.loans, employees,
      new PayrollDocumentsService(f.db, f.rbac, f.entitlements, f.audit),
      new UserNotificationsService(f.db, mailer)
    );
    ess = await f.makeUser("ess", ["employee_self_service"]);
    other = await f.makeUser("other", ["employee_self_service"]);
    me = await f.createEmployee({ userAccountId: ess.uid, monthlySalary: 90000 });
    colleague = await f.createEmployee({ userAccountId: other.uid, monthlySalary: 80000 });
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("a loan request waits for HR; approving it creates the real loan and tells the employee", async () => {
    await expect(svc.submit(ess, { kind: "loan", purpose: "House repair" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submit(ess, { kind: "loan", amount: 60000, purpose: "  " })).rejects.toBeInstanceOf(BadRequestException);

    const req = await svc.submit(ess, { kind: "loan", amount: 60000, installmentsCount: 6, purpose: "House repair" });
    expect(req).toMatchObject({ status: "pending", kind: "loan", amount: 60000, installmentsCount: 6, employeeId: me.id });
    expect(await f.sql("SELECT 1 FROM employee_loans WHERE employee_id = $1", [me.id])).toHaveLength(0);
    expect((await inboxOf(f.hr.sub as string)).some((n) => n.category === "hr_inbox" && n.link === "/app/employees/requests")).toBe(true);

    const queue = await svc.list(f.hr, { status: "pending", kind: "loan" });
    expect(queue.map((r) => r.id)).toContain(req.id);

    const done = await svc.approveLoan(f.hr, req.id, { note: "Approved by the CFO" });
    expect(done.status).toBe("fulfilled");
    expect(done.decisionNote).toBe("Approved by the CFO");
    expect(done.loanId).toBeTruthy();
    const loan = (await f.sql<{ principal_amount: string; installments_count: number; status: string; reason: string }>(
      "SELECT principal_amount, installments_count, status, reason FROM employee_loans WHERE id = $1", [done.loanId]))[0];
    expect(Number(loan.principal_amount)).toBe(60000);
    expect(loan).toMatchObject({ installments_count: 6, status: "active", reason: "House repair" });

    expect((await svc.listMine(ess)).find((r) => r.id === req.id)?.status).toBe("fulfilled");
    expect((await inboxOf(ess.uid)).some((n) => n.category === "request_decisions" && /approved/i.test(n.title))).toBe(true);
    await expect(svc.approveLoan(f.hr, req.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("a loan that breaks the loan-type limits stays open until HR adjusts it", async () => {
    const type = (await f.sql<{ id: string }>(
      "INSERT INTO loan_types (company_id, code, name, kind, max_installments, sort_order) VALUES ($1, 'ltd3', 'Limited advance', 'salary_advance', 3, 5) RETURNING id", [f.companyId]))[0];
    await expect(svc.submit(ess, { kind: "loan", amount: 1000, purpose: "x", loanTypeId: type.id })).rejects.toBeInstanceOf(BadRequestException);

    const types = await svc.requestableLoanTypes(ess);
    expect(types.find((t) => t.id === type.id)).toMatchObject({ name: "Limited advance", kind: "salary_advance", maxInstallments: 3 });

    const req = await svc.submit(ess, { kind: "salary_advance", amount: 30000, installmentsCount: 6, loanTypeId: type.id, purpose: "School fees" });
    await expect(svc.approveLoan(f.hr, req.id)).rejects.toBeInstanceOf(BadRequestException);
    expect((await svc.listMine(ess)).find((r) => r.id === req.id)?.status).toBe("pending");
    expect(await f.sql("SELECT 1 FROM employee_loans WHERE employee_id = $1 AND loan_type_id = $2", [me.id, type.id])).toHaveLength(0);

    const done = await svc.approveLoan(f.hr, req.id, { installmentsCount: 3 });
    expect(done.status).toBe("fulfilled");
    expect(done.loanTypeName).toBe("Limited advance");
  });

  it("HR needs a reason to refuse; the employee sees it and cannot withdraw a decided request", async () => {
    const req = await svc.submit(ess, { kind: "loan", amount: 500000, installmentsCount: 10, purpose: "Car" });
    await expect(svc.reject(f.hr, req.id, "  ")).rejects.toBeInstanceOf(BadRequestException);
    const no = await svc.reject(f.hr, req.id, "Above the policy limit");
    expect(no).toMatchObject({ status: "rejected", decisionNote: "Above the policy limit" });
    expect((await inboxOf(ess.uid)).some((n) => /did not approve/i.test(n.title))).toBe(true);
    await expect(svc.cancel(ess, req.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.reject(f.hr, req.id, "again")).rejects.toBeInstanceOf(ConflictException);
  });

  it("an employee can withdraw their own pending request, nobody else's", async () => {
    const req = await svc.submit(ess, { kind: "letter", letterType: "noc", purpose: "Visa application" });
    await expect(svc.cancel(other, req.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.cancel(ess, req.id)).status).toBe("cancelled");
    expect(await svc.listMine(other)).toHaveLength(0);
  });

  it("a salary certificate is generated from payroll and appears in the employee's payroll documents", async () => {
    const req = await svc.submit(ess, { kind: "letter", letterType: "salary_certificate", addressedTo: "HBL Gulberg Branch", purpose: "Bank account opening" });
    const done = await svc.issueSalaryCertificate(f.hr, req.id, { note: "Issued today" });
    expect(done).toMatchObject({ status: "fulfilled", letterType: "salary_certificate" });
    expect(done.generatedDocumentId).toBeTruthy();

    const docs = new PayrollDocumentsService(f.db, f.rbac, f.entitlements, f.audit);
    const mine = await docs.listMine(ess);
    const cert = mine.find((d) => d.id === done.generatedDocumentId)!;
    expect(cert.documentType).toBe("salary_certificate");
    expect((await docs.get(ess, cert.id)).content).toContain("HBL Gulberg Branch");
    // a colleague cannot read it
    expect((await docs.listMine(other)).map((d) => d.id)).not.toContain(cert.id);
    expect((await inboxOf(ess.uid)).some((n) => /ready/i.test(n.title))).toBe(true);
  });

  it("any other letter is uploaded and lands in the employee's own documents", async () => {
    const req = await svc.submit(ess, { kind: "letter", letterType: "employment_letter", purpose: "Embassy" });
    await expect(svc.issueSalaryCertificate(f.hr, req.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.issueLetter(f.hr, req.id, undefined as never)).rejects.toBeInstanceOf(BadRequestException);

    const done = await svc.issueLetter(f.hr, req.id, pdf("employment-letter.pdf"), "Signed by the CEO");
    expect(done.status).toBe("fulfilled");
    expect(done.employeeDocumentId).toBeTruthy();
    const vault = await employees.listDocuments(ess, me.id);
    const stored = vault.find((d) => d.id === done.employeeDocumentId)!;
    expect(stored.fileName).toBe("employment-letter.pdf");
    expect(stored.reviewStatus).toBe("approved");
    await expect(svc.approveLoan(f.hr, (await svc.submit(ess, { kind: "letter", letterType: "noc", purpose: "p" })).id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an employee cannot hold more than five open requests", async () => {
    const who = await f.makeUser("cap", ["employee_self_service"]);
    await f.createEmployee({ userAccountId: who.uid, monthlySalary: 50000 });
    for (let i = 0; i < 5; i += 1) await svc.submit(who, { kind: "letter", letterType: "other", purpose: `n${i}` });
    await expect(svc.submit(who, { kind: "letter", letterType: "other", purpose: "one more" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("only HR can read the queue or decide, and a login with no employee record cannot ask", async () => {
    await expect(svc.list(ess)).rejects.toBeInstanceOf(ForbiddenException);
    const req = await svc.submit(other, { kind: "letter", letterType: "address_proof", purpose: "Utility bill" });
    await expect(svc.reject(ess, req.id, "no")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.issueLetter(ess, req.id, pdf())).rejects.toBeInstanceOf(ForbiddenException);
    const stray = await f.makeUser("stray", ["employee_self_service"]);
    await expect(svc.submit(stray, { kind: "letter", letterType: "other", purpose: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(colleague.id).toBeTruthy();
  });

  it("a privacy request still reaches HR when the company has no approval route for it", async () => {
    const dsr = new DataSubjectRequestsService(f.db, f.rbac, f.entitlements, f.audit, f.workflow, new UserNotificationsService(f.db, { isConfigured: () => false } as never));
    const sent = await dsr.submit(ess, { employeeId: me.id, requestType: "correction", description: "My date of birth is wrong" });
    expect(sent).toMatchObject({ status: "pending", workflowInstanceId: null });
    expect((await dsr.listQueue(f.hr, { status: "pending" })).map((r) => r.id)).toContain(sent.id);

    await expect(dsr.decide(ess, sent.id, { decision: "approved" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dsr.decide(f.hr, sent.id, { decision: "rejected" })).rejects.toBeInstanceOf(BadRequestException);
    expect((await dsr.decide(f.hr, sent.id, { decision: "approved", comment: "We will fix it" })).status).toBe("approved");
    await expect(dsr.decide(f.hr, sent.id, { decision: "approved" })).rejects.toBeInstanceOf(ConflictException);
    const done = await dsr.fulfill(f.hr, sent.id, { fulfillmentNote: "Corrected on the employee file" });
    expect(done.status).toBe("fulfilled");
    expect((await inboxOf(ess.uid)).some((n) => /privacy request was approved/.test(n.title))).toBe(true);
  });
});
