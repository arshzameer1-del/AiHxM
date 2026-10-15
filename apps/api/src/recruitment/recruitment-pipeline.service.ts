import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  ApplicationStage,
  ApplicationStageHistoryView,
  ApplicationTimelineView,
  CandidateDocumentType,
  CandidateDocumentView,
  CandidateTimelineEntry,
  CreatePreEmploymentCheckRequest,
  GenerateOfferLetterRequest,
  InterviewFeedbackView,
  InterviewView,
  OfferLetterView,
  PreEmploymentCheckView,
  RecruitmentCalendarEntry,
  RecruitmentEventView,
  RecruitmentSettingsView,
  ScheduleInterviewRequest,
  SubmitInterviewFeedbackRequest,
  UpdateInterviewRequest,
  UpdatePreEmploymentCheckRequest,
  UpdateRecruitmentSettingsRequest,
  UpsertRecruitmentEventRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import { RbacService } from "../rbac/rbac.service";
import { renderPlaceholders } from "../payroll/payroll-documents.service";
import {
  loadOfferView,
  loadRecruitmentSettings,
  recordStageChange,
  rowToApplication,
  toIso,
  toIsoDate,
} from "./recruitment.mappers";

const MODULE_KEY = "recruitment" as const;
const MANAGE_PERMISSION = "recruitment.manage.all";
const MAX_CANDIDATE_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const DOC_TYPES: CandidateDocumentType[] = ["resume", "cover_letter", "identity", "certificate", "reference", "other"];

