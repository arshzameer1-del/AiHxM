import { BadRequestException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { AssistantService, detectIntent } from "./assistant.service";

describe("intent rules", () => {
  it.each([
    ["How many leaves do I have left?", "leave_balance"],
    ["meri chutti kitni bachi hai", "leave_balance"],
    ["when is the next holiday", "next_holiday"],
    ["Eid ki chutti kab hai", "next_holiday"],
    ["who is my manager", "manager"],
    ["where is my payslip", "payslip"],
    ["tankhwah slip", "payslip"],
    ["any survey for me", "surveys"],
    ["do I have anything to sign", "to_sign"],
    ["status of my ticket", "my_questions"],
    ["what is the meaning of life", null],
  ])("%s -> %s", (q, i) => expect(detectIntent(q)).toBe(i));
});

describe("Quick answers", () => {
  let f: PayrollFixture;
  let svc: AssistantService;
  let u: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let emp: { id: string };

  beforeAll(async () => {
    f = await buildPayrollFixture("ast1");
    svc = new AssistantService(f.db, f.entitlements);
    u = await f.makeUser("asta", ["employee_self_service"]);
    emp = await f.createEmployee({ userAccountId: u.uid, monthlySalary: 123456 });
    const boss = await f.createEmployee({ monthlySalary: null });
    await f.sql("UPDATE employees SET manager_id = $2 WHERE id = $1", [emp.id, boss.id]);
    await f.sql("UPDATE employees SET first_name = 'Bina', last_name = 'Boss' WHERE id = $1", [boss.id]);
    await f.sql("INSERT INTO leave_balances (company_id, employee_id, leave_type, year, entitled_days, used_days) VALUES ($1,$2,'annual',$3,14,4)", [f.companyId, emp.id, new Date().getFullYear()]);
    await f.sql("INSERT INTO holidays (company_id, name, holiday_date) VALUES ($1,'Test Day', (current_date + 5))", [f.companyId]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("answers from the asker's own records", async () => {
    expect((await svc.ask(u, "how many leaves do I have left")).answer).toContain("annual: 10 day(s) left of 14");
    expect((await svc.ask(u, "next holiday?")).answer).toContain("Test Day");
    expect((await svc.ask(u, "who is my manager")).answer).toContain("Bina Boss");
  });

  it("never quotes a pay figure and falls back to a helpful list for anything else", async () => {
    const p = await svc.ask(u, "what is my salary");
    expect(p.answer).not.toContain("123456");
    expect(p.link).toBe("/app/ess/paystubs");
    const x = await svc.ask(u, "tell me a joke");
    expect(x.intent).toBeNull();
    expect(x.link).toBe("/app/ess/helpdesk");
    await expect(svc.ask(u, "   ")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("counts what is waiting for the asker only", async () => {
    expect((await svc.ask(u, "do I have documents to sign")).answer).toContain("no documents");
    await f.sql("INSERT INTO esign_requests (company_id, employee_id, title, body, body_sha256) VALUES ($1,$2,'t','b','x')", [f.companyId, emp.id]);
    expect((await svc.ask(u, "anything to sign")).answer).toContain("1 document");
  });
});
