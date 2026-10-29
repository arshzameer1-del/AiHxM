import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Inject } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CareersEmploymentType, CareersJobView, CareersPageView, RequisitionCareersView, SaveRequisitionCareersRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";
import { CandidateMailService } from "../recruitment/candidate-mail.service";
import { loadRecruitmentSettings } from "../recruitment/recruitment.mappers";

const PUBLIC_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "public-careers" };
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const EMPLOYMENT_TYPES: CareersEmploymentType[] = ["full_time", "part_time", "contract", "internship"];
const HIDDEN_COMPANY_STATUSES = ["suspended", "terminated", "archived", "cancelled"];
const OPEN_STATUSES = ["approved", "open"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10)) : null);

export type ApplyInput = {
  firstName?: string; lastName?: string; email?: string; phone?: string; currentEmployer?: string; currentDesignation?: string;
  expectedSalary?: string; noticePeriodDays?: string; coverNote?: string; consent?: string; website?: string;
};
export type ResumeFile = { originalname: string; mimetype: string; buffer: Buffer; size: number };

/** A resume is checked by what is inside it, not by what the browser says it is. */
function resumeKind(file: ResumeFile): { mime: string } | null {
  const b = file.buffer;
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf" };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && /\.docx$/i.test(file.originalname)) {
    return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && /\.doc$/i.test(file.originalname)) return { mime: "application/msword" };
  return null;
}

/**
 * The company's public careers page and the HR side of it. A requisition appears publicly only when the company switched
 * the page on, the requisition is approved or open, HR published it and its closing date has not passed. Nothing internal
 * (salary band, justification, headcount, hiring manager) is ever returned to the public.
 */
