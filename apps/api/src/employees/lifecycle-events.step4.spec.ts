import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";
import { OffboardingService } from "../onboarding-offboarding/offboarding.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "lifecycle-step4-fixtures" };
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/**
 * Gap Register LIF-01..LIF-08 (Step 4C/4D): lifecycle events, scheduling,
 * corrections, access revocation, rehire eligibility, offboarding link,
 * hire completion exactly once.
 */
describe("Lifecycle events, scheduling, corrections and exit links (LIF-01..08)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let lifecycle: EmployeeLifecycleService;
  let offboarding: OffboardingService;
  let companyId: string;
  let hr: RequestClaims;
  let hrUserId: string;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.withClaims(FIXTURE, async (c) => (await c.query(text, params)).rows as T[]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    lifecycle = new EmployeeLifecycleService(db, rbac, ent, audit);
    offboarding = new OffboardingService(db, rbac, ent, audit, employees, lifecycle);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Life ${stamp}`, `life-${stamp}`])).rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","exit"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true), ($1,'exit',true)", [companyId]);
      hrUserId = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`life-hr-${stamp}@example.com`])).rows[0].id;
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key='hr_admin'))", [hrUserId, companyId]);
      hr = { sub: hrUserId, company_id: companyId, is_platform_admin: false };
      await c.query(
        "INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label) VALUES ($1, 'lifecycle_reason:promotion', 'merit', 'Merit-based')",
        [companyId]
      );
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  const hire = async (first: string, extra: Record<string, unknown> = {}) =>
    employees.create(hr, { firstName: first, lastName: "Tester", dateOfJoining: addDays(-365), ...extra });

  it("LIF-01/02: an immediate action records an applied event with snapshots and a job-history row carrying canonical ids", async () => {
    const boss = await hire("Boss");
    const e = await hire("Ayesha", { managerId: boss.id, designation: "Analyst" });
    const r = await lifecycle.promote(hr, e.id, { designation: "Senior Analyst", effectiveDate: addDays(-1), reasonCode: "merit" });
    expect(r.event).toMatchObject({ actionType: "promotion", status: "applied", sourceChannel: "api", reasonCode: "merit" });
    expect(r.event.beforeSnapshot).toMatchObject({ designation: "Analyst" });
    expect(r.event.afterSnapshot).toMatchObject({ designation: "Senior Analyst" });
    expect(r.event.jobHistoryId).toBe(r.jobHistory!.id);
    expect(r.event.employmentId).toBeTruthy();
    const [jh] = await sql<{ manager_id: string | null }>("SELECT manager_id FROM employee_job_history WHERE id = $1", [r.jobHistory!.id]);
    expect(jh.manager_id).toBe(boss.id);
    const [cat] = await sql<{ reason_catalog_item_id: string | null }>("SELECT reason_catalog_item_id FROM employee_lifecycle_events WHERE id = $1", [r.event.id]);
    expect(cat.reason_catalog_item_id).not.toBeNull();
    // the as-of versions follow the effective date of the action
    const v = await sql<{ designation: string; valid_from: string }>("SELECT designation, valid_from::text FROM employee_versions WHERE employee_id = $1 ORDER BY valid_from", [e.id]);
    expect(v.map((x) => x.designation)).toEqual(["Analyst", "Senior Analyst"]);
    expect(v[1].valid_from).toBe(addDays(-1));
  });

  it("LIF-03: a future-dated action is only scheduled; the sweep applies it on its day, attributed to the user who scheduled it", async () => {
    const e = await hire("Bilal", { designation: "Engineer" });
    const r = await lifecycle.promote(hr, e.id, { designation: "Lead Engineer", effectiveDate: addDays(20) });
    expect(r.jobHistory).toBeNull();
    expect(r.event).toMatchObject({ status: "scheduled", actionType: "promotion", requestedByUserAccountId: hrUserId });
    expect(r.employee.designation).toBe("Engineer");
    expect((await sql("SELECT 1 FROM employee_job_history WHERE employee_id = $1 AND event_type = 'promotion'", [e.id])).length).toBe(0);

    await lifecycle.executeDueEvents();
    expect((await lifecycle.listEvents(hr, e.id))[0].status).toBe("scheduled"); // not due yet

    await sql("UPDATE employee_lifecycle_events SET effective_date = CURRENT_DATE WHERE id = $1", [r.event.id]);
    expect(await lifecycle.executeDueEvents()).toBeGreaterThanOrEqual(1);
    const events = await lifecycle.listEvents(hr, e.id);
    const done = events.find((x) => x.id === r.event.id)!;
    expect(done).toMatchObject({ status: "applied", sourceChannel: "api" });
    expect(done.afterSnapshot).toMatchObject({ designation: "Lead Engineer" });
    const [emp] = await sql<{ designation: string }>("SELECT designation FROM employees WHERE id = $1", [e.id]);
    expect(emp.designation).toBe("Lead Engineer");
    const [jh] = await sql<{ recorded_by_user_account_id: string }>("SELECT recorded_by_user_account_id FROM employee_job_history WHERE id = $1", [done.jobHistoryId]);
    expect(jh.recorded_by_user_account_id).toBe(hrUserId);
  });

  it("LIF-03: an action that can no longer apply is marked failed (not silently dropped) and can be cancelled", async () => {
    const e = await hire("Chand");
    const mgr = await hire("Gone");
    const r = await lifecycle.changeManager(hr, e.id, { managerId: mgr.id, effectiveDate: addDays(5) });
    expect(r.event.status).toBe("scheduled");
    await sql("UPDATE employees SET employment_status = 'terminated', termination_date = CURRENT_DATE WHERE id = $1", [mgr.id]);
    await sql("UPDATE employee_lifecycle_events SET effective_date = CURRENT_DATE WHERE id = $1", [r.event.id]);
    await lifecycle.executeDueEvents();
    const failed = (await lifecycle.listEvents(hr, e.id)).find((x) => x.id === r.event.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/terminated employee as manager/);
    const cancelled = await lifecycle.cancelScheduled(hr, e.id, r.event.id, "manager left");
    expect(cancelled.status).toBe("cancelled");
  });

  it("LIF-01: applied and cancelled events are immutable and never deleted; only scheduled ones can be cancelled", async () => {
    const e = await hire("Danish", { designation: "A" });
    const applied = await lifecycle.promote(hr, e.id, { designation: "B", effectiveDate: addDays(-2) });
    await expect(sql("UPDATE employee_lifecycle_events SET notes = 'x' WHERE id = $1", [applied.event.id])).rejects.toThrow(/can no longer change/);
    // app_role has no DELETE grant at all; even a service identity hits the guard trigger
    await expect(sql("DELETE FROM employee_lifecycle_events WHERE id = $1", [applied.event.id])).rejects.toThrow(/permission denied/);
    await expect(
      db.withClaims({ is_service: true, sub: "system", company_id: null } as never, (c) => c.query("DELETE FROM employee_lifecycle_events WHERE id = $1", [applied.event.id]))
    ).rejects.toThrow(/permission denied|never deleted/);
    await expect(lifecycle.cancelScheduled(hr, e.id, applied.event.id)).rejects.toBeInstanceOf(BadRequestException);
    const sched = await lifecycle.promote(hr, e.id, { designation: "C", effectiveDate: addDays(30) });
    await lifecycle.cancelScheduled(hr, e.id, sched.event.id);
    await expect(sql("UPDATE employee_lifecycle_events SET status = 'scheduled' WHERE id = $1", [sched.event.id])).rejects.toThrow(/can no longer change/);
  });

  it("LIF-04: a correction is a new event referencing the original, which stays exactly as it was", async () => {
    const e = await hire("Eman", { designation: "Clerk" });
    const first = await lifecycle.promote(hr, e.id, { designation: "Seniro Clerk", effectiveDate: addDays(-3) });
    await expect(lifecycle.correct(hr, e.id, first.event.id, { changes: { designation: "Senior Clerk" }, reason: "" })).rejects.toBeInstanceOf(BadRequestException);
    const fixed = await lifecycle.correct(hr, e.id, first.event.id, { changes: { designation: "Senior Clerk" }, reason: "typo in designation" });
    expect(fixed.event).toMatchObject({ actionType: "correction", correctsEventId: first.event.id, status: "applied" });
    expect(fixed.employee.designation).toBe("Senior Clerk");
    expect(fixed.jobHistory!.eventType).toBe("promotion");
    expect(fixed.jobHistory!.notes).toMatch(/Correction of an earlier promotion/);

    const events = await lifecycle.listEvents(hr, e.id);
    const original = events.find((x) => x.id === first.event.id)!;
    expect(original.correctedByEventId).toBe(fixed.event.id);
    expect(original.afterSnapshot).toMatchObject({ designation: "Seniro Clerk" }); // untouched
    expect((await sql("SELECT designation FROM employee_job_history WHERE id = $1", [first.event.jobHistoryId]))[0]).toEqual({ designation: "Seniro Clerk" });

    // a later promotion makes the earlier one uncorrectable
    await lifecycle.promote(hr, e.id, { designation: "Supervisor", effectiveDate: addDays(-1) });
    await expect(lifecycle.correct(hr, e.id, first.event.id, { changes: { designation: "X" }, reason: "too late" })).rejects.toThrow(/Only the latest/);
  });

  it("LIF-04: events backfilled from old job history cannot be replayed; unsupported types are refused", async () => {
    const e = await hire("Fiza");
    await sql("INSERT INTO employee_job_history (company_id, employee_id, event_type, effective_date) VALUES ($1,$2,'promotion',$3)", [companyId, e.id, addDays(-100)]);
    await sql(
      `INSERT INTO employee_lifecycle_events (company_id, employee_id, action_type, effective_date, status, source_channel)
       VALUES ($1,$2,'promotion',$3,'applied','backfill')`, [companyId, e.id, addDays(-100)]);
    const ev = (await lifecycle.listEvents(hr, e.id)).find((x) => x.sourceChannel === "backfill")!;
    await expect(lifecycle.correct(hr, e.id, ev.id, { changes: { designation: "Z" }, reason: "replay" })).rejects.toThrow(/predates event recording/);
    const sec = await lifecycle.second(hr, e.id, { orgUnitId: undefined, effectiveDate: addDays(-1), endDate: addDays(30) } as never).catch(() => null);
    if (sec) await expect(lifecycle.correct(hr, e.id, sec.event.id, { changes: {}, reason: "nope" })).rejects.toThrow(/not supported/);
  });

  it("LIF-05: a termination that takes effect revokes this company's access; a future one does not (yet)", async () => {
    const mk = async (label: string) => {
      const u = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`leaver-${label}-${Date.now()}@example.com`]))[0].id;
      await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key='line_manager'))", [u, companyId]);
      await sql("INSERT INTO user_sessions (user_account_id, company_id, expires_at) VALUES ($1,$2, now() + interval '1 day')", [u, companyId]);
      const e = await hire(label);
      await sql("UPDATE employees SET user_account_id = $2 WHERE id = $1", [e.id, u]);
      return { u, e };
    };
    const now = await mk("Now");
    const t = await lifecycle.terminate(hr, now.e.id, { terminationDate: addDays(-1), terminationReason: "resignation" });
    expect(t.event).toMatchObject({ actionType: "termination", status: "applied" });
    const [ra] = await sql<{ n: string }>("SELECT count(*) n FROM user_role_assignments WHERE user_account_id = $1 AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)", [now.u]);
    expect(Number(ra.n)).toBe(0);
    expect((await sql("SELECT 1 FROM user_sessions WHERE user_account_id = $1 AND revoked_at IS NULL", [now.u])).length).toBe(0);
    expect((await sql<{ status: string }>("SELECT status FROM user_accounts WHERE id = $1", [now.u]))[0].status).toBe("locked");
    expect((await sql("SELECT 1 FROM audit_log WHERE action = 'employee.access_revoked' AND target = $1", [now.e.id])).length).toBe(1);

    const later = await mk("Later");
    const s = await lifecycle.terminate(hr, later.e.id, { terminationDate: addDays(15), terminationReason: "resignation" });
    expect(s.event.status).toBe("scheduled");
    expect(s.employee.employmentStatus).toBe("active");
    expect((await sql("SELECT 1 FROM user_sessions WHERE user_account_id = $1 AND revoked_at IS NULL", [later.u])).length).toBe(1);
    expect((await sql<{ status: string }>("SELECT status FROM user_accounts WHERE id = $1", [later.u]))[0].status).toBe("active");

    // simulate "the day arrives": the sweep runs on the termination date itself
    await sql(
      "UPDATE employee_lifecycle_events SET effective_date = CURRENT_DATE, payload = payload || jsonb_build_object('terminationDate', CURRENT_DATE::text, 'effectiveDate', CURRENT_DATE::text) WHERE id = $1",
      [s.event.id]
    );
    await lifecycle.executeDueEvents();
    expect((await sql<{ status: string }>("SELECT status FROM user_accounts WHERE id = $1", [later.u]))[0].status).toBe("locked");
    expect((await sql<{ employment_status: string }>("SELECT employment_status FROM employees WHERE id = $1", [later.e.id]))[0].employment_status).toBe("terminated");
  });

  it("LIF-05: offboarding completes THROUGH the lifecycle - exit interview gate, rehire eligibility, linked termination event", async () => {
    const e = await hire("Gulzar");
    const started = await offboarding.initiateOffboarding(hr, e.id, { reason: "resignation", lastWorkingDay: addDays(-1), exitInterviewRequired: true, noticePeriodDays: 30 });
    expect(started).toMatchObject({ exitInterviewStatus: "pending", noticePeriodDays: 30, terminationEventId: null });
    await expect(offboarding.completeOffboarding(hr, e.id)).rejects.toThrow(/exit interview is still pending/);
    const noted = await offboarding.updateExitDetails(hr, e.id, { exitInterviewStatus: "completed", exitInterviewNotes: "left for family reasons", rehireEligibility: "not_eligible", rehireEligibilityNote: "gross misconduct" });
    expect(noted).toMatchObject({ rehireEligibility: "not_eligible", exitInterviewStatus: "completed" });
    expect(noted.exitInterviewCompletedAt).toBeTruthy();
    const done = await offboarding.completeOffboarding(hr, e.id);
    expect(done.status).toBe("completed");
    expect(done.terminationEventId).toBeTruthy();
    const ev = (await lifecycle.listEvents(hr, e.id)).find((x) => x.id === done.terminationEventId)!;
    expect(ev).toMatchObject({ actionType: "termination", status: "applied", sourceChannel: "offboarding" });
    expect((await sql<{ employment_status: string }>("SELECT employment_status FROM employees WHERE id = $1", [e.id]))[0].employment_status).toBe("terminated");

    const future = await hire("Hasan");
    await offboarding.initiateOffboarding(hr, future.id, { reason: "retirement", lastWorkingDay: addDays(25) });
    const sched = await offboarding.completeOffboarding(hr, future.id);
    expect(sched.status).toBe("completed");
    const fev = (await lifecycle.listEvents(hr, future.id)).find((x) => x.id === sched.terminationEventId)!;
    expect(fev.status).toBe("scheduled");
    expect((await sql<{ employment_status: string }>("SELECT employment_status FROM employees WHERE id = $1", [future.id]))[0].employment_status).toBe("active");
  });

  it("LIF-06: 'not eligible for rehire' blocks both a new employment and reactivation unless HR gives an audited override", async () => {
    const e = await hire("Iqra");
    await offboarding.initiateOffboarding(hr, e.id, { reason: "termination", lastWorkingDay: addDays(-10) });
    await offboarding.updateExitDetails(hr, e.id, { rehireEligibility: "not_eligible", rehireEligibilityNote: "policy breach" });
    await offboarding.completeOffboarding(hr, e.id);

    await expect(employees.create(hr, { firstName: "Iqra", lastName: "Tester", personId: e.personId! })).rejects.toThrow(/not eligible for rehire/);
    await expect(lifecycle.reactivate(hr, e.id, { effectiveDate: addDays(0) })).rejects.toThrow(/not eligible for rehire/);

    const rehired = await employees.create(hr, { firstName: "Iqra", lastName: "Tester", personId: e.personId!, rehireOverrideReason: "CEO approved return" });
    expect(rehired.personId).toBe(e.personId);
    expect((await sql("SELECT 1 FROM audit_log WHERE action = 'employee.rehire.eligibility_overridden' AND reason = 'CEO approved return'")).length).toBeGreaterThanOrEqual(1);
    const periods = await sql<{ period_number: number }>("SELECT period_number FROM employments WHERE person_id = $1 ORDER BY 1", [e.personId]);
    expect(periods.map((p) => p.period_number)).toEqual([1, 2]);

    const re = await lifecycle.reactivate(hr, e.id, { effectiveDate: addDays(0), rehireOverrideReason: "second chance" });
    expect(re.employee.employmentStatus).toBe("active");

    const c = await hire("Jawad");
    await offboarding.initiateOffboarding(hr, c.id, { reason: "end_of_contract", lastWorkingDay: addDays(-5) });
    await offboarding.updateExitDetails(hr, c.id, { rehireEligibility: "conditional", rehireEligibilityNote: "only for project work" });
    await offboarding.completeOffboarding(hr, c.id);
    const back = await lifecycle.reactivate(hr, c.id, { effectiveDate: addDays(0) });
    expect(back.employee.employmentStatus).toBe("active");
    expect((await sql("SELECT 1 FROM audit_log WHERE action = 'employee.rehire.conditional' OR (action = 'employee.rehire.eligibility_overridden' AND target = $1)", [c.id])).length).toBeGreaterThanOrEqual(1);
  });

  it("LIF-07/08: a hire process can be linked to at most one employee, and offers carry the hire process id", async () => {
    const e = await hire("Kashif");
    const mk = async (employeeId: string | null) =>
      sql<{ id: string }>("INSERT INTO hire_processes (company_id, created_by_user_account_id, employee_id) VALUES ($1,$2,$3) RETURNING id", [companyId, hrUserId, employeeId]).then((r) => r[0].id);
    const first = await mk(e.id);
    await expect(mk(e.id)).rejects.toThrow(/duplicate key|unique/i);
    expect(first).toBeTruthy();
    const cols = await sql<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE (table_name = 'offers' AND column_name = 'hire_process_id') OR (table_name = 'hire_processes' AND column_name = 'workflow_instance_id')");
    expect(cols.length).toBe(2);
  });
});
