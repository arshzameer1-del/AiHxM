import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { RecruitmentService } from "./recruitment.service";
import { OnboardingService } from "../onboarding-offboarding/onboarding.service";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { RecruitmentScheduler } from "./recruitment.scheduler";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "recruitment-11a-fixtures" };
const PDF = { originalname: "cv.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 test resume"), size: 20 };

/**
 * Step 11A (TAL-01..TAL-04): candidate depth, interviews, feedback, pre-employment checks, offers and letters,
 * events, retention - real Postgres, no mocks.
 */
describe("Recruitment Step 11A", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let workflow: WorkflowService;
  let employees: EmployeesService;
  let recruitment: RecruitmentService;
  let onboarding: OnboardingService;
  let pipeline: RecruitmentPipelineService;
  const storage = new LocalFileStorageService();
  const companyIds: string[] = [];

  type Tenant = { companyId: string; hr: RequestClaims; approver: RequestClaims; outsider: RequestClaims; hrRoleId: string; requisitionId: string };
  let t: Tenant;
  let other: Tenant;

  const sql = <R = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<R[]> =>
    db.withClaims(FIXTURE, async (c) => (await c.query(query, params)).rows as R[]);

  async function makeUser(email: string): Promise<string> {
    return (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]))[0].id;
  }
  async function assignRole(userId: string, companyId: string, roleKey: string): Promise<string> {
    const role = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = $1", [roleKey]))[0];
    await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [userId, companyId, role.id]);
    return role.id;
  }

  async function makeTenant(label: string): Promise<Tenant> {
    const stamp = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const companyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`Rec11A ${stamp}`, `rec11a-${stamp}`]))[0].id;
    companyIds.push(companyId);
    await sql(
      `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
       VALUES ($1, '["employee", "recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
      [companyId]
    );
    await sql("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'recruitment', true)", [companyId]);
    const hrUser = await makeUser(`hr-${stamp}@example.com`);
    const hrRoleId = await assignRole(hrUser, companyId, "hr_admin");
    await assignRole(hrUser, companyId, "rbac_demo_full_access");
    const approverUser = await makeUser(`approver-${stamp}@example.com`);
    await assignRole(approverUser, companyId, "hr_admin");
    const outsiderUser = await makeUser(`outsider-${stamp}@example.com`);
    const hr: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: hrUser };
    const approver: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: approverUser };
    const outsider: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUser };

    await workflow.createTemplate(hr, {
      key: "job_requisition",
      name: "Requisition Approval",
      objectKey: "job_requisition",
      steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: hrRoleId }] }],
    });
    const req = await recruitment.createRequisition(hr, { title: "QA Engineer", department: "Engineering", headcount: 20, salaryBand: "E2" });
    await recruitment.submitRequisition(hr, req.id);
    await recruitment.decideRequisition(approver, req.id, { decision: "approved" });
    return { companyId, hr, approver, outsider, hrRoleId, requisitionId: req.id };
  }

  async function makeEmployee(tt: Tenant, first: string, linkedUserId?: string): Promise<string> {
    const e = await employees.create(tt.hr, { firstName: first, lastName: "Interviewer", dateOfJoining: "2024-01-01" });
    if (linkedUserId) await sql("UPDATE employees SET user_account_id = $2 WHERE id = $1", [e.id, linkedUserId]);
    return e.id;
  }

  let cnicSeq = 1000000;
  const nextCnic = () => `35202-${String(cnicSeq++).padStart(7, "0")}-1`;
  let phoneSeq = 3001000000;
  const nextPhone = () => `0${phoneSeq++}`;

  async function candidateOn(tt: Tenant, first: string, extra: Record<string, unknown> = {}) {
    return recruitment.createCandidate(tt.hr, { firstName: first, lastName: "Applicant", email: `${first.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`, ...extra });
  }

  async function applicationOn(tt: Tenant, first: string) {
    const c = await candidateOn(tt, first);
    const a = await recruitment.createApplication(tt.hr, { requisitionId: tt.requisitionId, candidateId: c.id });
    return { candidate: c, application: a };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    workflow = new WorkflowService(db, rbac, audit);
    employees = new EmployeesService(db, rbac, entitlements, audit, storage);
    const compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    onboarding = new OnboardingService(db, rbac, entitlements, audit);
    recruitment = new RecruitmentService(db, rbac, entitlements, audit, workflow, employees, undefined, undefined, compensation, onboarding);
    pipeline = new RecruitmentPipelineService(db, rbac, entitlements, audit, storage);
    t = await makeTenant("a");
    other = await makeTenant("b");
  }, 60000);

  afterAll(async () => {
    for (const id of companyIds) await sql("DELETE FROM companies WHERE id = $1", [id]);
    await pool.end();
  });

  // ------------------------------------------------------------------ TAL-01 candidates
  describe("candidates", () => {
    it("stores the national id encrypted, shows it masked, and indexes it", async () => {
      const cnic = nextCnic();
      const c = await candidateOn(t, "Ayesha", { nationalId: cnic, source: "referral", currentEmployer: "Acme", expectedSalary: 180000, noticePeriodDays: 30 });
      expect(c.nationalIdMasked).toMatch(/^\*+.*1$/);
      expect(c.nationalIdMasked).not.toContain(cnic);
      expect(c.source).toBe("referral");
      expect(c.expectedSalary).toBe(180000);
      const raw = (await sql<{ national_id: string; national_id_bidx: string }>("SELECT national_id, national_id_bidx FROM candidates WHERE id = $1", [c.id]))[0];
      expect(raw.national_id).not.toBe(cnic);
      expect(raw.national_id_bidx).toBeTruthy();
    });

    it("rejects a malformed national id", async () => {
      await expect(candidateOn(t, "Bad", { nationalId: "123" })).rejects.toThrow(BadRequestException);
    });

    it("detects duplicates by national id, e-mail and phone - and lets HR override", async () => {
      const cnic = nextCnic();
      const phone = nextPhone();
      const email = `dup-${Date.now()}@example.com`;
      const first = await recruitment.createCandidate(t.hr, { firstName: "Dup", lastName: "One", email, phone, nationalId: cnic });
      await expect(recruitment.createCandidate(t.hr, { firstName: "Dup", lastName: "Two", nationalId: cnic })).rejects.toThrow(ConflictException);
      await expect(recruitment.createCandidate(t.hr, { firstName: "Dup", lastName: "Three", email: email.toUpperCase() })).rejects.toThrow(ConflictException);
      // +92 formatting of the same mobile number still matches
      await expect(recruitment.createCandidate(t.hr, { firstName: "Dup", lastName: "Four", phone: `+92${phone.slice(1)}` })).rejects.toThrow(ConflictException);
      const matches = await recruitment.checkCandidateDuplicates(t.hr, { nationalId: cnic, email, phone });
      expect(matches).toHaveLength(1);
      expect(matches[0].candidateId).toBe(first.id);
      expect(matches[0].matchedOn.sort()).toEqual(["email", "national_id", "phone"]);
      const forced = await recruitment.createCandidate(t.hr, { firstName: "Dup", lastName: "Forced", nationalId: cnic, allowDuplicate: true });
      expect(forced.id).not.toBe(first.id);
    });

    it("editing a candidate re-checks duplicates and keeps the id encrypted", async () => {
      const a = await candidateOn(t, "EditA", { phone: nextPhone() });
      const b = await candidateOn(t, "EditB", { phone: nextPhone() });
      await expect(recruitment.updateCandidate(t.hr, b.id, { phone: a.phone! })).rejects.toThrow(ConflictException);
      const cnic = nextCnic();
      const updated = await recruitment.updateCandidate(t.hr, b.id, { nationalId: cnic, currentDesignation: "SQA Lead" });
      expect(updated.currentDesignation).toBe("SQA Lead");
      expect(updated.nationalIdMasked).toBeTruthy();
      const matches = await recruitment.checkCandidateDuplicates(t.hr, { nationalId: cnic });
      expect(matches.map((m) => m.candidateId)).toContain(b.id);
    });

    it("applies the tenant's consent and retention settings", async () => {
      await pipeline.updateSettings(t.hr, { consentRequired: true, candidateRetentionMonths: 6 });
      await expect(candidateOn(t, "NoConsent")).rejects.toThrow(/consent/i);
      const ok = await candidateOn(t, "Consented", { consentGiven: true, consentPurpose: "Recruitment for open roles" });
      expect(ok.consentGivenAt).toBeTruthy();
      expect(ok.retentionUntil).toBeTruthy();
      const months = (await sql<{ m: number }>("SELECT ((retention_until - CURRENT_DATE) / 30)::int AS m FROM candidates WHERE id = $1", [ok.id]))[0].m;
      expect(months).toBeGreaterThanOrEqual(5);
      await pipeline.updateSettings(t.hr, { consentRequired: false, candidateRetentionMonths: null });
      const s = await pipeline.getSettings(t.hr);
      expect(s).toMatchObject({ consentRequired: false, candidateRetentionMonths: null });
    });

    it("validates settings ranges", async () => {
      await expect(pipeline.updateSettings(t.hr, { offerValidityDays: 0 })).rejects.toThrow(BadRequestException);
      await expect(pipeline.updateSettings(t.hr, { offerLetterTemplateKey: "missing_template" })).rejects.toThrow(BadRequestException);
    });

    it("keeps candidate documents: upload, list, download, delete, type and quota rules", async () => {
      const c = await candidateOn(t, "Docs");
      const doc = await pipeline.addDocument(t.hr, c.id, "resume", PDF);
      expect(doc.fileName).toBe("cv.pdf");
      expect((await pipeline.listDocuments(t.hr, c.id)).map((d) => d.id)).toContain(doc.id);
      expect((await recruitment.getCandidate(t.hr, c.id)).documentCount).toBe(1);
      const dl = await pipeline.downloadDocument(t.hr, c.id, doc.id);
      expect(dl.buffer.toString()).toContain("%PDF");
      await expect(pipeline.addDocument(t.hr, c.id, "resume", { ...PDF, mimetype: "application/x-msdownload" })).rejects.toThrow(/allowed file type/);
      await expect(pipeline.addDocument(t.hr, c.id, "nonsense", PDF)).rejects.toThrow(BadRequestException);
      await sql("UPDATE companies SET storage_quota_mb = 0 WHERE id = $1", [t.companyId]);
      await expect(pipeline.addDocument(t.hr, c.id, "resume", PDF)).rejects.toThrow(/quota/);
      await sql("UPDATE companies SET storage_quota_mb = 5120 WHERE id = $1", [t.companyId]);
      await pipeline.deleteDocument(t.hr, c.id, doc.id);
      expect(await pipeline.listDocuments(t.hr, c.id)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ TAL-02 pipeline
  describe("application pipeline", () => {
    it("records every stage change and requires a reason to reject", async () => {
      const { application } = await applicationOn(t, "Stage");
      await recruitment.moveApplicationStage(t.hr, application.id, "screening");
      await expect(recruitment.moveApplicationStage(t.hr, application.id, "rejected")).rejects.toThrow(/reason/i);
      await expect(recruitment.moveApplicationStage(t.hr, application.id, "rejected", "   ")).rejects.toThrow(/reason/i);
      const rejected = await recruitment.moveApplicationStage(t.hr, application.id, "rejected", "Skills mismatch");
      expect(rejected.rejectionReason).toBe("Skills mismatch");
      expect(rejected.rejectedAt).toBeTruthy();
      const tl = await pipeline.getApplicationTimeline(t.hr, application.id);
      expect(tl.stageHistory.map((h) => h.toStage)).toEqual(["applied", "screening", "rejected"]);
      expect(tl.stageHistory[2].reason).toBe("Skills mismatch");
    });

    it("stage history is append-only for the application role", async () => {
      const { application } = await applicationOn(t, "Immutable");
      await expect(
        db.withClaims(t.hr, (c) => c.query("UPDATE application_stage_history SET to_stage = 'hired' WHERE application_id = $1", [application.id]))
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(
        db.withClaims(t.hr, (c) => c.query("DELETE FROM application_stage_history WHERE application_id = $1", [application.id]))
      ).rejects.toThrow(/permission denied/);
    });

    it("builds a candidate timeline across applications, interviews, offers and documents", async () => {
      const { candidate, application } = await applicationOn(t, "Timeline");
      await pipeline.addDocument(t.hr, candidate.id, "resume", PDF);
      await recruitment.moveApplicationStage(t.hr, application.id, "screening");
      const tl = await pipeline.getCandidateTimeline(t.hr, candidate.id);
      const kinds = tl.map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(["created", "application", "stage", "document"]));
      expect([...tl].map((e) => e.at)).toEqual([...tl].map((e) => e.at).sort());
    });
  });

  // ------------------------------------------------------------------ interviews
  describe("interviews and feedback", () => {
    let panel1: string;
    let panel2: string;
    let interviewerUser: string;
    let interviewerClaims: RequestClaims;
    const slot = (h: number, m = 0) => new Date(Date.UTC(2027, 2, 1, h, m)).toISOString();

    beforeAll(async () => {
      interviewerUser = await makeUser(`interviewer-${Date.now()}@example.com`);
      interviewerClaims = { is_platform_admin: false, company_id: t.companyId, sub: interviewerUser };
      panel1 = await makeEmployee(t, "PanelOne", interviewerUser);
      panel2 = await makeEmployee(t, "PanelTwo");
    });

    it("schedules a round, moves the application to interview and numbers the rounds", async () => {
      const { application } = await applicationOn(t, "Iv1");
      const iv = await pipeline.scheduleInterview(t.hr, {
        applicationId: application.id, interviewType: "video", scheduledStart: slot(9), scheduledEnd: slot(10),
        meetingLink: "https://meet.example.com/abc", interviewerEmployeeIds: [panel1, panel2],
      });
      expect(iv.roundNo).toBe(1);
      expect(iv.interviewerEmployeeIds.sort()).toEqual([panel1, panel2].sort());
      const after = (await recruitment.listApplications(t.hr, t.requisitionId)).find((a) => a.id === application.id)!;
      expect(after.stage).toBe("interview");
      const second = await pipeline.scheduleInterview(t.hr, {
        applicationId: application.id, scheduledStart: slot(14), scheduledEnd: slot(15), interviewerEmployeeIds: [panel2],
      });
      expect(second.roundNo).toBe(2);
    });

    it("refuses double-booked interviewers and a double-booked candidate", async () => {
      const { application } = await applicationOn(t, "Iv2");
      const { application: app2 } = await applicationOn(t, "Iv3");
      await pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(11), scheduledEnd: slot(12), interviewerEmployeeIds: [panel1] });
      await expect(
        pipeline.scheduleInterview(t.hr, { applicationId: app2.id, scheduledStart: slot(11, 30), scheduledEnd: slot(12, 30), interviewerEmployeeIds: [panel1] })
      ).rejects.toThrow(/conflict/i);
      await expect(
        pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(11, 30), scheduledEnd: slot(12, 30), interviewerEmployeeIds: [panel2] })
      ).rejects.toThrow(/candidate already has an interview/);
      // back-to-back is fine
      await pipeline.scheduleInterview(t.hr, { applicationId: app2.id, scheduledStart: slot(12), scheduledEnd: slot(13), interviewerEmployeeIds: [panel1] });
    });

    it("validates the window and the interviewers", async () => {
      const { application } = await applicationOn(t, "Iv4");
      await expect(
        pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(10), scheduledEnd: slot(9), interviewerEmployeeIds: [panel1] })
      ).rejects.toThrow(BadRequestException);
      await expect(
        pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(16), scheduledEnd: slot(17), interviewerEmployeeIds: [] })
      ).rejects.toThrow(/interviewer/i);
      await expect(
        pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(16), scheduledEnd: slot(17), interviewerEmployeeIds: ["11111111-1111-4111-8111-111111111111"] })
      ).rejects.toThrow(/current \(non-terminated\) employee/);
    });

    it("lets an assigned interviewer see and score only their own interviews; others cannot", async () => {
      const { application } = await applicationOn(t, "Iv5");
      const iv = await pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(18), scheduledEnd: slot(19), interviewerEmployeeIds: [panel1, panel2] });
      // the interviewer holds no recruitment permission at all
      await expect(pipeline.listInterviews(interviewerClaims)).rejects.toThrow(ForbiddenException);
      expect((await pipeline.listMyInterviews(interviewerClaims)).map((i) => i.id)).toContain(iv.id);
      await expect(pipeline.submitFeedback(interviewerClaims, iv.id, { overallRating: 6, recommendation: "yes" })).rejects.toThrow(BadRequestException);
      const fb = await pipeline.submitFeedback(interviewerClaims, iv.id, {
        overallRating: 4, recommendation: "yes", strengths: "Clear thinker",
        scorecard: [{ criterion: "Testing depth", rating: 5 }, { criterion: "Communication", rating: 3, comment: "ok" }],
      });
      expect(fb.employeeId).toBe(panel1);
      expect(fb.scorecard).toHaveLength(2);
      await expect(pipeline.submitFeedback(interviewerClaims, iv.id, { overallRating: 3, recommendation: "no" })).rejects.toThrow(ConflictException);
      // an interviewer cannot file on behalf of the other panelist; HR can
      await expect(pipeline.submitFeedback(interviewerClaims, iv.id, { overallRating: 3, recommendation: "no", employeeId: panel2 })).rejects.toThrow(ForbiddenException);
      // an outsider (not on the panel) is refused
      await expect(pipeline.submitFeedback(t.outsider, iv.id, { overallRating: 3, recommendation: "no" })).rejects.toThrow(ForbiddenException);
      // my-interviews shows only my own feedback
      const mine = (await pipeline.listMyInterviews(interviewerClaims)).find((i) => i.id === iv.id)!;
      expect(mine.feedback.map((f) => f.employeeId)).toEqual([panel1]);
      expect(mine.status).toBe("scheduled");
      await pipeline.submitFeedback(t.hr, iv.id, { overallRating: 2, recommendation: "no", employeeId: panel2 });
      const all = (await pipeline.listInterviews(t.hr, application.id)).find((i) => i.id === iv.id)!;
      expect(all.status).toBe("completed");
      expect(all.feedback).toHaveLength(2);
    });

    it("cancelling needs a reason; reschedules re-check conflicts; completed interviews are frozen", async () => {
      const { application } = await applicationOn(t, "Iv6");
      const iv = await pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(20), scheduledEnd: slot(21), interviewerEmployeeIds: [panel2] });
      await expect(pipeline.updateInterview(t.hr, iv.id, { status: "cancelled" })).rejects.toThrow(/reason/i);
      const moved = await pipeline.updateInterview(t.hr, iv.id, { scheduledStart: slot(21, 30), scheduledEnd: slot(22) });
      expect(moved.scheduledStart).toBe(slot(21, 30));
      const cancelled = await pipeline.updateInterview(t.hr, iv.id, { status: "cancelled", cancelReason: "Candidate unavailable" });
      expect(cancelled.status).toBe("cancelled");
      await expect(pipeline.updateInterview(t.hr, iv.id, { scheduledStart: slot(23) })).rejects.toThrow(BadRequestException);
      await expect(pipeline.submitFeedback(t.hr, iv.id, { overallRating: 3, recommendation: "yes", employeeId: panel2 })).rejects.toThrow(/cancelled/);
    });

    it("rejecting an application cancels its scheduled interviews", async () => {
      const { application } = await applicationOn(t, "Iv7");
      const iv = await pipeline.scheduleInterview(t.hr, { applicationId: application.id, scheduledStart: slot(7), scheduledEnd: slot(8), interviewerEmployeeIds: [panel2] });
      await recruitment.moveApplicationStage(t.hr, application.id, "rejected", "Withdrew");
      const after = (await pipeline.listInterviews(t.hr, application.id)).find((i) => i.id === iv.id)!;
      expect(after.status).toBe("cancelled");
      expect(after.cancelReason).toMatch(/rejected/i);
    });
  });

  // ------------------------------------------------------------------ pre-employment checks and offers
  describe("pre-employment checks and offers", () => {
    it("blocks acceptance until required checks are passed or waived", async () => {
      const { application } = await applicationOn(t, "Check");
      const ref = await pipeline.createCheck(t.hr, { applicationId: application.id, checkType: "reference", isRequired: true });
      const medical = await pipeline.createCheck(t.hr, { applicationId: application.id, checkType: "medical", isRequired: false });
      const offer = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 200000, startDate: "2027-04-01" });
      await expect(recruitment.decideOffer(t.hr, offer.id, "accepted")).rejects.toThrow(/pre-employment checks/);
      await expect(pipeline.updateCheck(t.hr, ref.id, { status: "failed" })).rejects.toThrow(/note/i);
      await pipeline.updateCheck(t.hr, ref.id, { status: "failed", resultNote: "Referee could not confirm" });
      await expect(recruitment.decideOffer(t.hr, offer.id, "accepted")).rejects.toThrow(/pre-employment checks/);
      await pipeline.updateCheck(t.hr, ref.id, { status: "waived", resultNote: "CEO sign-off" });
      expect((await pipeline.listChecks(t.hr, application.id)).map((c) => c.status).sort()).toEqual(["requested", "waived"]);
      expect(medical.isRequired).toBe(false);
      const decided = await recruitment.decideOffer(t.hr, offer.id, "accepted");
      expect(decided.offer.status).toBe("accepted");
      expect(decided.employee).not.toBeNull();
    });

    it("tells HR what is still missing after a hire and starts onboarding only when the company has a checklist template (LIVE-15/16)", async () => {
      const first = await applicationOn(t, "Followup");
      const offer1 = await recruitment.extendOffer(t.hr, { applicationId: first.application.id, salary: 150000, startDate: "2027-06-01" });
      const noTemplate = await recruitment.decideOffer(t.hr, offer1.id, "accepted");
      expect(noTemplate.onboardingStarted).toBe(false);
      expect(noTemplate.followUps).toEqual(expect.arrayContaining([expect.stringMatching(/login/i), expect.stringMatching(/payment account/i), expect.stringMatching(/Start onboarding/i)]));
      expect(await onboarding.getForEmployee(t.hr, noTemplate.employee!.id)).toBeNull();

      await onboarding.createItemTemplate(t.hr, { title: "Read handbook", category: "hr", responsibleRole: "all" });
      const second = await applicationOn(t, "Followup2");
      const offer2 = await recruitment.extendOffer(t.hr, { applicationId: second.application.id, salary: 150000, startDate: "2027-06-01" });
      const withTemplate = await recruitment.decideOffer(t.hr, offer2.id, "accepted");
      expect(withTemplate.onboardingStarted).toBe(true);
      expect(withTemplate.followUps).not.toEqual(expect.arrayContaining([expect.stringMatching(/Start onboarding/i)]));
      const view = await onboarding.getForEmployee(t.hr, withTemplate.employee!.id);
      expect(view?.status).toBe("in_progress");
      expect(view?.items).toHaveLength(1);
      // The other tenant's hires are untouched: it has no template of its own.
      expect(await onboarding.getForEmployee(other.hr, withTemplate.employee!.id).catch(() => null)).toBeNull();
    });

    it("applies the offer's components to the new employee and links the candidate to the person", async () => {
      const basic = (await sql<{ id: string }>(
        "INSERT INTO compensation_components (company_id, key, name) VALUES ($1, 'basic_t11a', 'Basic') RETURNING id", [t.companyId]
      ))[0].id;
      const house = (await sql<{ id: string }>(
        "INSERT INTO compensation_components (company_id, key, name) VALUES ($1, 'house_t11a', 'House Rent') RETURNING id", [t.companyId]
      ))[0].id;
      const { candidate, application } = await applicationOn(t, "Comp");
      await expect(
        recruitment.extendOffer(t.hr, { applicationId: application.id, startDate: "2027-05-01", components: [{ componentId: basic, amount: 1 }, { componentId: basic, amount: 2 }] })
      ).rejects.toThrow(/only once/);
      await expect(recruitment.extendOffer(t.hr, { applicationId: application.id, startDate: "2027-05-01" })).rejects.toThrow(/salary or at least one/);
      await expect(
        recruitment.extendOffer(t.hr, { applicationId: application.id, startDate: "2027-05-01", components: [{ componentId: "22222222-2222-4222-8222-222222222222", amount: 5 }] })
      ).rejects.toThrow(/do not exist/);
      const offer = await recruitment.extendOffer(t.hr, {
        applicationId: application.id, startDate: "2027-05-01", components: [{ componentId: basic, amount: 120000 }, { componentId: house, amount: 48000 }],
      });
      expect(offer.salary).toBe(168000);
      expect(offer.components.map((c) => c.componentKey).sort()).toEqual(["basic_t11a", "house_t11a"]);
      const decided = await recruitment.decideOffer(t.hr, offer.id, "accepted");
      const rows = await sql<{ amount: string; effective_from: Date }>(
        "SELECT amount, effective_from FROM employee_compensation_components WHERE employee_id = $1 ORDER BY amount DESC", [decided.employee!.id]
      );
      expect(rows.map((r) => Number(r.amount))).toEqual([120000, 48000]);
      expect(new Date(rows[0].effective_from).toISOString().slice(0, 10)).toBe("2027-05-01");
      const person = (await sql<{ person_id: string | null }>("SELECT person_id FROM candidates WHERE id = $1", [candidate.id]))[0].person_id;
      expect(person).toBeTruthy();
    });

    it("sets a default expiry from the tenant setting and closes an expired offer instead of accepting it", async () => {
      await pipeline.updateSettings(t.hr, { offerValidityDays: 7 });
      const { application } = await applicationOn(t, "Expiry");
      const offer = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 90000, startDate: "2027-06-01" });
      const days = (new Date(offer.expiresAt!).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.5);
      expect(days).toBeLessThanOrEqual(7.01);
      await expect(recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 1, startDate: "2027-06-01", expiresAt: "2020-01-01T00:00:00Z" })).rejects.toThrow(/future/);
      await sql("UPDATE offers SET expires_at = now() - interval '1 hour' WHERE id = $1", [offer.id]);
      await expect(recruitment.decideOffer(t.hr, offer.id, "accepted")).rejects.toThrow(/expired/);
      const status = (await sql<{ status: string }>("SELECT status FROM offers WHERE id = $1", [offer.id]))[0].status;
      expect(status).toBe("expired");
      await pipeline.updateSettings(t.hr, { offerValidityDays: null });
    });

    it("the nightly job expires lapsed offers and anonymises candidates past retention", async () => {
      const { application } = await applicationOn(t, "Nightly");
      const offer = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 70000, startDate: "2027-07-01" });
      await sql("UPDATE offers SET expires_at = now() - interval '2 days' WHERE id = $1", [offer.id]);
      const old = await candidateOn(t, "Retained", { nationalId: nextCnic(), phone: nextPhone() });
      await pipeline.addDocument(t.hr, old.id, "resume", PDF);
      const stored = (await sql<{ storage_path: string }>("SELECT storage_path FROM candidate_documents WHERE candidate_id = $1", [old.id]))[0].storage_path;
      await sql("UPDATE candidates SET retention_until = CURRENT_DATE - 1 WHERE id = $1", [old.id]);
      const busy = await candidateOn(t, "StillActive");
      await recruitment.createApplication(t.hr, { requisitionId: t.requisitionId, candidateId: busy.id });
      await sql("UPDATE candidates SET retention_until = CURRENT_DATE - 1 WHERE id = $1", [busy.id]);

      const scheduler = new RecruitmentScheduler(db, recruitment, pipeline);
      const result = await scheduler.run([t.companyId]);
      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect(result.anonymised).toBeGreaterThanOrEqual(1);
      expect((await sql<{ status: string }>("SELECT status FROM offers WHERE id = $1", [offer.id]))[0].status).toBe("expired");
      const gone = (await sql<{ first_name: string; email: string | null; national_id: string | null; anonymised_at: Date | null }>(
        "SELECT first_name, email, national_id, anonymised_at FROM candidates WHERE id = $1", [old.id]
      ))[0];
      expect(gone).toMatchObject({ first_name: "Anonymised", email: null, national_id: null });
      expect(gone.anonymised_at).toBeTruthy();
      await expect(storage.read(stored)).rejects.toBeDefined();
      expect((await sql<{ anonymised_at: Date | null }>("SELECT anonymised_at FROM candidates WHERE id = $1", [busy.id]))[0].anonymised_at).toBeNull();
      // idempotent
      const again = await scheduler.run([t.companyId]);
      expect(again.anonymised).toBe(0);
      await expect(recruitment.updateCandidate(t.hr, old.id, { firstName: "X" })).rejects.toThrow(/anonymised/);
      await expect(recruitment.createApplication(t.hr, { requisitionId: t.requisitionId, candidateId: old.id })).rejects.toThrow(/anonymised/);
    });

    it("manual erasure needs a reason and is refused while an application is in progress", async () => {
      const { candidate, application } = await applicationOn(t, "Erase");
      await expect(pipeline.anonymiseCandidate(t.hr, candidate.id, "")).rejects.toThrow(BadRequestException);
      await expect(pipeline.anonymiseCandidate(t.hr, candidate.id, "Candidate request")).rejects.toThrow(/in progress/);
      await recruitment.moveApplicationStage(t.hr, application.id, "rejected", "Not proceeding");
      await expect(pipeline.anonymiseCandidate(t.hr, candidate.id, "Candidate request")).resolves.toEqual({ anonymised: true });
      const audited = await sql("SELECT 1 FROM audit_log WHERE action = 'candidate.anonymise' AND target = $1 AND reason = 'Candidate request'", [candidate.id]);
      expect(audited).toHaveLength(1);
    });

    it("rejecting an application rescinds its open offer", async () => {
      const { application } = await applicationOn(t, "RejOffer");
      const offer = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 65000, startDate: "2027-08-01" });
      await recruitment.moveApplicationStage(t.hr, application.id, "rejected", "Changed requirements");
      const after = (await recruitment.listOffers(t.hr, application.id)).find((o) => o.id === offer.id)!;
      expect(after.status).toBe("rescinded");
      expect(after.rescindReason).toBe("Application rejected");
    });

    it("decline and rescind keep their reasons", async () => {
      const { application } = await applicationOn(t, "Decl");
      const offer = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 65000, startDate: "2027-08-01" });
      const declined = await recruitment.decideOffer(t.hr, offer.id, "declined", "Accepted another offer");
      expect(declined.offer.status).toBe("declined");
      expect(declined.offer.declineReason).toBe("Accepted another offer");
      const second = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 70000, startDate: "2027-08-01" });
      const rescinded = await recruitment.rescindOffer(t.hr, second.id, "Budget freeze");
      expect(rescinded.status).toBe("rescinded");
      expect(rescinded.rescindReason).toBe("Budget freeze");
      await expect(recruitment.rescindOffer(t.hr, second.id)).rejects.toThrow(BadRequestException);
    });

    it("issues versioned offer letters: built-in, then a tenant template, with a content hash", async () => {
      const { application } = await applicationOn(t, "Letter");
      const offer = await recruitment.extendOffer(t.hr, { applicationId: application.id, salary: 150000, startDate: "2027-09-01" });
      const v1 = await pipeline.generateOfferLetter(t.hr, offer.id, {});
      expect(v1.versionNo).toBe(1);
      expect(v1.templateSource).toBe("built_in");
      expect(v1.content).toContain("Letter Applicant");
      expect(v1.content).toContain("QA Engineer");
      expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
      await sql("INSERT INTO document_templates (company_id, key, name, object_key, template_body) VALUES ($1, 'offer_custom', 'Custom offer', 'offer', $2)", [
        t.companyId, "CUSTOM LETTER for {{candidate_name}} joining {{start_date}}",
      ]);
      const v2 = await pipeline.generateOfferLetter(t.hr, offer.id, { templateKey: "offer_custom" });
      expect(v2.versionNo).toBe(2);
      expect(v2.templateSource).toBe("custom");
      expect(v2.content).toBe("CUSTOM LETTER for Letter Applicant joining 2027-09-01");
      const letters = await pipeline.listOfferLetters(t.hr, offer.id);
      expect(letters.map((l) => [l.versionNo, l.status])).toEqual([[2, "issued"], [1, "superseded"]]);
      await expect(pipeline.generateOfferLetter(t.hr, offer.id, { templateKey: "nope" })).rejects.toThrow(NotFoundException);
      expect((await recruitment.listOffers(t.hr, application.id))[0].latestLetterVersion).toBe(2);
    });
  });

  // ------------------------------------------------------------------ offer approval workflow (separate tenant)
  describe("offer approval through the workflow engine", () => {
    it("holds the offer in pending_approval until the approver approves", async () => {
      await workflow.createTemplate(other.hr, {
        key: "offer", name: "Offer Approval", objectKey: "offer",
        steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: other.hrRoleId }] }],
      });
      const { application } = await applicationOn(other, "Gate");
      const offer = await recruitment.extendOffer(other.hr, { applicationId: application.id, salary: 110000, startDate: "2027-10-01" });
      expect(offer.status).toBe("pending_approval");
      expect(offer.workflowInstanceId).toBeTruthy();
      await expect(recruitment.decideOffer(other.hr, offer.id, "accepted")).rejects.toThrow(/awaiting approval/);
      await expect(pipeline.generateOfferLetter(other.hr, offer.id, {})).rejects.toThrow(/approved/);

      const step = (await sql<{ id: string }>(
        "SELECT id FROM workflow_step_instances WHERE workflow_instance_id = $1 AND status = 'pending' LIMIT 1", [offer.workflowInstanceId]
      ))[0];
      await workflow.decide(other.approver, step.id, { decision: "approved" });
      const approved = (await recruitment.listOffers(other.hr, application.id))[0];
      expect(approved.status).toBe("pending");
      expect(approved.approvedAt).toBeTruthy();
      const decided = await recruitment.decideOffer(other.hr, offer.id, "accepted");
      expect(decided.offer.status).toBe("accepted");
    });

    it("a rejected approval returns the offer to HR, who can replace it; rescinding withdraws the instance", async () => {
      const { application } = await applicationOn(other, "Gate2");
      const offer = await recruitment.extendOffer(other.hr, { applicationId: application.id, salary: 95000, startDate: "2027-10-01" });
      const step = (await sql<{ id: string }>(
        "SELECT id FROM workflow_step_instances WHERE workflow_instance_id = $1 AND status = 'pending' LIMIT 1", [offer.workflowInstanceId]
      ))[0];
      await workflow.decide(other.approver, step.id, { decision: "rejected", comment: "Above band" });
      expect((await recruitment.listOffers(other.hr, application.id))[0].status).toBe("approval_rejected");
      const replacement = await recruitment.extendOffer(other.hr, { applicationId: application.id, salary: 85000, startDate: "2027-10-01" });
      expect(replacement.status).toBe("pending_approval");
      const old = (await recruitment.listOffers(other.hr, application.id)).find((o) => o.id === offer.id)!;
      expect(old.status).toBe("rescinded");
      await recruitment.rescindOffer(other.hr, replacement.id, "Role on hold");
      const inst = (await sql<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [replacement.workflowInstanceId]))[0];
      expect(["withdrawn", "cancelled"]).toContain(inst.status);
    });
  });

  // ------------------------------------------------------------------ events and calendar
  describe("recruitment events and calendar", () => {
    it("creates an event, registers candidates up to capacity, marks attendance and shows it on the calendar", async () => {
      const ev = await pipeline.createEvent(t.hr, {
        title: "NED Campus Drive", eventType: "campus_drive", startsAt: "2027-02-10T05:00:00Z", endsAt: "2027-02-10T11:00:00Z",
        locationText: "NED University", capacity: 2, requisitionId: t.requisitionId,
      });
      expect(ev.attendeeCount).toBe(0);
      const c1 = await candidateOn(t, "Ev1");
      const c2 = await candidateOn(t, "Ev2");
      const c3 = await candidateOn(t, "Ev3");
      await pipeline.addEventAttendee(t.hr, ev.id, c1.id);
      await expect(pipeline.addEventAttendee(t.hr, ev.id, c1.id)).rejects.toThrow(/already registered/);
      const full = await pipeline.addEventAttendee(t.hr, ev.id, c2.id);
      expect(full.attendeeCount).toBe(2);
      await expect(pipeline.addEventAttendee(t.hr, ev.id, c3.id)).rejects.toThrow(/full/);
      await pipeline.markEventAttendance(t.hr, ev.id, c1.id, true);
      const attendees = await pipeline.listEventAttendees(t.hr, ev.id);
      expect(attendees.find((a) => a.candidateId === c1.id)!.attended).toBe(true);
      expect((await pipeline.getCandidateTimeline(t.hr, c1.id)).some((e) => e.kind === "event")).toBe(true);
      await pipeline.removeEventAttendee(t.hr, ev.id, c2.id);
      await expect(pipeline.markEventAttendance(t.hr, ev.id, c2.id, true)).rejects.toThrow(NotFoundException);

      const cal = await pipeline.getCalendar(t.hr, "2027-02-01T00:00:00Z", "2027-03-31T00:00:00Z");
      expect(cal.some((e) => e.kind === "event" && e.id === ev.id)).toBe(true);
      expect(cal.some((e) => e.kind === "interview")).toBe(true);
      await expect(pipeline.getCalendar(t.hr, "2027-03-31T00:00:00Z", "2027-02-01T00:00:00Z")).rejects.toThrow(BadRequestException);
      await expect(pipeline.createEvent(t.hr, { title: "Bad", startsAt: "2027-02-10T05:00:00Z", endsAt: "2027-02-09T05:00:00Z" })).rejects.toThrow(/end before/);
      const cancelled = await pipeline.updateEvent(t.hr, ev.id, { title: "NED Campus Drive", startsAt: "2027-02-10T05:00:00Z", status: "cancelled" });
      expect(cancelled.status).toBe("cancelled");
      await expect(pipeline.addEventAttendee(t.hr, ev.id, c3.id)).rejects.toThrow(/cancelled/);
    });
  });

  // ------------------------------------------------------------------ permissions and tenant isolation
  describe("permissions and tenant isolation", () => {
    it("denies every management call to a user without recruitment.manage.all", async () => {
      await expect(recruitment.createCandidate(t.outsider, { firstName: "X", lastName: "Y" })).rejects.toThrow(ForbiddenException);
      await expect(recruitment.checkCandidateDuplicates(t.outsider, { email: "a@b.co" })).rejects.toThrow(ForbiddenException);
      await expect(pipeline.getSettings(t.outsider)).rejects.toThrow(ForbiddenException);
      await expect(pipeline.listEvents(t.outsider)).rejects.toThrow(ForbiddenException);
      await expect(pipeline.scheduleInterview(t.outsider, { applicationId: "x", scheduledStart: "2027-01-01T00:00:00Z", scheduledEnd: "2027-01-01T01:00:00Z", interviewerEmployeeIds: [] })).rejects.toThrow(ForbiddenException);
    });

    it("another company cannot see, change or schedule against this company's candidates", async () => {
      const c = await candidateOn(t, "Private", { nationalId: nextCnic(), phone: nextPhone() });
      const { application } = await applicationOn(t, "PrivateApp");
      expect((await recruitment.listCandidates(other.hr)).map((x) => x.id)).not.toContain(c.id);
      await expect(recruitment.getCandidate(other.hr, c.id)).rejects.toThrow(NotFoundException);
      await expect(recruitment.updateCandidate(other.hr, c.id, { firstName: "Hijack" })).rejects.toThrow(NotFoundException);
      await expect(pipeline.getCandidateTimeline(other.hr, c.id)).rejects.toThrow(NotFoundException);
      await expect(pipeline.getApplicationTimeline(other.hr, application.id)).rejects.toThrow(NotFoundException);
      await expect(pipeline.addDocument(other.hr, c.id, "resume", PDF)).rejects.toThrow(NotFoundException);
      // duplicate detection never leaks across tenants
      expect(await recruitment.checkCandidateDuplicates(other.hr, { email: c.email! })).toHaveLength(0);
    });

    it("the module entitlement still switches the whole area off", async () => {
      await sql("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'recruitment'", [t.companyId]);
      await expect(pipeline.listEvents(t.hr)).rejects.toThrow(NotFoundException);
      await expect(pipeline.listMyInterviews(t.hr)).rejects.toThrow(NotFoundException);
      await sql("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'recruitment'", [t.companyId]);
    });
  });
});
