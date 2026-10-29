import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { CandidateMailService } from "../recruitment/candidate-mail.service";
import { RecruitmentPipelineService } from "../recruitment/recruitment-pipeline.service";
import { CareersService } from "./careers.service";

/** The public careers page and the candidate e-mails, against real Postgres. */
describe("Careers page and candidate e-mails", () => {
  let f: PayrollFixture;
  let svc: CareersService;
  let mail: CandidateMailService;
  let pipeline: RecruitmentPipelineService;
  let slug: string;
  let jobId: string;
  let draftId: string;
  let staff: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  const pdf = (name = "cv.pdf") => ({ originalname: name, mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 resume body"), size: 21 });
  const form = (over: Record<string, string> = {}) => ({ firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "0300-1234567", consent: "true", ...over });
  const logRows = (tpl: string) => f.sql<{ status: string }>("SELECT status FROM notification_log WHERE company_id = $1 AND template_key = $2", [f.companyId, tpl]);
  const setSettings = (cols: string, vals: unknown[]) =>
    f.sql(`INSERT INTO recruitment_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING`, [f.companyId]).then(() =>
      f.sql(`UPDATE recruitment_settings SET ${cols} WHERE company_id = $1`, [f.companyId, ...vals]));

  beforeAll(async () => {
    f = await buildPayrollFixture("car1");
    slug = (await f.sql<{ slug: string }>("SELECT slug FROM companies WHERE id = $1", [f.companyId]))[0].slug;
    await f.sql("UPDATE company_config SET enabled_modules = enabled_modules || '[\"recruitment\"]'::jsonb WHERE company_id = $1", [f.companyId]);
    await f.sql("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'recruitment',true) ON CONFLICT DO NOTHING", [f.companyId]);
    const mailer = new MailerService();
    const storage = new LocalFileStorageService();
    mail = new CandidateMailService(f.db, mailer);
    svc = new CareersService(f.db, f.rbac, f.entitlements, f.audit, mail, new UserNotificationsService(f.db, mailer), storage);
    pipeline = new RecruitmentPipelineService(f.db, f.rbac, f.entitlements, f.audit, storage, mail);
    staff = await f.makeUser("careers-staff", ["employee_self_service"]);
    const hrUser = f.hr.sub as string;
    const mk = async (title: string, status: string) =>
      (await f.sql<{ id: string }>(
        `INSERT INTO job_requisitions (company_id, title, department, headcount, salary_band, justification, status, created_by_user_account_id)
         VALUES ($1,$2,'Engineering',2,'PKR 400k-500k','secret reason',$3,$4) RETURNING id`,
        [f.companyId, title, status, hrUser]
      ))[0].id;
    jobId = await mk("Backend Engineer", "approved");
    draftId = await mk("Unapproved Role", "draft");
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("HR only: staff cannot manage the careers page", async () => {
    await expect(svc.listForRequisitions(staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.save(staff, jobId, { publish: true, description: "x" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("only an approved requisition with a description can be published", async () => {
    await expect(svc.save(f.hr, draftId, { publish: true, description: "text" })).rejects.toThrow(/approved/);
    await expect(svc.save(f.hr, jobId, { publish: true, description: "  " })).rejects.toThrow(/job description/);
    await expect(svc.save(f.hr, jobId, { publish: true, description: "x", closesOn: "2000-01-01" })).rejects.toThrow(/already passed/);
    const v = await svc.save(f.hr, jobId, { publish: true, description: "Build APIs.", location: "Lahore", employmentType: "full_time" });
    expect(v.published).toBe(true);
    expect(v.publishedAt).not.toBeNull();
  });

  it("the page is invisible until the company switches it on, and then shows no internal fields", async () => {
    await expect(svc.page(slug)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.job(slug, jobId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.page("no-such-company")).rejects.toBeInstanceOf(NotFoundException);
    await setSettings("careers_enabled = true, careers_intro = $2", ["Join us"]);
    const page = await svc.page(slug);
    expect(page.intro).toBe("Join us");
    expect(page.jobs.map((j) => j.title)).toEqual(["Backend Engineer"]);
    const blob = JSON.stringify(page) + JSON.stringify(await svc.job(slug, jobId));
    expect(blob).not.toMatch(/secret reason|400k|headcount|salary/i);
    await expect(svc.job(slug, draftId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("applying stores the candidate, application and resume, and logs the receipt", async () => {
    await expect(svc.apply(slug, jobId, form({ consent: "false" }), pdf())).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.apply(slug, jobId, form({ email: "nope" }), pdf())).rejects.toThrow(/e-mail/);
    await expect(svc.apply(slug, jobId, form({ firstName: "" }), pdf())).rejects.toThrow(/name/);
    await expect(svc.apply(slug, jobId, form(), { originalname: "evil.pdf", mimetype: "application/pdf", buffer: Buffer.from("MZ not a pdf"), size: 12 })).rejects.toThrow();
    expect(await f.sql("SELECT 1 FROM candidates WHERE company_id = $1", [f.companyId])).toHaveLength(0);

    expect(await svc.apply(slug, jobId, form(), pdf())).toEqual({ ok: true });
    const apps = await f.sql<{ stage: string; source: string }>("SELECT stage, source FROM applications WHERE company_id = $1", [f.companyId]);
    expect(apps).toEqual([{ stage: "applied", source: "company_website" }]);
    const docs = await f.sql<{ doc_type: string; mime_type: string }>("SELECT doc_type, mime_type FROM candidate_documents WHERE company_id = $1", [f.companyId]);
    expect(docs).toEqual([{ doc_type: "resume", mime_type: "application/pdf" }]);
    expect((await logRows("candidate_application_receipt")).length).toBe(1);
    expect(await f.sql("SELECT 1 FROM user_notifications WHERE title LIKE 'New application%'")).not.toHaveLength(0);
  });

  it("applying twice is accepted silently without a second application or a second receipt", async () => {
    expect(await svc.apply(slug, jobId, form({ firstName: "Different" }), pdf())).toEqual({ ok: true });
    expect(await f.sql("SELECT 1 FROM applications WHERE company_id = $1", [f.companyId])).toHaveLength(1);
    expect(await f.sql("SELECT 1 FROM candidates WHERE company_id = $1", [f.companyId])).toHaveLength(1);
    expect((await f.sql<{ first_name: string }>("SELECT first_name FROM candidates WHERE company_id = $1", [f.companyId]))[0].first_name).toBe("Ayesha");
    expect((await logRows("candidate_application_receipt")).length).toBe(1);
  });

  it("the honeypot stores nothing", async () => {
    expect(await svc.apply(slug, jobId, form({ email: "bot@example.com", website: "http://spam" }), pdf())).toEqual({ ok: true });
    expect(await f.sql("SELECT 1 FROM candidates WHERE email = 'bot@example.com'")).toHaveLength(0);
  });

  it("an expired or unpublished job refuses applications", async () => {
    await svc.save(f.hr, jobId, { publish: false, description: "Build APIs." });
    await expect(svc.apply(slug, jobId, form({ email: "late@example.com" }), pdf())).rejects.toBeInstanceOf(NotFoundException);
    await svc.save(f.hr, jobId, { publish: true, description: "Build APIs." });
  });

  it("the receipt can be switched off, the rejection e-mail is off by default and the interview invitation follows its switch", async () => {
    const appId = (await f.sql<{ id: string }>("SELECT id FROM applications WHERE company_id = $1", [f.companyId]))[0].id;
    expect(await mail.send("application_rejected", appId)).toBe("skipped");
    expect(await logRows("candidate_application_rejected")).toHaveLength(0);

    const saved = await pipeline.updateSettings(f.hr, { sendRejectionEmails: true, sendApplicationReceipt: false });
    expect(saved.sendRejectionEmails).toBe(true);
    expect(saved.sendApplicationReceipt).toBe(false);
    expect(await mail.send("application_rejected", appId)).not.toBe("skipped");
    expect((await logRows("candidate_application_rejected")).length).toBe(1);
    expect(await mail.send("application_receipt", appId)).toBe("skipped");

    const iv = (
      await f.sql<{ id: string }>(
        `INSERT INTO interviews (company_id, application_id, interview_type, scheduled_start, scheduled_end, meeting_link)
         VALUES ($1,$2,'video', now() + interval '2 days', now() + interval '2 days 1 hour', 'https://meet.example.com/x') RETURNING id`,
        [f.companyId, appId]
      )
    )[0].id;
    expect(await mail.send("interview_invitation", appId, { interviewId: iv })).not.toBe("skipped");
    expect((await logRows("candidate_interview_invitation")).length).toBe(1);
    await pipeline.updateSettings(f.hr, { sendInterviewEmails: false });
    expect(await mail.send("interview_invitation", appId, { interviewId: iv })).toBe("skipped");
  });

  it("an anonymised candidate gets no e-mail", async () => {
    const appId = (await f.sql<{ id: string }>("SELECT id FROM applications WHERE company_id = $1", [f.companyId]))[0].id;
    await f.sql("UPDATE candidates SET anonymised_at = now() WHERE company_id = $1", [f.companyId]);
    expect(await mail.send("application_rejected", appId)).toBe("skipped");
  });
});