@Injectable()
export class CareersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly candidateMail: CandidateMailService,
    private readonly inbox: UserNotificationsService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  // ------------------------------------------------------------------ HR side

  async listForRequisitions(claims: RequestClaims): Promise<RequisitionCareersView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT r.*, (SELECT COUNT(*)::int FROM applications a WHERE a.requisition_id = r.id) AS application_count
           FROM job_requisitions r WHERE r.company_id = $1 AND r.status IN ('approved', 'open', 'closed') ORDER BY r.created_at DESC LIMIT 300`,
        [claims.company_id]
      );
      return r.rows.map((x) => this.toView(x));
    });
  }

  async save(claims: RequestClaims, requisitionId: string, input: SaveRequisitionCareersRequest): Promise<RequisitionCareersView> {
    await this.requireManage(claims);
    if (input.employmentType && !EMPLOYMENT_TYPES.includes(input.employmentType)) throw new BadRequestException("Choose a valid employment type");
    if (input.closesOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.closesOn)) throw new BadRequestException("The closing date must be a valid date");
    const description = input.description?.trim() || null;
    if (description && description.length > 8000) throw new BadRequestException("Keep the job description under 8,000 characters");
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM job_requisitions WHERE id = $1 FOR UPDATE", [requisitionId]);
      if (!cur.rowCount) throw new NotFoundException("Requisition not found");
      const req = cur.rows[0];
      if (input.publish) {
        if (!OPEN_STATUSES.includes(req.status)) throw new BadRequestException("Only an approved requisition can be published on the careers page");
        if (!description) throw new BadRequestException("Write the job description people will read before publishing");
        if (input.closesOn && input.closesOn < localToday()) throw new BadRequestException("The closing date has already passed");
      }
      await client.query(
        `UPDATE job_requisitions SET publish_to_careers = $2, public_description = $3, public_location = $4, employment_type = $5, closes_on = $6,
                careers_published_at = CASE WHEN $2 AND (NOT publish_to_careers OR careers_published_at IS NULL) THEN now() WHEN NOT $2 THEN NULL ELSE careers_published_at END, updated_at = now()
          WHERE id = $1`,
        [requisitionId, input.publish, description, input.location?.trim().slice(0, 200) || null, input.employmentType ?? null, input.closesOn || null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: input.publish ? "careers.publish" : "careers.unpublish", target: requisitionId, metadata: { title: req.title } });
      const out = await client.query(
        `SELECT r.*, (SELECT COUNT(*)::int FROM applications a WHERE a.requisition_id = r.id) AS application_count FROM job_requisitions r WHERE r.id = $1`,
        [requisitionId]
      );
      return this.toView(out.rows[0]);
    });
  }

  // ------------------------------------------------------------------ public side

  async page(slug: string): Promise<CareersPageView> {
    return this.db.withClaims(PUBLIC_CLAIMS, async (client) => {
      const co = await this.visibleCompany(client, slug);
      const settings = await loadRecruitmentSettings(client, co.id);
      if (!settings.careersEnabled) throw new NotFoundException("No careers page here");
      const r = await client.query(`${PUBLIC_JOB_SELECT} WHERE r.company_id = $1 AND ${PUBLIC_JOB_WHERE} ORDER BY r.careers_published_at DESC`, [co.id, localToday()]);
      return { companyName: co.name, slug, intro: settings.careersIntro, jobs: r.rows.map(toPublicJob) };
    });
  }

  async job(slug: string, jobId: string): Promise<CareersJobView & { companyName: string }> {
    return this.db.withClaims(PUBLIC_CLAIMS, async (client) => {
      const co = await this.visibleCompany(client, slug);
      const settings = await loadRecruitmentSettings(client, co.id);
      if (!settings.careersEnabled) throw new NotFoundException("No careers page here");
      const r = await client.query(`${PUBLIC_JOB_SELECT} WHERE r.company_id = $1 AND r.id = $3 AND ${PUBLIC_JOB_WHERE}`, [co.id, localToday(), jobId]);
      if (!r.rowCount) throw new NotFoundException("This job is no longer open");
      return { ...toPublicJob(r.rows[0]), companyName: co.name };
    });
  }

  /**
   * Anyone may apply. A person already known by e-mail is reused (their stored details are never overwritten by a public
   * form) and applying twice to the same job is accepted without creating a second application and without telling the
   * visitor whether they were known, so the form cannot be used to find out who has applied.
   */
  async apply(slug: string, jobId: string, input: ApplyInput, file: ResumeFile | undefined): Promise<{ ok: true }> {
    if (input.website && input.website.trim() !== "") return { ok: true }; // honeypot: pretend success, store nothing
    const firstName = (input.firstName ?? "").trim();
    const lastName = (input.lastName ?? "").trim();
    const email = (input.email ?? "").trim().toLowerCase();
    if (!firstName || !lastName) throw new BadRequestException("Enter your first and last name");
    if (firstName.length > 80 || lastName.length > 80) throw new BadRequestException("Names must be under 80 characters");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) throw new BadRequestException("Enter a valid e-mail address");
    if (input.consent !== "true") throw new BadRequestException("Please agree to us keeping your details to consider your application");
    const phone = (input.phone ?? "").trim().slice(0, 40) || null;
    let salary: number | null = null;
    if (input.expectedSalary?.trim()) {
      salary = Number(input.expectedSalary);
      if (!Number.isFinite(salary) || salary < 0 || salary > 1e10) throw new BadRequestException("Expected salary must be a number");
    }
    let notice: number | null = null;
    if (input.noticePeriodDays?.trim()) {
      notice = Number(input.noticePeriodDays);
      if (!Number.isInteger(notice) || notice < 0 || notice > 365) throw new BadRequestException("Notice period must be a whole number of days");
    }
    const note = (input.coverNote ?? "").trim().slice(0, 3000) || null;
    let resumeMime: string | null = null;
    if (file) {
      if (file.size > MAX_RESUME_BYTES) throw new BadRequestException("Your CV must be 5 MB or smaller");
      const kind = resumeKind(file);
      if (!kind) throw new BadRequestException("Upload your CV as a PDF or Word file");
      resumeMime = kind.mime;
    }

    const result = await this.db.withClaims(PUBLIC_CLAIMS, async (client) => {
      const co = await this.visibleCompany(client, slug);
      const settings = await loadRecruitmentSettings(client, co.id);
      if (!settings.careersEnabled) throw new NotFoundException("No careers page here");
      const job = await client.query(`${PUBLIC_JOB_SELECT} WHERE r.company_id = $1 AND r.id = $3 AND ${PUBLIC_JOB_WHERE}`, [co.id, localToday(), jobId]);
      if (!job.rowCount) throw new NotFoundException("This job is no longer open");

      const known = await client.query("SELECT id, anonymised_at FROM candidates WHERE company_id = $1 AND lower(email) = $2 ORDER BY created_at LIMIT 1", [co.id, email]);
      let candidateId: string;
      if (known.rowCount && !known.rows[0].anonymised_at) {
        candidateId = known.rows[0].id;
        await client.query(
          `UPDATE candidates SET phone = COALESCE(phone, $2), current_employer = COALESCE(current_employer, $3), current_designation = COALESCE(current_designation, $4),
                  expected_salary = COALESCE(expected_salary, $5), notice_period_days = COALESCE(notice_period_days, $6),
                  consent_given_at = COALESCE(consent_given_at, now()), consent_purpose = COALESCE(consent_purpose, 'Considering my job application'),
                  retention_until = CASE WHEN $7::int IS NULL THEN retention_until ELSE GREATEST(COALESCE(retention_until, CURRENT_DATE), (CURRENT_DATE + make_interval(months => $7::int))::date) END,
                  updated_at = now()
            WHERE id = $1`,
          [candidateId, phone, input.currentEmployer?.trim().slice(0, 200) || null, input.currentDesignation?.trim().slice(0, 200) || null, salary, notice, settings.candidateRetentionMonths]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO candidates (company_id, first_name, last_name, email, phone, source, current_employer, current_designation, expected_salary, notice_period_days,
                                   consent_given_at, consent_purpose, retention_until)
           VALUES ($1,$2,$3,$4,$5,'company_website',$6,$7,$8,$9, now(), 'Considering my job application',
                   CASE WHEN $10::int IS NULL THEN NULL ELSE (CURRENT_DATE + make_interval(months => $10::int))::date END)
           RETURNING id`,
          [co.id, firstName, lastName, email, phone, input.currentEmployer?.trim().slice(0, 200) || null, input.currentDesignation?.trim().slice(0, 200) || null, salary, notice, settings.candidateRetentionMonths]
        );
        candidateId = ins.rows[0].id;
      }

      const dup = await client.query("SELECT id FROM applications WHERE requisition_id = $1 AND candidate_id = $2", [jobId, candidateId]);
      if (dup.rowCount) return { applicationId: null as string | null, companyId: co.id, title: job.rows[0].title as string };

      const app = await client.query(
        `INSERT INTO applications (company_id, requisition_id, candidate_id, stage, source, cover_note) VALUES ($1,$2,$3,'applied','company_website',$4) RETURNING id`,
        [co.id, jobId, candidateId, note]
      );
      await client.query(
        `INSERT INTO application_stage_history (company_id, application_id, from_stage, to_stage, reason, changed_by) VALUES ($1,$2,NULL,'applied','Applied on the careers page',NULL)`,
        [co.id, app.rows[0].id]
      );
      if (file && resumeMime) {
        const quota = await client.query(
          `SELECT c.storage_quota_mb,
                  (SELECT COALESCE(SUM(size_bytes), 0) FROM employee_documents WHERE company_id = c.id) + (SELECT COALESCE(SUM(size_bytes), 0) FROM candidate_documents WHERE company_id = c.id) AS used_bytes
             FROM companies c WHERE c.id = $1`,
          [co.id]
        );
        if (Number(quota.rows[0].used_bytes) + file.size <= Number(quota.rows[0].storage_quota_mb) * 1024 * 1024) {
          const stored = await this.fileStorage.save(co.id, `candidate-${candidateId}`, file.originalname, file.buffer);
          await client.query(
            `INSERT INTO candidate_documents (company_id, candidate_id, doc_type, file_name, mime_type, size_bytes, storage_path, uploaded_by) VALUES ($1,$2,'resume',$3,$4,$5,$6,NULL)`,
            [co.id, candidateId, file.originalname.slice(0, 200), resumeMime, stored.sizeBytes, stored.storagePath]
          );
        }
      }
      return { applicationId: app.rows[0].id as string, companyId: co.id, title: job.rows[0].title as string, name: `${firstName} ${lastName}` };
    });

    if (result.applicationId) {
      await this.candidateMail.send("application_receipt", result.applicationId);
      await this.inbox.notify({
        companyId: result.companyId, userAccountIds: await this.inbox.hrAdminUserIds(result.companyId), category: "hr_inbox",
        title: `New application for ${result.title}`, body: "name" in result ? String(result.name) : undefined, link: "/app/recruitment",
      });
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ internals

  private async visibleCompany(client: PoolClient, slug: string): Promise<{ id: string; name: string }> {
    const r = await client.query("SELECT id, name, status FROM companies WHERE slug = $1", [slug.toLowerCase()]);
    if (!r.rowCount || HIDDEN_COMPANY_STATUSES.includes(r.rows[0].status)) throw new NotFoundException("No such company");
    return { id: r.rows[0].id, name: r.rows[0].name };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toView(x: any): RequisitionCareersView {
    return {
      requisitionId: x.id, title: x.title, status: x.status, published: !!x.publish_to_careers, description: x.public_description ?? null,
      location: x.public_location ?? null, employmentType: x.employment_type ?? null, closesOn: day(x.closes_on),
      publishedAt: x.careers_published_at ? new Date(x.careers_published_at).toISOString() : null, applicationCount: x.application_count ?? 0,
    };
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "recruitment"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "recruitment.manage.all"))) throw new ForbiddenException("Not permitted to manage the careers page");
  }
}

const PUBLIC_JOB_SELECT = `SELECT r.id, r.title, r.department, r.public_location, r.employment_type, r.public_description, r.closes_on, r.careers_published_at FROM job_requisitions r`;
const PUBLIC_JOB_WHERE = `r.publish_to_careers AND r.status IN ('approved', 'open') AND (r.closes_on IS NULL OR r.closes_on >= $2::date)`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPublicJob(x: any): CareersJobView {
  return {
    id: x.id, title: x.title, department: x.department ?? null, location: x.public_location ?? null, employmentType: x.employment_type ?? null,
    description: x.public_description ?? null, closesOn: day(x.closes_on), postedOn: day(x.careers_published_at),
  };
}
