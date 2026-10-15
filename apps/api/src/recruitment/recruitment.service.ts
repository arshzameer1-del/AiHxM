import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { EmployeesService } from "../employees/employees.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { OrgOccupancyService } from "../organization/occupancy/org-occupancy.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { assertValidCnic } from "../crypto/identifier-validation";
import { sensitive } from "../crypto/sensitive-fields";
import { submitToEngineIfConfigured } from "../workflow/engine-routing";
import {
  loadOfferView,
  loadRecruitmentSettings,
  normalisePhone,
  recordStageChange,
  rowToApplication,
  rowToCandidate,
  toIso,
  toIsoDate,
} from "./recruitment.mappers";
import type { PoolClient } from "pg";
import type {
  ApplicationStage,
  ApplicationView,
  CandidateDuplicateMatch,
  CandidateView,
  CreateApplicationRequest,
  CreateCandidateRequest,
  CreateJobRequisitionRequest,
  DecideOfferResponse,
  EmployeeView,
  ExtendOfferRequest,
  JobRequisitionAction,
  JobRequisitionView,
  OfferView,
  UpdateCandidateRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "recruitment" as const;
const MANAGE_PERMISSION = "recruitment.manage.all";
const WORKFLOW_TEMPLATE_KEY = "job_requisition";
const WORKFLOW_OBJECT_KEY = "job_requisition";
const OFFER_WORKFLOW_OBJECT_KEY = "offer";

// The Kanban board's own forward order — see ApplicationStage's own doc
// comment in shared-types for why this is forward-only in this phase.
const FORWARD_STAGES: ApplicationStage[] = ["applied", "screening", "interview", "offer"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRequisition(row: any): JobRequisitionView {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    department: row.department,
    headcount: row.headcount,
    salaryBand: row.salary_band,
    justification: row.justification,
    hiringManagerId: row.hiring_manager_id,
    positionId: row.position_id ?? null,
    orgUnitId: row.org_unit_id ?? null,
    jobId: row.job_id ?? null,
    locationId: row.location_id ?? null,
    filledHeadcount: row.filled_headcount ?? 0,
    statusReason: row.status_reason ?? null,
    status: row.status,
    workflowInstanceId: row.workflow_instance_id,
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * Phase 10 (plan doc Section 7): Requisition → offer → hire, on a real
 * Kanban pipeline. Unlike Phase 9, this phase adds NO new capability to
 * the workflow engine — a plain `role` approver is all requisition
 * approval needs, so `submitRequisition()` calls
 * `WorkflowService.submitForApproval()` exactly the way
 * `LeaveRequestsService.submit()` does, with no engine changes at all.
 * See Decision #10 for the full writeup, including why a candidate has
 * no login/session of their own and what that does to this service's
 * permission model (there is no `.self`/`.team` scope anywhere here —
 * every check is `recruitment.manage.all`, the recruiter's own
 * permission, never the candidate's).
 */
@Injectable()
export class RecruitmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly employees: EmployeesService,
    // ORG-01: optional so positional spec constructions keep working.
    private readonly businessPolicy?: HrBusinessPolicyService,
    private readonly occupancy?: OrgOccupancyService,
    // TAL-03: optional so positional spec constructions keep working.
    private readonly compensation?: EmployeeCompensationService
  ) {
    this.workflow?.adapters?.register({
      objectKey: WORKFLOW_OBJECT_KEY,
      label: "Job requisition",
      legacyDecide: (c, id, dto) => this.decideRequisition(c, id, dto),
    });
    this.registerOfferAdapter();
  }

  // --- Requisitions -------------------------------------------------

  async createRequisition(claims: RequestClaims, input: CreateJobRequisitionRequest): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const links = await this.resolveLinks(client, claims, input, input.headcount ?? 1);
      const result = await client.query(
        `INSERT INTO job_requisitions
           (company_id, title, department, headcount, salary_band, justification, hiring_manager_id, status, created_by_user_account_id,
            position_id, org_unit_id, job_id, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          claims.company_id,
          input.title,
          links.department ?? input.department ?? null,
          input.headcount ?? 1,
          input.salaryBand ?? null,
          input.justification ?? null,
          input.hiringManagerId ?? null,
          claims.sub,
          links.positionId,
          links.orgUnitId,
          links.jobId,
          links.locationId,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "job_requisition.create",
        target: result.rows[0].id,
        metadata: { positionId: links.positionId, orgUnitId: links.orgUnitId },
      });
      return rowToRequisition(result.rows[0]);
    });
  }

  /** Draft-only edit (ORG-01): re-validates the position / org dimensions. */
  async updateRequisition(
    claims: RequestClaims,
    id: string,
    patch: Omit<Partial<CreateJobRequisitionRequest>, "positionId" | "orgUnitId" | "jobId" | "locationId"> & {
      positionId?: string | null;
      orgUnitId?: string | null;
      jobId?: string | null;
      locationId?: string | null;
    }
  ): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query(`SELECT * FROM job_requisitions WHERE id = $1 FOR UPDATE`, [id]);
      if (cur.rowCount === 0) throw new NotFoundException("Requisition not found");
      const before = cur.rows[0];
      if (before.status !== "draft") {
        throw new BadRequestException(`Requisition is ${before.status}; only a draft can be edited`);
      }
      const merged = {
        title: patch.title ?? before.title,
        department: patch.department ?? before.department,
        headcount: patch.headcount ?? before.headcount,
        positionId: patch.positionId === undefined ? before.position_id : patch.positionId,
        orgUnitId: patch.orgUnitId === undefined ? before.org_unit_id : patch.orgUnitId,
        jobId: patch.jobId === undefined ? before.job_id : patch.jobId,
        locationId: patch.locationId === undefined ? before.location_id : patch.locationId,
      };
      const links = await this.resolveLinks(client, claims, merged, merged.headcount, id);
      const updated = await client.query(
        `UPDATE job_requisitions
            SET title = $2, department = $3, headcount = $4, salary_band = $5, justification = $6, hiring_manager_id = $7,
                position_id = $8, org_unit_id = $9, job_id = $10, location_id = $11, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          id,
          merged.title,
          links.department ?? merged.department ?? null,
          merged.headcount,
          patch.salaryBand ?? before.salary_band,
          patch.justification ?? before.justification,
          patch.hiringManagerId ?? before.hiring_manager_id,
          links.positionId,
          links.orgUnitId,
          links.jobId,
          links.locationId,
        ]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "job_requisition.update", target: id });
      return rowToRequisition(updated.rows[0]);
    });
  }

  /**
   * ORG-01. Validates and normalises the org links of a requisition:
   *  - policy `hiring.requirePositionForRequisition` makes positionId mandatory;
   *  - a position must be `vacant` (open capacity) with enough FTE left after
   *    current incumbents and other live requisitions on the same seat;
   *  - orgUnitId / jobId default from the position and must agree with it;
   *  - `department` text is derived from the org unit name so it can't drift.
   */
  private async resolveLinks(
    client: PoolClient,
    claims: RequestClaims,
    input: { positionId?: string | null; orgUnitId?: string | null; jobId?: string | null; locationId?: string | null },
    headcount: number,
    excludeRequisitionId?: string
  ): Promise<{ positionId: string | null; orgUnitId: string | null; jobId: string | null; locationId: string | null; department: string | null }> {
    const companyId = claims.company_id!;
    const positionId = input.positionId ?? null;
    let orgUnitId = input.orgUnitId ?? null;
    let jobId = input.jobId ?? null;

    if (!positionId && this.businessPolicy) {
      const rules = await this.businessPolicy.resolveEffectivePolicy(client, companyId, "hiring", { orgUnitId });
      if (rules?.requirePositionForRequisition === true) {
        throw new BadRequestException("Your hiring policy requires every requisition to be raised against an approved position");
      }
    }

    if (positionId) {
      const pos = await client.query<{ org_unit_id: string; job_id: string | null; status: string; headcount_fte: string }>(
        "SELECT org_unit_id, job_id, status, headcount_fte FROM positions WHERE id = $1 AND company_id = $2",
        [positionId, companyId]
      );
      if (pos.rowCount === 0) throw new NotFoundException("Position not found");
      const p = pos.rows[0];
      if (p.status !== "vacant") {
        throw new BadRequestException(`Position is ${p.status}; a requisition needs an approved position with open capacity`);
      }
      if (orgUnitId && orgUnitId !== p.org_unit_id) {
        throw new BadRequestException("The selected org unit does not match the position's org unit");
      }
      if (jobId && p.job_id && jobId !== p.job_id) {
        throw new BadRequestException("The selected job does not match the position's job");
      }
      orgUnitId = p.org_unit_id;
      jobId = jobId ?? p.job_id;
      const usage = await client.query<{ used: string; reserved: string }>(
        `SELECT GREATEST(
                  COALESCE((SELECT SUM(fte) FROM position_incumbents WHERE position_id = $1 AND status = 'active'), 0),
                  (SELECT count(*) FROM employees WHERE position_id = $1 AND company_id = $2)) AS used,
                COALESCE((SELECT SUM(headcount - filled_headcount) FROM job_requisitions
                           WHERE position_id = $1 AND status IN ('draft','pending_approval','approved','open','on_hold')
                             AND ($3::uuid IS NULL OR id <> $3)), 0) AS reserved`,
        [positionId, companyId, excludeRequisitionId ?? null]
      );
      const free = Number(p.headcount_fte) - Number(usage.rows[0].used) - Number(usage.rows[0].reserved);
      if (headcount > free + 0.005) {
        throw new ConflictException(`Position has only ${Math.max(0, Math.round(free * 100) / 100)} FTE of unreserved capacity; requested ${headcount}`);
      }
    }

    let department: string | null = null;
    if (orgUnitId) {
      const unit = await client.query<{ name: string; status: string }>("SELECT name, status FROM org_units WHERE id = $1 AND company_id = $2", [
        orgUnitId,
        companyId,
      ]);
      if (unit.rowCount === 0) throw new NotFoundException("Org unit not found");
      if (unit.rows[0].status === "archived") throw new BadRequestException("Org unit is archived");
      department = unit.rows[0].name;
    }
    if (jobId) {
      const job = await client.query("SELECT 1 FROM jobs WHERE id = $1 AND company_id = $2", [jobId, companyId]);
      if (job.rowCount === 0) throw new NotFoundException("Job not found");
    }
    if (input.locationId) {
      const loc = await client.query("SELECT 1 FROM locations WHERE id = $1 AND company_id = $2", [input.locationId, companyId]);
      if (loc.rowCount === 0) throw new NotFoundException("Location not found");
    }
    return { positionId, orgUnitId, jobId, locationId: input.locationId ?? null, department };
  }

  /**
   * ORG-01 status actions on an approved requisition:
   *   open (approved -> open) | hold (open -> on_hold) | resume (on_hold -> open)
   *   fill (approved/open/on_hold -> filled) | cancel (any live status -> cancelled).
   */
  async applyRequisitionAction(claims: RequestClaims, id: string, action: JobRequisitionAction, reason?: string): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query(`SELECT * FROM job_requisitions WHERE id = $1 FOR UPDATE`, [id]);
      if (cur.rowCount === 0) throw new NotFoundException("Requisition not found");
      const status: string = cur.rows[0].status;
      const rules: Record<JobRequisitionAction, { from: string[]; to: string }> = {
        open: { from: ["approved"], to: "open" },
        hold: { from: ["open", "approved"], to: "on_hold" },
        resume: { from: ["on_hold"], to: "open" },
        fill: { from: ["approved", "open", "on_hold"], to: "filled" },
        cancel: { from: ["draft", "pending_approval", "approved", "open", "on_hold"], to: "cancelled" },
      };
      const rule = rules[action];
      if (!rule) throw new BadRequestException("Unknown requisition action");
      if (!rule.from.includes(status)) {
        throw new BadRequestException(`Cannot ${action} a requisition that is ${status}`);
      }
      if ((action === "hold" || action === "cancel") && !reason?.trim()) {
        throw new BadRequestException(`A reason is required to ${action} a requisition`);
      }
      const updated = await client.query(
        `UPDATE job_requisitions SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, rule.to, reason ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: `job_requisition.${action}`,
        target: id,
        reason,
        metadata: { from: status, to: rule.to },
      });
      return rowToRequisition(updated.rows[0]);
    });
  }

  async listRequisitions(claims: RequestClaims): Promise<JobRequisitionView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM job_requisitions ORDER BY created_at DESC`);
      return result.rows.map(rowToRequisition);
    });
  }

  async getRequisition(claims: RequestClaims, id: string): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM job_requisitions WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Requisition not found");
      return rowToRequisition(result.rows[0]);
    });
  }

  /**
   * Routes the requisition through the tenant's configured approval
   * chain — same pattern as `LeaveRequestsService.submit()`: a separate
   * `WorkflowService` transaction (see KNOWN_ISSUES.md for the same
   * cross-service non-atomicity tradeoff Decision #9 already documents),
   * `NotFoundException` surfacing as-is if the tenant hasn't configured a
   * `job_requisition` template yet, deliberately not auto-approved.
   */
  async submitRequisition(claims: RequestClaims, id: string): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    const requisition = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM job_requisitions WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Requisition not found");
      return result.rows[0];
    });
    if (requisition.status !== "draft") {
      throw new BadRequestException(`Requisition is already ${requisition.status}, cannot resubmit`);
    }
    // ORG-01: the seat may have been filled / frozen since the draft was saved.
    await this.db.withClaims(claims, (client) =>
      this.resolveLinks(
        client,
        claims,
        { positionId: requisition.position_id, orgUnitId: requisition.org_unit_id, jobId: requisition.job_id, locationId: requisition.location_id },
        requisition.headcount,
        id
      )
    );

    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: id,
      record: {
        department: requisition.department,
        headcount: requisition.headcount,
        salaryBand: requisition.salary_band,
        positionId: requisition.position_id,
        orgUnitId: requisition.org_unit_id,
      },
    });

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE job_requisitions SET status = 'pending_approval', workflow_instance_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, instance.id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "job_requisition.submit",
        target: id,
      });
      return rowToRequisition(result.rows[0]);
    });
  }

  /**
   * Same shape as `LeaveRequestsService.decide()`: who may actually
   * decide is entirely governed by the workflow's own configured
   * routing, not a separate recruitment-specific permission.
   */
  async decideRequisition(
    claims: RequestClaims,
    id: string,
    dto: { decision: "approved" | "rejected"; comment?: string }
  ): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    const requisition = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM job_requisitions WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Requisition not found");
      return result.rows[0];
    });
    if (requisition.status !== "pending_approval") {
      throw new BadRequestException(`Requisition is ${requisition.status}, not awaiting approval`);
    }
    if (!requisition.workflow_instance_id) {
      throw new BadRequestException("Requisition has no workflow instance to decide on");
    }

    const instance = await this.workflow.getInstance(claims, requisition.workflow_instance_id);
    const pendingStep = instance.steps.find((s) => s.status === "pending");
    if (!pendingStep) throw new BadRequestException("No pending approval step found on this requisition");
    const decidedInstance = await this.workflow.decide(claims, pendingStep.id, dto);

    return this.db.withClaims(claims, async (client) => {
      let newStatus = requisition.status;
      if (decidedInstance.status === "approved") newStatus = "approved";
      else if (decidedInstance.status === "rejected") newStatus = "rejected";
      const result = await client.query(
        `UPDATE job_requisitions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, newStatus]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "job_requisition.decide",
        target: id,
        metadata: { decision: dto.decision },
      });
      return rowToRequisition(result.rows[0]);
    });
  }


  // --- Candidates -----------------------------------------------------

  /**
   * TAL-01: likely duplicates by national id (blind index), e-mail (case-insensitive) and phone (last ten digits).
   * Anonymised candidates never match.
   */
  async checkCandidateDuplicates(
    claims: RequestClaims,
    input: { nationalId?: string; email?: string; phone?: string },
    excludeCandidateId?: string
  ): Promise<CandidateDuplicateMatch[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.findDuplicates(client, claims.company_id as string, input, excludeCandidateId));
  }

  private async findDuplicates(
    client: PoolClient,
    companyId: string,
    input: { nationalId?: string | null; email?: string | null; phone?: string | null },
    excludeCandidateId?: string
  ): Promise<CandidateDuplicateMatch[]> {
    const bidx = input.nationalId ? sensitive.cnicIndex(companyId, input.nationalId) : null;
    const email = input.email ? input.email.trim().toLowerCase() : null;
    const phone = normalisePhone(input.phone);
    if (!bidx && !email && !phone) return [];
    const rows = await client.query(
      `SELECT id, first_name, last_name, national_id_bidx, lower(email) AS email_l,
              right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) AS phone_l
         FROM candidates
        WHERE anonymised_at IS NULL
          AND ($4::uuid IS NULL OR id <> $4)
          AND (($1::text IS NOT NULL AND national_id_bidx = $1)
            OR ($2::text IS NOT NULL AND lower(email) = $2)
            OR ($3::text IS NOT NULL AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $3))
        ORDER BY created_at DESC LIMIT 10`,
      [bidx, email, phone, excludeCandidateId ?? null]
    );
    return rows.rows.map((r) => {
      const matchedOn: CandidateDuplicateMatch["matchedOn"] = [];
      if (bidx && r.national_id_bidx === bidx) matchedOn.push("national_id");
      if (email && r.email_l === email) matchedOn.push("email");
      if (phone && r.phone_l === phone) matchedOn.push("phone");
      return { candidateId: r.id, fullName: `${r.first_name} ${r.last_name}`, matchedOn };
    });
  }

  async createCandidate(claims: RequestClaims, input: CreateCandidateRequest): Promise<CandidateView> {
    await this.requireManage(claims);
    assertValidCnic(input.nationalId, "nationalId");
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const settings = await loadRecruitmentSettings(client, companyId);
      if (settings.consentRequired && !input.consentGiven) {
        throw new BadRequestException("This company requires the candidate's consent to hold their data. Record consent (consentGiven) to continue.");
      }
      if (!input.allowDuplicate) {
        const matches = await this.findDuplicates(client, companyId, input);
        if (matches.length > 0) {
          throw new ConflictException({ message: "A candidate with the same national id, e-mail or phone already exists.", matches });
        }
      }
      const result = await client.query(
        `INSERT INTO candidates
           (company_id, first_name, last_name, email, phone, national_id, national_id_bidx, source, source_detail,
            current_employer, current_designation, expected_salary, notice_period_days, consent_given_at, consent_purpose, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 CASE WHEN $16::int IS NULL THEN NULL ELSE (CURRENT_DATE + make_interval(months => $16::int))::date END)
         RETURNING *`,
        [
          companyId, input.firstName, input.lastName, input.email ?? null, input.phone ?? null,
          sensitive.encrypt(companyId, input.nationalId ?? null), sensitive.cnicIndex(companyId, input.nationalId ?? null),
          input.source ?? null, input.sourceDetail ?? null, input.currentEmployer ?? null, input.currentDesignation ?? null,
          input.expectedSalary ?? null, input.noticePeriodDays ?? null,
          input.consentGiven ? new Date() : null, input.consentPurpose ?? null, settings.candidateRetentionMonths,
        ]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "candidate.create",
        target: result.rows[0].id,
        metadata: { source: input.source ?? null, consentGiven: Boolean(input.consentGiven), allowDuplicate: Boolean(input.allowDuplicate) },
      });
      return rowToCandidate(result.rows[0]);
    });
  }

  async updateCandidate(claims: RequestClaims, id: string, input: UpdateCandidateRequest): Promise<CandidateView> {
    await this.requireManage(claims);
    assertValidCnic(input.nationalId, "nationalId");
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const current = await client.query(`SELECT * FROM candidates WHERE id = $1 FOR UPDATE`, [id]);
      if (current.rowCount === 0) throw new NotFoundException("Candidate not found");
      if (current.rows[0].anonymised_at) throw new BadRequestException("This candidate has been anonymised and can no longer be edited");
      const row = current.rows[0];
      const next = {
        first_name: input.firstName ?? row.first_name,
        last_name: input.lastName ?? row.last_name,
        email: input.email !== undefined ? input.email || null : row.email,
        phone: input.phone !== undefined ? input.phone || null : row.phone,
        source: input.source !== undefined ? input.source : row.source,
        source_detail: input.sourceDetail !== undefined ? input.sourceDetail || null : row.source_detail,
        current_employer: input.currentEmployer !== undefined ? input.currentEmployer || null : row.current_employer,
        current_designation: input.currentDesignation !== undefined ? input.currentDesignation || null : row.current_designation,
        expected_salary: input.expectedSalary !== undefined ? input.expectedSalary : row.expected_salary,
        notice_period_days: input.noticePeriodDays !== undefined ? input.noticePeriodDays : row.notice_period_days,
      };
      let nationalId = row.national_id as string | null;
      let bidx = row.national_id_bidx as string | null;
      if (input.nationalId !== undefined) {
        nationalId = sensitive.encrypt(companyId, input.nationalId || null);
        bidx = sensitive.cnicIndex(companyId, input.nationalId || null);
      }
      let consentGivenAt = row.consent_given_at;
      let consentPurpose = input.consentPurpose !== undefined ? input.consentPurpose || null : row.consent_purpose;
      if (input.consentGiven === true && !consentGivenAt) consentGivenAt = new Date();
      if (input.consentGiven === false) {
        consentGivenAt = null;
        consentPurpose = null;
      }
      const duplicates = await this.findDuplicates(client, companyId, { nationalId: input.nationalId, email: next.email, phone: next.phone }, id);
      if (duplicates.length > 0 && (input.email !== undefined || input.phone !== undefined || input.nationalId !== undefined)) {
        throw new ConflictException({ message: "Another candidate already has this national id, e-mail or phone.", matches: duplicates });
      }
      const updated = await client.query(
        `UPDATE candidates SET first_name = $2, last_name = $3, email = $4, phone = $5, source = $6, source_detail = $7,
                current_employer = $8, current_designation = $9, expected_salary = $10, notice_period_days = $11,
                national_id = $12, national_id_bidx = $13, consent_given_at = $14, consent_purpose = $15, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          id, next.first_name, next.last_name, next.email, next.phone, next.source, next.source_detail, next.current_employer,
          next.current_designation, next.expected_salary, next.notice_period_days, nationalId, bidx, consentGivenAt, consentPurpose,
        ]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "candidate.update",
        target: id,
        metadata: { fields: Object.keys(input).filter((k) => k !== "nationalId") },
      });
      return rowToCandidate(updated.rows[0]);
    });
  }

  async getCandidate(claims: RequestClaims, id: string): Promise<CandidateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT c.*, (SELECT COUNT(*) FROM candidate_documents d WHERE d.candidate_id = c.id) AS document_count FROM candidates c WHERE c.id = $1`,
        [id]
      );
      if (r.rowCount === 0) throw new NotFoundException("Candidate not found");
      return rowToCandidate(r.rows[0]);
    });
  }

  async listCandidates(claims: RequestClaims): Promise<CandidateView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT c.*, (SELECT COUNT(*) FROM candidate_documents d WHERE d.candidate_id = c.id) AS document_count
           FROM candidates c ORDER BY c.created_at DESC`
      );
      return result.rows.map(rowToCandidate);
    });
  }

  // --- Applications (the Kanban board) --------------------------------

  async createApplication(claims: RequestClaims, input: CreateApplicationRequest): Promise<ApplicationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const requisition = await client.query(`SELECT status FROM job_requisitions WHERE id = $1`, [input.requisitionId]);
      if (requisition.rowCount === 0) throw new NotFoundException("Requisition not found");
      if (!["approved", "open"].includes(requisition.rows[0].status)) {
        throw new BadRequestException("Candidates can only be added to an APPROVED requisition");
      }
      const candidate = await client.query(`SELECT id, anonymised_at, source FROM candidates WHERE id = $1`, [input.candidateId]);
      if (candidate.rowCount === 0) throw new NotFoundException("Candidate not found");
      if (candidate.rows[0].anonymised_at) throw new BadRequestException("An anonymised candidate cannot be added to a requisition");

      const existing = await client.query(
        `SELECT 1 FROM applications WHERE requisition_id = $1 AND candidate_id = $2`,
        [input.requisitionId, input.candidateId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This candidate has already applied to this requisition");
      }

      const result = await client.query(
        `INSERT INTO applications (company_id, requisition_id, candidate_id, stage, source, source_detail)
         VALUES ($1, $2, $3, 'applied', $4, $5) RETURNING *`,
        [companyId, input.requisitionId, input.candidateId, input.source ?? candidate.rows[0].source ?? null, input.sourceDetail ?? null]
      );
      await recordStageChange(client, companyId, result.rows[0].id, null, "applied", null, claims.sub ?? null);
      // A new application is a fresh reason to hold the candidate's data: push the retention date out.
      const settings = await loadRecruitmentSettings(client, companyId);
      if (settings.candidateRetentionMonths) {
        await client.query(
          `UPDATE candidates SET retention_until = GREATEST(coalesce(retention_until, CURRENT_DATE), (CURRENT_DATE + make_interval(months => $2::int))::date), updated_at = now() WHERE id = $1`,
          [input.candidateId, settings.candidateRetentionMonths]
        );
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "application.create",
        target: result.rows[0].id,
      });
      return rowToApplication(result.rows[0]);
    });
  }

  async listApplications(claims: RequestClaims, requisitionId?: string): Promise<ApplicationView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM applications WHERE ($1::uuid IS NULL OR requisition_id = $1) ORDER BY created_at ASC`,
        [requisitionId ?? null]
      );
      return result.rows.map(rowToApplication);
    });
  }

  /**
   * Forward-only: a move to any later stage in `FORWARD_STAGES`' order is allowed, a move to `rejected` is allowed from
   * anywhere non-terminal and needs a reason (TAL-02), and `hired` is refused here outright - it is set only by
   * `decideOffer()` accepting an offer. Every change writes an immutable stage-history row. Rejecting cancels the
   * application's scheduled interviews and withdraws its open offers.
   */
  async moveApplicationStage(claims: RequestClaims, id: string, newStage: ApplicationStage, reason?: string): Promise<ApplicationView> {
    await this.requireManage(claims);
    if (newStage === "hired") {
      throw new BadRequestException("An application moves to 'hired' automatically when an offer is accepted, not by a direct stage move");
    }
    const trimmedReason = reason?.trim() || null;
    if (newStage === "rejected" && !trimmedReason) {
      throw new BadRequestException("A rejection reason is required.");
    }
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const result = await client.query(`SELECT * FROM applications WHERE id = $1 FOR UPDATE`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Application not found");
      const current: ApplicationStage = result.rows[0].stage;
      if (current === "hired" || current === "rejected") {
        throw new BadRequestException(`Application is already ${current}, no further stage moves are possible`);
      }
      if (newStage !== "rejected") {
        const currentIndex = FORWARD_STAGES.indexOf(current);
        const newIndex = FORWARD_STAGES.indexOf(newStage);
        if (newIndex <= currentIndex) {
          throw new BadRequestException(`Cannot move from '${current}' to '${newStage}' — stage moves are forward-only`);
        }
      }
      const updated = await client.query(
        `UPDATE applications SET stage = $2, updated_at = now(),
                rejection_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE rejection_reason END,
                rejected_at = CASE WHEN $2 = 'rejected' THEN now() ELSE rejected_at END
          WHERE id = $1 RETURNING *`,
        [id, newStage, trimmedReason]
      );
      await recordStageChange(client, companyId, id, current, newStage, trimmedReason, claims.sub ?? null);
      if (newStage === "rejected") {
        await client.query(
          `UPDATE interviews SET status = 'cancelled', cancel_reason = 'Application rejected', updated_at = now()
            WHERE application_id = $1 AND status = 'scheduled'`,
          [id]
        );
        const open = await client.query(
          `SELECT id FROM offers WHERE application_id = $1 AND status IN ('pending', 'pending_approval', 'approval_rejected')`,
          [id]
        );
        for (const o of open.rows) await this.closeOpenOffer(client, claims, o.id, "rescinded", "Application rejected");
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "application.move_stage",
        target: id,
        metadata: { from: current, to: newStage },
        reason: trimmedReason,
      });
      return rowToApplication(updated.rows[0]);
    });
  }

  // --- Offers -----------------------------------------------------------

  /** TAL-03: the offer's approval record in the workflow engine (My Inbox) - registered once at construction. */
  private registerOfferAdapter(): void {
    this.workflow?.adapters?.register({
      objectKey: OFFER_WORKFLOW_OBJECT_KEY,
      label: "Offer",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT o.salary, o.currency_code, o.status, c.first_name, c.last_name
             FROM offers o JOIN applications a ON a.id = o.application_id JOIN candidates c ON c.id = a.candidate_id WHERE o.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const row = r.rows[0];
        return { title: "Offer approval", summary: `Offer to ${row.first_name} ${row.last_name} (${row.status})`, deepLink: `/recruitment` };
      },
      onOutcome: async (ctx) => {
        const row = (await ctx.client.query(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [ctx.recordId])).rows[0];
        if (!row) return;
        if (ctx.event === "approved" && row.status === "pending_approval") {
          await ctx.client.query(`UPDATE offers SET status = 'pending', approved_at = now() WHERE id = $1`, [ctx.recordId]);
        } else if ((ctx.event === "rejected" || ctx.event === "returned") && row.status === "pending_approval") {
          await ctx.client.query(`UPDATE offers SET status = 'approval_rejected', decided_at = now() WHERE id = $1`, [ctx.recordId]);
        } else if (ctx.event === "cancelled" && ["pending_approval", "approval_rejected"].includes(row.status)) {
          await ctx.client.query(`UPDATE offers SET status = 'rescinded', decided_at = now(), rescind_reason = coalesce($2, 'Approval cancelled') WHERE id = $1`, [
            ctx.recordId, ctx.comment,
          ]);
        } else if (ctx.event === "resubmitted" && row.status === "approval_rejected") {
          await ctx.client.query(`UPDATE offers SET status = 'pending_approval', decided_at = NULL WHERE id = $1`, [ctx.recordId]);
        } else {
          return;
        }
        await this.audit.record(ctx.client, ctx.claims, {
          companyId: row.company_id,
          action: `offer.workflow_${ctx.event}`,
          target: ctx.recordId,
          reason: ctx.comment,
        });
      },
    });
  }

  async extendOffer(claims: RequestClaims, input: ExtendOfferRequest): Promise<OfferView> {
    await this.requireManage(claims);
    const components = input.components ?? [];
    if (new Set(components.map((c) => c.componentId)).size !== components.length) {
      throw new BadRequestException("A component can appear only once in an offer");
    }
    const componentTotal = components.reduce((sum, c) => sum + Number(c.amount), 0);
    const salary = input.salary ?? (components.length > 0 ? componentTotal : undefined);
    if (!salary || salary <= 0) throw new BadRequestException("An offer needs a salary or at least one compensation component with an amount");
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException("The offer expiry must be in the future");
    }
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const applicationResult = await client.query(`SELECT * FROM applications WHERE id = $1 FOR UPDATE`, [input.applicationId]);
      if (applicationResult.rowCount === 0) throw new NotFoundException("Application not found");
      const application = applicationResult.rows[0];
      if (application.stage === "hired" || application.stage === "rejected") {
        throw new BadRequestException(`Cannot extend an offer to an application that is already ${application.stage}`);
      }
      const requisitionResult = await client.query(`SELECT status FROM job_requisitions WHERE id = $1`, [
        application.requisition_id,
      ]);
      if (!["approved", "open"].includes(requisitionResult.rows[0]?.status)) {
        throw new BadRequestException("Cannot extend an offer against a requisition that is not approved");
      }
      const existingPending = await client.query(
        `SELECT 1 FROM offers WHERE application_id = $1 AND status IN ('pending', 'pending_approval')`,
        [input.applicationId]
      );
      if ((existingPending.rowCount ?? 0) > 0) {
        throw new ConflictException("This application already has an open offer — rescind it before extending a new one");
      }
      if (components.length > 0) {
        const found = await client.query(`SELECT id FROM compensation_components WHERE id = ANY($1::uuid[])`, [components.map((c) => c.componentId)]);
        if (found.rowCount !== components.length) throw new BadRequestException("One or more compensation components do not exist");
      }
      // A previous offer that approval turned down is superseded by the new one.
      const rejectedBefore = await client.query(`SELECT id FROM offers WHERE application_id = $1 AND status = 'approval_rejected'`, [input.applicationId]);
      for (const o of rejectedBefore.rows) await this.closeOpenOffer(client, claims, o.id, "rescinded", "Superseded by a new offer");

      const settings = await loadRecruitmentSettings(client, companyId);
      const expiresAt = input.expiresAt
        ? new Date(input.expiresAt)
        : settings.offerValidityDays
          ? new Date(Date.now() + settings.offerValidityDays * 86_400_000)
          : null;

      if (application.stage !== "offer") {
        await client.query(`UPDATE applications SET stage = 'offer', updated_at = now() WHERE id = $1`, [input.applicationId]);
        await recordStageChange(client, companyId, input.applicationId, application.stage, "offer", "Offer extended", claims.sub ?? null);
      }

      const result = await client.query(
        `INSERT INTO offers (company_id, application_id, salary, start_date, status, extended_by_user_account_id, expires_at, notes)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
         RETURNING *`,
        [companyId, input.applicationId, salary, input.startDate, claims.sub, expiresAt, input.notes ?? null]
      );
      const offerId = result.rows[0].id as string;
      for (const c of components) {
        await client.query(`INSERT INTO offer_components (company_id, offer_id, component_id, amount) VALUES ($1, $2, $3, $4)`, [
          companyId, offerId, c.componentId, c.amount,
        ]);
      }
      const instanceId = await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: OFFER_WORKFLOW_OBJECT_KEY,
        table: "offers",
        recordId: offerId,
        record: { salary, currencyCode: "PKR", startDate: input.startDate, applicationId: input.applicationId, requisitionId: application.requisition_id },
        title: "Offer approval",
      });
      if (instanceId) await client.query(`UPDATE offers SET status = 'pending_approval' WHERE id = $1`, [offerId]);
      await this.audit.record(client, claims, {
        companyId,
        action: "offer.extend",
        target: offerId,
        metadata: { salary, startDate: input.startDate, components: components.length, needsApproval: Boolean(instanceId) },
      });
      return loadOfferView(client, offerId);
    });
  }

  /** Closes an open offer (rescinded / expired) and its workflow instance, if any. Runs inside the caller's transaction. */
  private async closeOpenOffer(
    client: PoolClient,
    claims: RequestClaims,
    offerId: string,
    status: "rescinded" | "expired",
    reason: string
  ): Promise<void> {
    const r = await client.query(
      `UPDATE offers SET status = $2, decided_at = now(), rescind_reason = CASE WHEN $2 = 'rescinded' THEN $3 ELSE rescind_reason END
        WHERE id = $1 AND status IN ('pending', 'pending_approval', 'approval_rejected') RETURNING workflow_instance_id, company_id`,
      [offerId, status, reason]
    );
    if (r.rowCount === 0) return;
    if (r.rows[0].workflow_instance_id && this.workflow) {
      await this.workflow.withdrawInstanceInTx(client, claims, r.rows[0].workflow_instance_id, reason);
    }
    await this.audit.record(client, claims, {
      companyId: r.rows[0].company_id,
      action: status === "expired" ? "offer.expire" : "offer.rescind",
      target: offerId,
      reason,
    });
  }

  async rescindOffer(claims: RequestClaims, id: string, reason?: string): Promise<OfferView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Offer not found");
      if (!["pending", "pending_approval", "approval_rejected"].includes(result.rows[0].status)) {
        throw new BadRequestException(`Offer is already ${result.rows[0].status}, cannot rescind`);
      }
      await this.closeOpenOffer(client, claims, id, "rescinded", reason?.trim() || "Rescinded by HR");
      return loadOfferView(client, id);
    });
  }

  /** Marks every open offer past its expiry as expired (nightly job and on-demand). Returns how many changed. */
  async expireOffers(client: PoolClient, claims: RequestClaims): Promise<number> {
    const due = await client.query(
      `SELECT id FROM offers WHERE status IN ('pending', 'pending_approval') AND expires_at IS NOT NULL AND expires_at < now()`
    );
    for (const o of due.rows) await this.closeOpenOffer(client, claims, o.id, "expired", "Offer validity period ended");
    return due.rows.length;
  }

  async listOffers(claims: RequestClaims, applicationId?: string): Promise<OfferView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const ids = await client.query(`SELECT id FROM offers WHERE ($1::uuid IS NULL OR application_id = $1) ORDER BY created_at DESC`, [applicationId ?? null]);
      const out: OfferView[] = [];
      for (const r of ids.rows) out.push(await loadOfferView(client, r.id));
      return out;
    });
  }

  /**
   * Accepting an offer creates a real Employee record via `EmployeesService.create()` (which enforces its OWN
   * `employee.manage.all` gate - `recruitment.manage.all` alone is not enough; today only hr_admin holds both).
   * TAL-03: only an approved (`pending`) offer can be decided; an expired offer is closed instead; required
   * pre-employment checks must be passed or waived; the offer's components become the employee's compensation
   * components effective on the start date.
   */
  async decideOffer(claims: RequestClaims, id: string, decision: "accepted" | "declined", reason?: string): Promise<DecideOfferResponse> {
    await this.requireManage(claims);
    const loaded = await this.db.withClaims(claims, async (client) => {
      const offerResult = await client.query(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [id]);
      if (offerResult.rowCount === 0) throw new NotFoundException("Offer not found");
      const off = offerResult.rows[0];
      if (off.status === "pending_approval") throw new BadRequestException("This offer is still awaiting approval");
      if (off.status !== "pending") throw new BadRequestException(`Offer is already ${off.status}`);
      if (off.expires_at && new Date(off.expires_at).getTime() < Date.now()) {
        await this.closeOpenOffer(client, claims, id, "expired", "Offer validity period ended");
        return { expired: true as const };
      }

      const applicationResult = await client.query(`SELECT * FROM applications WHERE id = $1`, [off.application_id]);
      const app = applicationResult.rows[0];
      if (decision === "accepted") {
        const blocking = await client.query(
          `SELECT check_type, label, status FROM pre_employment_checks
            WHERE application_id = $1 AND is_required AND status NOT IN ('passed', 'waived')`,
          [app.id]
        );
        if ((blocking.rowCount ?? 0) > 0) {
          const names = blocking.rows.map((b) => `${b.label || b.check_type} (${b.status})`).join(", ");
          throw new BadRequestException(`Required pre-employment checks are not complete: ${names}`);
        }
      }
      const candidateResult = await client.query(`SELECT * FROM candidates WHERE id = $1`, [app.candidate_id]);
      const requisitionResult = await client.query(`SELECT * FROM job_requisitions WHERE id = $1`, [app.requisition_id]);
      const comps = await client.query(`SELECT component_id, amount FROM offer_components WHERE offer_id = $1`, [id]);
      return {
        expired: false as const,
        offer: off,
        application: app,
        candidate: candidateResult.rows[0],
        requisition: requisitionResult.rows[0],
        components: comps.rows,
      };
    });
    if (loaded.expired) throw new BadRequestException("This offer has expired and can no longer be accepted or declined");
    const { offer, application, candidate, requisition, components } = loaded;

    if (decision === "declined") {
      const view = await this.db.withClaims(claims, async (client) => {
        await client.query(`UPDATE offers SET status = 'declined', decided_at = now(), decline_reason = $2 WHERE id = $1`, [id, reason?.trim() || null]);
        await this.audit.record(client, claims, {
          companyId: claims.company_id ?? null,
          action: "offer.decline",
          target: id,
          reason: reason?.trim() || null,
        });
        return loadOfferView(client, id);
      });
      return { offer: view, employee: null };
    }

    // Accepted - a separate transaction from the offer/application update below (EmployeesService.create() opens its
    // own db.withClaims()), the same cross-service non-atomicity tradeoff Decision #9 documents for leave requests.
    let employee: EmployeeView;
    try {
      employee = await this.employees.create(claims, {
        firstName: candidate.first_name,
        lastName: candidate.last_name,
        email: candidate.email ?? undefined,
        phone: candidate.phone ?? undefined,
        department: requisition.department ?? undefined,
        orgUnitId: requisition.org_unit_id ?? undefined,
        locationId: requisition.location_id ?? undefined,
        designation: requisition.title,
        managerId: requisition.hiring_manager_id ?? undefined,
        dateOfJoining: offer.start_date instanceof Date ? offer.start_date.toISOString().slice(0, 10) : offer.start_date,
        salaryBand: requisition.salary_band ?? undefined,
        cnic: candidate.national_id ? sensitive.decrypt(candidate.company_id, candidate.national_id) ?? undefined : undefined,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new ForbiddenException(
          "Accepting this offer requires employee.manage.all in addition to recruitment.manage.all — the caller is not permitted to create the resulting Employee record"
        );
      }
      throw err;
    }

    const updatedView = await this.db.withClaims(claims, async (client) => {
      await client.query(`UPDATE offers SET status = 'accepted', decided_at = now(), hired_employee_id = $2 WHERE id = $1`, [id, employee.id]);
      await client.query(`UPDATE applications SET stage = 'hired', updated_at = now() WHERE id = $1`, [application.id]);
      await recordStageChange(client, claims.company_id as string, application.id, application.stage, "hired", "Offer accepted", claims.sub ?? null);
      // Link the candidate to the person record the hire created (TAL-01).
      const emp = await client.query(`SELECT person_id FROM employees WHERE id = $1`, [employee.id]);
      if (emp.rows[0]?.person_id) {
        await client.query(`UPDATE candidates SET person_id = $2, updated_at = now() WHERE id = $1`, [candidate.id, emp.rows[0].person_id]);
      }
      // ORG-01: count the hire against the requisition; the last one closes it.
      await client.query(
        `UPDATE job_requisitions
            SET filled_headcount = filled_headcount + 1,
                status = CASE WHEN filled_headcount + 1 >= headcount AND status IN ('approved','open','on_hold') THEN 'filled' ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [requisition.id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offer.accept",
        target: id,
        metadata: { hiredEmployeeId: employee.id },
      });
      return loadOfferView(client, id);
    });

    // TAL-03: the agreed components become the employee's compensation from the start date. Separate transaction and
    // best-effort on purpose - the employee exists; HR fixes compensation in the employee record if this fails.
    if (components.length > 0 && this.compensation) {
      try {
        await this.compensation.setCompensationComponents(claims, {
          employeeId: employee.id,
          effectiveFrom: toIsoDate(offer.start_date),
          components: components.map((c) => ({ componentId: c.component_id, amount: Number(c.amount) })),
          currencyCode: offer.currency_code ?? "PKR",
        });
      } catch (err) {
        await this.db.withClaims(claims, (client) =>
          this.audit.record(client, claims, {
            companyId: claims.company_id ?? null,
            action: "offer.compensation_apply_failed",
            target: id,
            metadata: { employeeId: employee.id, error: err instanceof Error ? err.message : String(err) },
          })
        );
      }
    }

    // ORG-01: seat the new hire in the requisition's position (separate transaction; a seat taken meanwhile must not
    // undo the accepted offer - it is audited for HR to resolve in the Position Workbench).
    if (requisition.position_id && this.occupancy) {
      try {
        await this.db.withClaims(claims, async (client) => {
          await this.occupancy!.assignPositionWithinTransaction(client, claims, {
            positionId: requisition.position_id,
            employeeId: employee.id,
            source: `requisition:${requisition.id}`,
          });
          await this.occupancy!.syncEmployeeOrgSideToSeatWithinTransaction(client, claims, {
            employeeId: employee.id,
            source: `requisition:${requisition.id}`,
          });
        });
      } catch (err) {
        await this.db.withClaims(claims, (client) =>
          this.audit.record(client, claims, {
            companyId: claims.company_id ?? null,
            action: "job_requisition.position_assign_failed",
            target: requisition.id,
            metadata: { employeeId: employee.id, positionId: requisition.position_id, error: err instanceof Error ? err.message : String(err) },
          })
        );
      }
    }

    return { offer: updatedView, employee };
  }

  // -----------------------------------------------------------------

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage recruitment");
    }
  }
}