/** Offer letter used when the tenant has not chosen a template. Placeholders are `{{key}}`. */
export const BUILT_IN_OFFER_LETTER = [
  "{{offer_date}}",
  "",
  "Dear {{candidate_name}},",
  "",
  "{{company_name}} is pleased to offer you the position of {{position_title}}{{department_clause}}.",
  "",
  "Proposed joining date: {{start_date}}",
  "Gross monthly package: {{currency}} {{salary}}",
  "{{components_block}}",
  "This offer is valid until {{expires_at}}.",
  "",
  "Please confirm your acceptance in writing by that date.",
  "",
  "Sincerely,",
  "{{company_name}} - Human Resources",
].join("\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDocument(r: any): CandidateDocumentView {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    docType: r.doc_type,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    uploadedBy: r.uploaded_by ?? null,
    createdAt: toIso(r.created_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToFeedback(r: any): InterviewFeedbackView {
  return {
    id: r.id,
    interviewId: r.interview_id,
    employeeId: r.employee_id,
    overallRating: r.overall_rating,
    recommendation: r.recommendation,
    strengths: r.strengths ?? null,
    concerns: r.concerns ?? null,
    scorecard: r.scorecard ?? [],
    submittedAt: toIso(r.submitted_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCheck(r: any): PreEmploymentCheckView {
  return {
    id: r.id,
    applicationId: r.application_id,
    checkType: r.check_type,
    label: r.label ?? null,
    isRequired: r.is_required,
    status: r.status,
    resultNote: r.result_note ?? null,
    performedBy: r.performed_by ?? null,
    updatedAt: toIso(r.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLetter(r: any): OfferLetterView {
  return {
    id: r.id,
    offerId: r.offer_id,
    versionNo: r.version_no,
    templateKey: r.template_key ?? null,
    templateSource: r.template_source,
    content: r.content,
    contentHash: r.content_hash,
    status: r.status,
    generatedAt: toIso(r.generated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEvent(r: any): RecruitmentEventView {
  return {
    id: r.id,
    title: r.title,
    eventType: r.event_type,
    startsAt: toIso(r.starts_at) as string,
    endsAt: toIso(r.ends_at),
    locationId: r.location_id ?? null,
    locationText: r.location_text ?? null,
    requisitionId: r.requisition_id ?? null,
    capacity: r.capacity ?? null,
    status: r.status,
    notes: r.notes ?? null,
    attendeeCount: Number(r.attendee_count ?? 0),
  };
}

/**
 * Step 11A (TAL-01..TAL-04): the recruitment work around the pipeline - candidate documents, interviews and
 * feedback, pre-employment checks, application timelines, offer letters, recruiting events and the retention job.
 * Permission model: `recruitment.manage.all` for everything; additionally an INTERVIEWER (an employee assigned to an
 * interview, identified through employees.user_account_id) may read their own interviews and submit feedback on them,
 * and only ever sees their own feedback - reuse of the existing permission, no new key.
 */
@Injectable()
export class RecruitmentPipelineService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  // --- settings --------------------------------------------------------------

  async getSettings(claims: RequestClaims): Promise<RecruitmentSettingsView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => loadRecruitmentSettings(client, claims.company_id as string));
  }

  async updateSettings(claims: RequestClaims, input: UpdateRecruitmentSettingsRequest): Promise<RecruitmentSettingsView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const before = await loadRecruitmentSettings(client, companyId);
      const next = { ...before, ...input };
      if (next.candidateRetentionMonths !== null && (!Number.isInteger(next.candidateRetentionMonths) || next.candidateRetentionMonths < 1 || next.candidateRetentionMonths > 240)) {
        throw new BadRequestException("Retention must be a whole number of months between 1 and 240, or empty for no automatic anonymisation");
      }
      if (next.offerValidityDays !== null && (!Number.isInteger(next.offerValidityDays) || next.offerValidityDays < 1 || next.offerValidityDays > 365)) {
        throw new BadRequestException("Offer validity must be a whole number of days between 1 and 365, or empty");
      }
      if (next.offerLetterTemplateKey) {
        const t = await client.query(`SELECT 1 FROM document_templates WHERE key = $1`, [next.offerLetterTemplateKey]);
        if (t.rowCount === 0) throw new BadRequestException("That offer letter template does not exist");
      }
      await client.query(
        `INSERT INTO recruitment_settings (company_id, candidate_retention_months, consent_required, offer_validity_days, offer_letter_template_key, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (company_id) DO UPDATE SET candidate_retention_months = EXCLUDED.candidate_retention_months,
           consent_required = EXCLUDED.consent_required, offer_validity_days = EXCLUDED.offer_validity_days,
           offer_letter_template_key = EXCLUDED.offer_letter_template_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, next.candidateRetentionMonths, next.consentRequired, next.offerValidityDays, next.offerLetterTemplateKey || null, claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "recruitment.settings_update", target: companyId, before: { ...before }, after: { ...next } });
      return next;
    });
  }

  // --- candidate documents -----------------------------------------------------

  async addDocument(
    claims: RequestClaims,
    candidateId: string,
    docType: string | undefined,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number } | undefined
  ): Promise<CandidateDocumentView> {
    await this.requireManage(claims);
    if (!file) throw new BadRequestException("Choose a file to upload");
    if (file.size > MAX_CANDIDATE_DOCUMENT_BYTES) throw new BadRequestException(`File exceeds the ${MAX_CANDIDATE_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`"${file.mimetype}" isn't an allowed file type for candidate documents. Allowed: PDF, JPEG, PNG, WEBP and Word files.`);
    }
    const type = (docType ?? "resume") as CandidateDocumentType;
    if (!DOC_TYPES.includes(type)) throw new BadRequestException(`Document type must be one of: ${DOC_TYPES.join(", ")}`);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const cand = await client.query(`SELECT id, anonymised_at FROM candidates WHERE id = $1`, [candidateId]);
      if (cand.rowCount === 0) throw new NotFoundException("Candidate not found");
      if (cand.rows[0].anonymised_at) throw new BadRequestException("This candidate has been anonymised");
      const quota = await client.query(
        `SELECT c.storage_quota_mb,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM employee_documents WHERE company_id = c.id)
              + (SELECT COALESCE(SUM(size_bytes), 0) FROM candidate_documents WHERE company_id = c.id) AS used_bytes
           FROM companies c WHERE c.id = $1`,
        [companyId]
      );
      const quotaMb = Number(quota.rows[0].storage_quota_mb);
      if (Number(quota.rows[0].used_bytes) + file.size > quotaMb * 1024 * 1024) {
        throw new BadRequestException(`This upload would exceed the tenant's storage quota (${quotaMb} MB). Ask a Platform Admin to raise it, or remove unused documents first.`);
      }
      const stored = await this.fileStorage.save(companyId, `candidate-${candidateId}`, file.originalname, file.buffer);
      const r = await client.query(
        `INSERT INTO candidate_documents (company_id, candidate_id, doc_type, file_name, mime_type, size_bytes, storage_path, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [companyId, candidateId, type, file.originalname, file.mimetype, stored.sizeBytes, stored.storagePath, claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "candidate.document_add", target: candidateId, metadata: { docType: type, fileName: file.originalname } });
      return rowToDocument(r.rows[0]);
    });
  }

  async listDocuments(claims: RequestClaims, candidateId: string): Promise<CandidateDocumentView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`SELECT * FROM candidate_documents WHERE candidate_id = $1 ORDER BY created_at DESC`, [candidateId]);
      return r.rows.map(rowToDocument);
    });
  }

  async downloadDocument(claims: RequestClaims, candidateId: string, documentId: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    await this.requireManage(claims);
    const row = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(`SELECT * FROM candidate_documents WHERE id = $1 AND candidate_id = $2`, [documentId, candidateId]);
      if (r.rowCount === 0) throw new NotFoundException("Document not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "candidate.document_download", target: documentId });
      return r.rows[0];
    });
    return { buffer: await this.fileStorage.read(row.storage_path), fileName: row.file_name, mimeType: row.mime_type };
  }

  async deleteDocument(claims: RequestClaims, candidateId: string, documentId: string): Promise<{ deleted: true }> {
    await this.requireManage(claims);
    const path = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(`DELETE FROM candidate_documents WHERE id = $1 AND candidate_id = $2 RETURNING storage_path`, [documentId, candidateId]);
      if (r.rowCount === 0) throw new NotFoundException("Document not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "candidate.document_delete", target: documentId });
      return r.rows[0].storage_path as string;
    });
    await this.fileStorage.delete(path);
    return { deleted: true };
  }

  // --- interviews --------------------------------------------------------------

  private async loadInterviews(client: PoolClient, where: string, params: unknown[], onlyFeedbackOf?: string): Promise<InterviewView[]> {
    const rows = await client.query(`SELECT i.* FROM interviews i WHERE ${where} ORDER BY i.scheduled_start`, params);
    if (rows.rowCount === 0) return [];
    const ids = rows.rows.map((r) => r.id);
    const interviewers = await client.query(`SELECT interview_id, employee_id FROM interview_interviewers WHERE interview_id = ANY($1::uuid[])`, [ids]);
    const feedback = await client.query(
      `SELECT * FROM interview_feedback WHERE interview_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR employee_id = $2) ORDER BY submitted_at`,
      [ids, onlyFeedbackOf ?? null]
    );
    return rows.rows.map((r) => ({
      id: r.id,
      applicationId: r.application_id,
      roundNo: r.round_no,
      interviewType: r.interview_type,
      scheduledStart: toIso(r.scheduled_start) as string,
      scheduledEnd: toIso(r.scheduled_end) as string,
      locationText: r.location_text ?? null,
      meetingLink: r.meeting_link ?? null,
      status: r.status,
      cancelReason: r.cancel_reason ?? null,
      notes: r.notes ?? null,
      interviewerEmployeeIds: interviewers.rows.filter((x) => x.interview_id === r.id).map((x) => x.employee_id),
      feedback: feedback.rows.filter((f) => f.interview_id === r.id).map(rowToFeedback),
      createdAt: toIso(r.created_at) as string,
    }));
  }

  /** Overlapping scheduled interviews for the same interviewers or the same application (excluding `excludeId`). */
  private async assertNoConflicts(
    client: PoolClient,
    applicationId: string,
    employeeIds: string[],
    start: Date,
    end: Date,
    excludeId?: string
  ): Promise<void> {
    const clash = await client.query(
      `SELECT i.id, i.application_id, ii.employee_id, e.first_name, e.last_name
         FROM interviews i
         LEFT JOIN interview_interviewers ii ON ii.interview_id = i.id AND ii.employee_id = ANY($4::uuid[])
         LEFT JOIN employees e ON e.id = ii.employee_id
        WHERE i.status = 'scheduled' AND i.scheduled_start < $2 AND i.scheduled_end > $1
          AND ($5::uuid IS NULL OR i.id <> $5)
          AND (i.application_id = $3 OR ii.employee_id IS NOT NULL)`,
      [start, end, applicationId, employeeIds, excludeId ?? null]
    );
    if ((clash.rowCount ?? 0) > 0) {
      const people = [...new Set(clash.rows.filter((c) => c.employee_id).map((c) => `${c.first_name} ${c.last_name}`))];
      const sameApp = clash.rows.some((c) => c.application_id === applicationId);
      throw new ConflictException({
        message: `Schedule conflict: ${[sameApp ? "the candidate already has an interview in this window" : null, people.length ? `${people.join(", ")} already ha${people.length > 1 ? "ve" : "s"} an interview in this window` : null].filter(Boolean).join("; ")}.`,
        conflicts: clash.rows.map((c) => ({ interviewId: c.id, employeeId: c.employee_id ?? null })),
      });
    }
  }

  private async assertInterviewers(client: PoolClient, employeeIds: string[]): Promise<void> {
    if (employeeIds.length === 0) throw new BadRequestException("At least one interviewer is required");
    if (new Set(employeeIds).size !== employeeIds.length) throw new BadRequestException("An interviewer can be listed only once");
    const found = await client.query(`SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND employment_status <> 'terminated'`, [employeeIds]);
    if (found.rowCount !== employeeIds.length) throw new BadRequestException("Every interviewer must be a current (non-terminated) employee of this company");
  }

  async scheduleInterview(claims: RequestClaims, input: ScheduleInterviewRequest): Promise<InterviewView> {
    await this.requireManage(claims);
    const start = new Date(input.scheduledStart);
    const end = new Date(input.scheduledEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new BadRequestException("The interview must end after it starts");
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const app = await client.query(`SELECT * FROM applications WHERE id = $1 FOR UPDATE`, [input.applicationId]);
      if (app.rowCount === 0) throw new NotFoundException("Application not found");
      if (["hired", "rejected"].includes(app.rows[0].stage)) throw new BadRequestException(`Cannot schedule an interview for an application that is ${app.rows[0].stage}`);
      await this.assertInterviewers(client, input.interviewerEmployeeIds);
      await this.assertNoConflicts(client, input.applicationId, input.interviewerEmployeeIds, start, end);
      const round = input.roundNo ?? Number((await client.query(`SELECT COALESCE(MAX(round_no), 0) + 1 AS n FROM interviews WHERE application_id = $1`, [input.applicationId])).rows[0].n);
      const created = await client.query(
        `INSERT INTO interviews (company_id, application_id, round_no, interview_type, scheduled_start, scheduled_end, location_text, meeting_link, notes, organizer_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [companyId, input.applicationId, round, input.interviewType ?? "onsite", start, end, input.locationText ?? null, input.meetingLink ?? null, input.notes ?? null, claims.sub]
      );
      const id = created.rows[0].id as string;
      for (const employeeId of input.interviewerEmployeeIds) {
        await client.query(`INSERT INTO interview_interviewers (company_id, interview_id, employee_id) VALUES ($1, $2, $3)`, [companyId, id, employeeId]);
      }
      const stage: ApplicationStage = app.rows[0].stage;
      if (stage === "applied" || stage === "screening") {
        await client.query(`UPDATE applications SET stage = 'interview', updated_at = now() WHERE id = $1`, [input.applicationId]);
        await recordStageChange(client, companyId, input.applicationId, stage, "interview", "Interview scheduled", claims.sub ?? null);
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "interview.schedule",
        target: id,
        metadata: { applicationId: input.applicationId, roundNo: round, interviewers: input.interviewerEmployeeIds.length },
      });
      return (await this.loadInterviews(client, `i.id = $1`, [id]))[0];
    });
  }

  async updateInterview(claims: RequestClaims, id: string, input: UpdateInterviewRequest): Promise<InterviewView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const cur = await client.query(`SELECT * FROM interviews WHERE id = $1 FOR UPDATE`, [id]);
      if (cur.rowCount === 0) throw new NotFoundException("Interview not found");
      const row = cur.rows[0];
      if (row.status !== "scheduled" && (input.scheduledStart || input.scheduledEnd || input.interviewerEmployeeIds)) {
        throw new BadRequestException(`Interview is ${row.status}; only a scheduled interview can be rescheduled`);
      }
      const nextStatus = input.status ?? row.status;
      if (input.status && input.status !== row.status && row.status !== "scheduled") {
        throw new BadRequestException(`Interview is already ${row.status}`);
      }
      if (nextStatus === "cancelled" && !input.cancelReason?.trim() && !row.cancel_reason) {
        throw new BadRequestException("A cancellation reason is required");
      }
      const start = input.scheduledStart ? new Date(input.scheduledStart) : new Date(row.scheduled_start);
      const end = input.scheduledEnd ? new Date(input.scheduledEnd) : new Date(row.scheduled_end);
      if (end <= start) throw new BadRequestException("The interview must end after it starts");
      let interviewerIds: string[];
      if (input.interviewerEmployeeIds) {
        interviewerIds = input.interviewerEmployeeIds;
        await this.assertInterviewers(client, interviewerIds);
      } else {
        interviewerIds = (await client.query(`SELECT employee_id FROM interview_interviewers WHERE interview_id = $1`, [id])).rows.map((r) => r.employee_id);
      }
      if (nextStatus === "scheduled" && (input.scheduledStart || input.scheduledEnd || input.interviewerEmployeeIds)) {
        await this.assertNoConflicts(client, row.application_id, interviewerIds, start, end, id);
      }
      await client.query(
        `UPDATE interviews SET scheduled_start = $2, scheduled_end = $3, interview_type = $4, location_text = $5, meeting_link = $6,
                status = $7, cancel_reason = $8, notes = $9, updated_at = now() WHERE id = $1`,
        [
          id, start, end, input.interviewType ?? row.interview_type,
          input.locationText !== undefined ? input.locationText || null : row.location_text,
          input.meetingLink !== undefined ? input.meetingLink || null : row.meeting_link,
          nextStatus, nextStatus === "cancelled" ? input.cancelReason?.trim() || row.cancel_reason : row.cancel_reason,
          input.notes !== undefined ? input.notes || null : row.notes,
        ]
      );
      if (input.interviewerEmployeeIds) {
        await client.query(`DELETE FROM interview_interviewers WHERE interview_id = $1`, [id]);
        for (const employeeId of interviewerIds) {
          await client.query(`INSERT INTO interview_interviewers (company_id, interview_id, employee_id) VALUES ($1, $2, $3)`, [companyId, id, employeeId]);
        }
      }
      await this.audit.record(client, claims, {
        companyId,
        action: nextStatus !== row.status ? `interview.${nextStatus}` : "interview.update",
        target: id,
        reason: input.cancelReason ?? null,
      });
      return (await this.loadInterviews(client, `i.id = $1`, [id]))[0];
    });
  }

  async listInterviews(claims: RequestClaims, applicationId?: string): Promise<InterviewView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.loadInterviews(client, `($1::uuid IS NULL OR i.application_id = $1)`, [applicationId ?? null]));
  }

  /** Interviews the caller is assigned to as an interviewer - with only their own feedback. */
  async listMyInterviews(claims: RequestClaims): Promise<InterviewView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const me = await this.currentEmployeeId(client, claims);
      if (!me) return [];
      return this.loadInterviews(client, `i.id IN (SELECT interview_id FROM interview_interviewers WHERE employee_id = $1)`, [me], me);
    });
  }

  private async currentEmployeeId(client: PoolClient, claims: RequestClaims): Promise<string | null> {
    const r = await client.query(`SELECT id FROM employees WHERE user_account_id = $1 LIMIT 1`, [claims.sub]);
    return r.rows[0]?.id ?? null;
  }

  async submitFeedback(claims: RequestClaims, interviewId: string, input: SubmitInterviewFeedbackRequest): Promise<InterviewFeedbackView> {
    await this.requireModule(claims);
    const isManager = await this.rbac.can(claims, MANAGE_PERMISSION);
    if (!Number.isInteger(input.overallRating) || input.overallRating < 1 || input.overallRating > 5) throw new BadRequestException("Overall rating must be a whole number from 1 to 5");
    for (const s of input.scorecard ?? []) {
      if (!s.criterion?.trim() || !Number.isInteger(s.rating) || s.rating < 1 || s.rating > 5) throw new BadRequestException("Each scorecard line needs a criterion and a rating from 1 to 5");
    }
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const interview = await client.query(`SELECT * FROM interviews WHERE id = $1 FOR UPDATE`, [interviewId]);
      if (interview.rowCount === 0) throw new NotFoundException("Interview not found");
      if (interview.rows[0].status === "cancelled") throw new BadRequestException("This interview was cancelled");
      const me = await this.currentEmployeeId(client, claims);
      let employeeId = me;
      if (input.employeeId && input.employeeId !== me) {
        if (!isManager) throw new ForbiddenException("Only HR can record feedback on behalf of another interviewer");
        employeeId = input.employeeId;
      }
      if (!employeeId) throw new ForbiddenException("Your login is not linked to an employee record, so you cannot be an interviewer");
      const assigned = await client.query(`SELECT 1 FROM interview_interviewers WHERE interview_id = $1 AND employee_id = $2`, [interviewId, employeeId]);
      if (assigned.rowCount === 0) throw new ForbiddenException("Only an interviewer assigned to this interview can submit feedback");
      const dup = await client.query(`SELECT 1 FROM interview_feedback WHERE interview_id = $1 AND employee_id = $2`, [interviewId, employeeId]);
      if ((dup.rowCount ?? 0) > 0) throw new ConflictException("Feedback was already submitted for this interviewer");
      const r = await client.query(
        `INSERT INTO interview_feedback (company_id, interview_id, employee_id, overall_rating, recommendation, strengths, concerns, scorecard)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
        [companyId, interviewId, employeeId, input.overallRating, input.recommendation, input.strengths ?? null, input.concerns ?? null, JSON.stringify(input.scorecard ?? [])]
      );
      // All interviewers in? Then the interview is complete.
      const pending = await client.query(
        `SELECT 1 FROM interview_interviewers ii WHERE ii.interview_id = $1
            AND NOT EXISTS (SELECT 1 FROM interview_feedback f WHERE f.interview_id = ii.interview_id AND f.employee_id = ii.employee_id)`,
        [interviewId]
      );
      if (pending.rowCount === 0 && interview.rows[0].status === "scheduled") {
        await client.query(`UPDATE interviews SET status = 'completed', updated_at = now() WHERE id = $1`, [interviewId]);
      }
      await this.audit.record(client, claims, { companyId, action: "interview.feedback", target: interviewId, metadata: { employeeId, recommendation: input.recommendation } });
      return rowToFeedback(r.rows[0]);
    });
  }

  // --- pre-employment checks -----------------------------------------------------

  async createCheck(claims: RequestClaims, input: CreatePreEmploymentCheckRequest): Promise<PreEmploymentCheckView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const app = await client.query(`SELECT stage FROM applications WHERE id = $1`, [input.applicationId]);
      if (app.rowCount === 0) throw new NotFoundException("Application not found");
      if (["hired", "rejected"].includes(app.rows[0].stage)) throw new BadRequestException(`Application is already ${app.rows[0].stage}`);
      const r = await client.query(
        `INSERT INTO pre_employment_checks (company_id, application_id, check_type, label, is_required) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [companyId, input.applicationId, input.checkType, input.label ?? null, input.isRequired ?? true]
      );
      await this.audit.record(client, claims, { companyId, action: "pre_employment_check.create", target: r.rows[0].id, metadata: { checkType: input.checkType } });
      return rowToCheck(r.rows[0]);
    });
  }

  async updateCheck(claims: RequestClaims, id: string, input: UpdatePreEmploymentCheckRequest): Promise<PreEmploymentCheckView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query(`SELECT * FROM pre_employment_checks WHERE id = $1 FOR UPDATE`, [id]);
      if (cur.rowCount === 0) throw new NotFoundException("Check not found");
      const status = input.status ?? cur.rows[0].status;
      if (["failed", "waived"].includes(status) && status !== cur.rows[0].status && !input.resultNote?.trim()) {
        throw new BadRequestException(`A note is required to mark a check ${status}`);
      }
      const r = await client.query(
        `UPDATE pre_employment_checks SET status = $2, result_note = $3, is_required = $4, performed_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status, input.resultNote !== undefined ? input.resultNote || null : cur.rows[0].result_note, input.isRequired ?? cur.rows[0].is_required, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "pre_employment_check.update",
        target: id,
        metadata: { from: cur.rows[0].status, to: status },
        reason: input.resultNote ?? null,
      });
      return rowToCheck(r.rows[0]);
    });
  }

  async listChecks(claims: RequestClaims, applicationId: string): Promise<PreEmploymentCheckView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`SELECT * FROM pre_employment_checks WHERE application_id = $1 ORDER BY created_at`, [applicationId]);
      return r.rows.map(rowToCheck);
    });
  }

  // --- timelines --------------------------------------------------------------------

  async getApplicationTimeline(claims: RequestClaims, applicationId: string): Promise<ApplicationTimelineView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const app = await client.query(`SELECT * FROM applications WHERE id = $1`, [applicationId]);
      if (app.rowCount === 0) throw new NotFoundException("Application not found");
      const history = await client.query(`SELECT * FROM application_stage_history WHERE application_id = $1 ORDER BY changed_at, id`, [applicationId]);
      const offers = await client.query(`SELECT id FROM offers WHERE application_id = $1 ORDER BY created_at`, [applicationId]);
      const checks = await client.query(`SELECT * FROM pre_employment_checks WHERE application_id = $1 ORDER BY created_at`, [applicationId]);
      return {
        application: rowToApplication(app.rows[0]),
        stageHistory: history.rows.map(
          (h): ApplicationStageHistoryView => ({
            id: h.id,
            applicationId: h.application_id,
            fromStage: h.from_stage,
            toStage: h.to_stage,
            reason: h.reason ?? null,
            changedBy: h.changed_by ?? null,
            changedAt: toIso(h.changed_at) as string,
          })
        ),
        interviews: await this.loadInterviews(client, `i.application_id = $1`, [applicationId]),
        checks: checks.rows.map(rowToCheck),
        offers: await Promise.all(offers.rows.map((o) => loadOfferView(client, o.id))),
      };
    });
  }

  async getCandidateTimeline(claims: RequestClaims, candidateId: string): Promise<CandidateTimelineEntry[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cand = await client.query(`SELECT created_at FROM candidates WHERE id = $1`, [candidateId]);
      if (cand.rowCount === 0) throw new NotFoundException("Candidate not found");
      const entries: CandidateTimelineEntry[] = [{ at: toIso(cand.rows[0].created_at) as string, kind: "created", summary: "Candidate added", refId: candidateId }];
      const apps = await client.query(`SELECT a.id, a.created_at, r.title FROM applications a JOIN job_requisitions r ON r.id = a.requisition_id WHERE a.candidate_id = $1`, [candidateId]);
      for (const a of apps.rows) entries.push({ at: toIso(a.created_at) as string, kind: "application", summary: `Applied for ${a.title}`, refId: a.id });
      const hist = await client.query(
        `SELECT h.* FROM application_stage_history h JOIN applications a ON a.id = h.application_id WHERE a.candidate_id = $1 AND h.from_stage IS NOT NULL`,
        [candidateId]
      );
      for (const h of hist.rows) entries.push({ at: toIso(h.changed_at) as string, kind: "stage", summary: `${h.from_stage} → ${h.to_stage}${h.reason ? ` (${h.reason})` : ""}`, refId: h.application_id });
      const ivs = await client.query(
        `SELECT i.id, i.round_no, i.status, i.scheduled_start FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.candidate_id = $1`,
        [candidateId]
      );
      for (const i of ivs.rows) entries.push({ at: toIso(i.scheduled_start) as string, kind: "interview", summary: `Interview round ${i.round_no} (${i.status})`, refId: i.id });
      const fb = await client.query(
        `SELECT f.id, f.submitted_at, f.recommendation FROM interview_feedback f JOIN interviews i ON i.id = f.interview_id JOIN applications a ON a.id = i.application_id WHERE a.candidate_id = $1`,
        [candidateId]
      );
      for (const f of fb.rows) entries.push({ at: toIso(f.submitted_at) as string, kind: "feedback", summary: `Interview feedback: ${f.recommendation}`, refId: f.id });
      const offers = await client.query(`SELECT o.id, o.created_at, o.status FROM offers o JOIN applications a ON a.id = o.application_id WHERE a.candidate_id = $1`, [candidateId]);
      for (const o of offers.rows) entries.push({ at: toIso(o.created_at) as string, kind: "offer", summary: `Offer (${o.status})`, refId: o.id });
      const checks = await client.query(`SELECT c.id, c.updated_at, c.check_type, c.status FROM pre_employment_checks c JOIN applications a ON a.id = c.application_id WHERE a.candidate_id = $1`, [candidateId]);
      for (const c of checks.rows) entries.push({ at: toIso(c.updated_at) as string, kind: "check", summary: `${c.check_type} check: ${c.status}`, refId: c.id });
      const docs = await client.query(`SELECT id, created_at, file_name FROM candidate_documents WHERE candidate_id = $1`, [candidateId]);
      for (const d of docs.rows) entries.push({ at: toIso(d.created_at) as string, kind: "document", summary: `Document added: ${d.file_name}`, refId: d.id });
      const evs = await client.query(`SELECT e.id, e.starts_at, e.title FROM recruitment_event_attendees ea JOIN recruitment_events e ON e.id = ea.event_id WHERE ea.candidate_id = $1`, [candidateId]);
      for (const e of evs.rows) entries.push({ at: toIso(e.starts_at) as string, kind: "event", summary: `Event: ${e.title}`, refId: e.id });
      return entries.sort((a, b) => a.at.localeCompare(b.at));
    });
  }

  // --- offer letters --------------------------------------------------------------------

  async generateOfferLetter(claims: RequestClaims, offerId: string, input: GenerateOfferLetterRequest): Promise<OfferLetterView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const offer = await client.query(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [offerId]);
      if (offer.rowCount === 0) throw new NotFoundException("Offer not found");
      const o = offer.rows[0];
      if (!["pending", "accepted"].includes(o.status)) {
        throw new BadRequestException(o.status === "pending_approval" ? "The offer letter can be generated once the offer is approved" : `Cannot generate a letter for an offer that is ${o.status}`);
      }
      const settings = await loadRecruitmentSettings(client, companyId);
      const templateKey = input.templateKey ?? settings.offerLetterTemplateKey ?? null;
      let body = BUILT_IN_OFFER_LETTER;
      let source: "built_in" | "custom" = "built_in";
      if (templateKey) {
        const t = await client.query(`SELECT template_body FROM document_templates WHERE key = $1`, [templateKey]);
        if (t.rowCount === 0) throw new NotFoundException("Offer letter template not found");
        body = t.rows[0].template_body;
        source = "custom";
      }
      const data = await client.query(
        `SELECT c.first_name, c.last_name, r.title, r.department, co.name AS company_name
           FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN job_requisitions r ON r.id = a.requisition_id JOIN companies co ON co.id = a.company_id
          WHERE a.id = $1`,
        [o.application_id]
      );
      const d = data.rows[0];
      const view = await loadOfferView(client, offerId);
      const money = (n: number) => n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
      const componentsBlock = view.components.length > 0 ? ["Package breakdown:", ...view.components.map((c) => `  ${c.componentName}: ${view.currencyCode} ${money(c.amount)}`)].join("\n") : "";
      const content = renderPlaceholders(body, {
        offer_date: new Date().toISOString().slice(0, 10),
        candidate_name: `${d.first_name} ${d.last_name}`,
        company_name: d.company_name,
        position_title: d.title,
        department: d.department ?? "",
        department_clause: d.department ? ` in the ${d.department} department` : "",
        start_date: toIsoDate(o.start_date),
        salary: money(Number(o.salary)),
        currency: view.currencyCode,
        components_block: componentsBlock,
        expires_at: view.expiresAt ? view.expiresAt.slice(0, 10) : "the date communicated to you",
      });
      await client.query(`UPDATE offer_letters SET status = 'superseded' WHERE offer_id = $1 AND status = 'issued'`, [offerId]);
      const versionNo = Number((await client.query(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM offer_letters WHERE offer_id = $1`, [offerId])).rows[0].n);
      const r = await client.query(
        `INSERT INTO offer_letters (company_id, offer_id, version_no, template_key, template_source, content, content_hash, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [companyId, offerId, versionNo, templateKey, source, content, createHash("sha256").update(content).digest("hex"), claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "offer.letter_generate", target: offerId, metadata: { versionNo, templateKey, source } });
      return rowToLetter(r.rows[0]);
    });
  }

  async listOfferLetters(claims: RequestClaims, offerId: string): Promise<OfferLetterView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`SELECT * FROM offer_letters WHERE offer_id = $1 ORDER BY version_no DESC`, [offerId]);
      return r.rows.map(rowToLetter);
    });
  }

  // --- recruitment events ------------------------------------------------------------------

  private async loadEvents(client: PoolClient, where: string, params: unknown[]): Promise<RecruitmentEventView[]> {
    const r = await client.query(
      `SELECT e.*, (SELECT COUNT(*) FROM recruitment_event_attendees a WHERE a.event_id = e.id) AS attendee_count
         FROM recruitment_events e WHERE ${where} ORDER BY e.starts_at`,
      params
    );
    return r.rows.map(rowToEvent);
  }

  async listEvents(claims: RequestClaims): Promise<RecruitmentEventView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.loadEvents(client, "TRUE", []));
  }

  async createEvent(claims: RequestClaims, input: UpsertRecruitmentEventRequest): Promise<RecruitmentEventView> {
    await this.requireManage(claims);
    this.validateEvent(input);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const r = await client.query(
        `INSERT INTO recruitment_events (company_id, title, event_type, starts_at, ends_at, location_id, location_text, requisition_id, capacity, status, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [companyId, input.title.trim(), input.eventType ?? "other", input.startsAt, input.endsAt ?? null, input.locationId ?? null, input.locationText ?? null,
          input.requisitionId ?? null, input.capacity ?? null, input.status ?? "planned", input.notes ?? null, claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "recruitment_event.create", target: r.rows[0].id });
      return (await this.loadEvents(client, "e.id = $1", [r.rows[0].id]))[0];
    });
  }

  async updateEvent(claims: RequestClaims, id: string, input: UpsertRecruitmentEventRequest): Promise<RecruitmentEventView> {
    await this.requireManage(claims);
    this.validateEvent(input);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE recruitment_events SET title = $2, event_type = $3, starts_at = $4, ends_at = $5, location_id = $6, location_text = $7,
                requisition_id = $8, capacity = $9, status = $10, notes = $11, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, input.title.trim(), input.eventType ?? "other", input.startsAt, input.endsAt ?? null, input.locationId ?? null, input.locationText ?? null,
          input.requisitionId ?? null, input.capacity ?? null, input.status ?? "planned", input.notes ?? null]
      );
      if (r.rowCount === 0) throw new NotFoundException("Event not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "recruitment_event.update", target: id });
      return (await this.loadEvents(client, "e.id = $1", [id]))[0];
    });
  }

  private validateEvent(input: UpsertRecruitmentEventRequest): void {
    if (!input.title?.trim()) throw new BadRequestException("An event needs a title");
    if (input.endsAt && new Date(input.endsAt) < new Date(input.startsAt)) throw new BadRequestException("The event cannot end before it starts");
  }

  async addEventAttendee(claims: RequestClaims, eventId: string, candidateId: string): Promise<RecruitmentEventView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const ev = await client.query(`SELECT * FROM recruitment_events WHERE id = $1 FOR UPDATE`, [eventId]);
      if (ev.rowCount === 0) throw new NotFoundException("Event not found");
      if (ev.rows[0].status === "cancelled") throw new BadRequestException("This event was cancelled");
      const cand = await client.query(`SELECT anonymised_at FROM candidates WHERE id = $1`, [candidateId]);
      if (cand.rowCount === 0) throw new NotFoundException("Candidate not found");
      if (cand.rows[0].anonymised_at) throw new BadRequestException("This candidate has been anonymised");
      const count = Number((await client.query(`SELECT COUNT(*) AS n FROM recruitment_event_attendees WHERE event_id = $1`, [eventId])).rows[0].n);
      if (ev.rows[0].capacity && count >= ev.rows[0].capacity) throw new ConflictException("This event is full");
      const ins = await client.query(
        `INSERT INTO recruitment_event_attendees (company_id, event_id, candidate_id) VALUES ($1, $2, $3) ON CONFLICT (event_id, candidate_id) DO NOTHING`,
        [claims.company_id, eventId, candidateId]
      );
      if (ins.rowCount === 0) throw new ConflictException("This candidate is already registered for the event");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "recruitment_event.attendee_add", target: eventId, metadata: { candidateId } });
      return (await this.loadEvents(client, "e.id = $1", [eventId]))[0];
    });
  }

  async markEventAttendance(claims: RequestClaims, eventId: string, candidateId: string, attended: boolean): Promise<{ eventId: string; candidateId: string; attended: boolean }> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`UPDATE recruitment_event_attendees SET attended = $3 WHERE event_id = $1 AND candidate_id = $2`, [eventId, candidateId, attended]);
      if (r.rowCount === 0) throw new NotFoundException("This candidate is not registered for the event");
      return { eventId, candidateId, attended };
    });
  }

  async removeEventAttendee(claims: RequestClaims, eventId: string, candidateId: string): Promise<{ removed: true }> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`DELETE FROM recruitment_event_attendees WHERE event_id = $1 AND candidate_id = $2`, [eventId, candidateId]);
      if (r.rowCount === 0) throw new NotFoundException("This candidate is not registered for the event");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "recruitment_event.attendee_remove", target: eventId, metadata: { candidateId } });
      return { removed: true as const };
    });
  }

  async listEventAttendees(claims: RequestClaims, eventId: string): Promise<Array<{ candidateId: string; fullName: string; attended: boolean }>> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT a.candidate_id, a.attended, c.first_name, c.last_name FROM recruitment_event_attendees a JOIN candidates c ON c.id = a.candidate_id WHERE a.event_id = $1 ORDER BY c.first_name`,
        [eventId]
      );
      return r.rows.map((x) => ({ candidateId: x.candidate_id, fullName: `${x.first_name} ${x.last_name}`, attended: x.attended }));
    });
  }

  async getCalendar(claims: RequestClaims, from: string, to: string): Promise<RecruitmentCalendarEntry[]> {
    await this.requireManage(claims);
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw new BadRequestException("Provide a valid from / to range");
    return this.db.withClaims(claims, async (client) => {
      const iv = await client.query(
        `SELECT i.id, i.scheduled_start, i.scheduled_end, i.status, i.round_no, c.first_name, c.last_name
           FROM interviews i JOIN applications a ON a.id = i.application_id JOIN candidates c ON c.id = a.candidate_id
          WHERE i.scheduled_start < $2 AND i.scheduled_end > $1 AND i.status <> 'cancelled'`,
        [start, end]
      );
      const ev = await client.query(
        `SELECT id, title, starts_at, ends_at, status FROM recruitment_events WHERE starts_at < $2 AND coalesce(ends_at, starts_at) >= $1 AND status <> 'cancelled'`,
        [start, end]
      );
      const entries: RecruitmentCalendarEntry[] = [
        ...iv.rows.map((r): RecruitmentCalendarEntry => ({
          kind: "interview", id: r.id, title: `Round ${r.round_no}: ${r.first_name} ${r.last_name}`,
          start: toIso(r.scheduled_start) as string, end: toIso(r.scheduled_end), status: r.status,
        })),
        ...ev.rows.map((r): RecruitmentCalendarEntry => ({
          kind: "event", id: r.id, title: r.title, start: toIso(r.starts_at) as string, end: toIso(r.ends_at), status: r.status,
        })),
      ];
      return entries.sort((a, b) => a.start.localeCompare(b.start));
    });
  }

  // --- retention and erasure -----------------------------------------------------------------

  /**
   * Replaces a candidate's personal data with a placeholder and removes their documents (TAL-01 retention / erasure).
   * Refused while the candidate has an application still in progress. Hired candidates are skipped: their data lives
   * on in the employee record. Runs inside the caller's transaction; returns the storage paths to delete afterwards.
   */
  private async anonymiseWithin(client: PoolClient, claims: RequestClaims, candidateId: string, reason: string): Promise<string[]> {
    const cand = await client.query(`SELECT id, company_id, anonymised_at FROM candidates WHERE id = $1 FOR UPDATE`, [candidateId]);
    if (cand.rowCount === 0) throw new NotFoundException("Candidate not found");
    if (cand.rows[0].anonymised_at) return [];
    const blocking = await client.query(`SELECT 1 FROM applications WHERE candidate_id = $1 AND stage NOT IN ('rejected', 'hired') LIMIT 1`, [candidateId]);
    if ((blocking.rowCount ?? 0) > 0) throw new BadRequestException("This candidate still has an application in progress. Reject or complete it first.");
    const docs = await client.query(`DELETE FROM candidate_documents WHERE candidate_id = $1 RETURNING storage_path`, [candidateId]);
    await client.query(
      `UPDATE candidates SET first_name = 'Anonymised', last_name = 'Candidate', email = NULL, phone = NULL, national_id = NULL, national_id_bidx = NULL,
              source_detail = NULL, current_employer = NULL, current_designation = NULL, expected_salary = NULL, notice_period_days = NULL,
              consent_purpose = NULL, retention_until = NULL, anonymised_at = now(), updated_at = now()
        WHERE id = $1`,
      [candidateId]
    );
    await client.query(`UPDATE applications SET rejection_reason = NULL, source_detail = NULL WHERE candidate_id = $1`, [candidateId]);
    await client.query(`UPDATE pre_employment_checks SET result_note = NULL WHERE application_id IN (SELECT id FROM applications WHERE candidate_id = $1)`, [candidateId]);
    await this.audit.record(client, claims, {
      companyId: cand.rows[0].company_id,
      action: "candidate.anonymise",
      target: candidateId,
      reason,
      // jobs have no request, so give the audit row its own correlation id
      correlationId: claims.is_service ? randomUUID() : undefined,
    });
    return docs.rows.map((d) => d.storage_path as string);
  }

  async anonymiseCandidate(claims: RequestClaims, candidateId: string, reason: string): Promise<{ anonymised: true }> {
    await this.requireManage(claims);
    if (!reason?.trim()) throw new BadRequestException("A reason is required to anonymise a candidate");
    const paths = await this.db.withClaims(claims, (client) => this.anonymiseWithin(client, claims, candidateId, reason.trim()));
    for (const p of paths) await this.fileStorage.delete(p);
    return { anonymised: true };
  }

  /** Nightly: anonymise candidates whose retention date has passed and who have nothing in progress. Idempotent. */
  async anonymiseExpired(claims: RequestClaims): Promise<number> {
    const due = await this.db.withClaims(claims, async (client) =>
      (
        await client.query(
          `SELECT c.id FROM candidates c
            WHERE c.anonymised_at IS NULL AND c.retention_until IS NOT NULL AND c.retention_until < CURRENT_DATE
              AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id AND a.stage NOT IN ('rejected'))`
        )
      ).rows.map((r) => r.id as string)
    );
    let n = 0;
    for (const id of due) {
      const paths = await this.db.withClaims(claims, (client) => this.anonymiseWithin(client, claims, id, "Retention period ended"));
      for (const p of paths) await this.fileStorage.delete(p);
      n++;
    }
    return n;
  }

  // -----------------------------------------------------------------------------------------------

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage recruitment");
  }
}

