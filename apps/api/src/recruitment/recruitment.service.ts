import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { EmployeesService } from "../employees/employees.service";
import type {
  ApplicationStage,
  ApplicationView,
  CandidateView,
  CreateApplicationRequest,
  CreateCandidateRequest,
  CreateJobRequisitionRequest,
  DecideOfferResponse,
  EmployeeView,
  ExtendOfferRequest,
  JobRequisitionView,
  OfferView,
} from "@aihxm/shared-types";

const MODULE_KEY = "recruitment" as const;
const MANAGE_PERMISSION = "recruitment.manage.all";
const WORKFLOW_TEMPLATE_KEY = "job_requisition";
const WORKFLOW_OBJECT_KEY = "job_requisition";

// The Kanban board's own forward order — see ApplicationStage's own doc
// comment in shared-types for why this is forward-only in this phase.
const FORWARD_STAGES: ApplicationStage[] = ["applied", "screening", "interview", "offer"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value;
}
function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

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
    status: row.status,
    workflowInstanceId: row.workflow_instance_id,
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCandidate(row: any): CandidateView {
  return {
    id: row.id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    createdAt: toIso(row.created_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToApplication(row: any): ApplicationView {
  return {
    id: row.id,
    companyId: row.company_id,
    requisitionId: row.requisition_id,
    candidateId: row.candidate_id,
    stage: row.stage,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToOffer(row: any): OfferView {
  return {
    id: row.id,
    companyId: row.company_id,
    applicationId: row.application_id,
    salary: Number(row.salary),
    startDate: toIsoDate(row.start_date),
    status: row.status,
    extendedByUserAccountId: row.extended_by_user_account_id,
    hiredEmployeeId: row.hired_employee_id,
    decidedAt: toIso(row.decided_at),
    createdAt: toIso(row.created_at) as string,
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
    private readonly employees: EmployeesService
  ) {}

  // --- Requisitions -------------------------------------------------

  async createRequisition(claims: RequestClaims, input: CreateJobRequisitionRequest): Promise<JobRequisitionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO job_requisitions
           (company_id, title, department, headcount, salary_band, justification, hiring_manager_id, status, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
         RETURNING *`,
        [
          claims.company_id,
          input.title,
          input.department ?? null,
          input.headcount ?? 1,
          input.salaryBand ?? null,
          input.justification ?? null,
          input.hiringManagerId ?? null,
          claims.sub,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "job_requisition.create",
        target: result.rows[0].id,
      });
      return rowToRequisition(result.rows[0]);
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

    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: id,
      record: { department: requisition.department, headcount: requisition.headcount, salaryBand: requisition.salary_band },
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

  async createCandidate(claims: RequestClaims, input: CreateCandidateRequest): Promise<CandidateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO candidates (company_id, first_name, last_name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [claims.company_id, input.firstName, input.lastName, input.email ?? null, input.phone ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "candidate.create",
        target: result.rows[0].id,
      });
      return rowToCandidate(result.rows[0]);
    });
  }

  async listCandidates(claims: RequestClaims): Promise<CandidateView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM candidates ORDER BY created_at DESC`);
      return result.rows.map(rowToCandidate);
    });
  }

  // --- Applications (the Kanban board) --------------------------------

  async createApplication(claims: RequestClaims, input: CreateApplicationRequest): Promise<ApplicationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const requisition = await client.query(`SELECT status FROM job_requisitions WHERE id = $1`, [input.requisitionId]);
      if (requisition.rowCount === 0) throw new NotFoundException("Requisition not found");
      if (requisition.rows[0].status !== "approved") {
        throw new BadRequestException("Candidates can only be added to an APPROVED requisition");
      }
      const candidate = await client.query(`SELECT id FROM candidates WHERE id = $1`, [input.candidateId]);
      if (candidate.rowCount === 0) throw new NotFoundException("Candidate not found");

      const existing = await client.query(
        `SELECT 1 FROM applications WHERE requisition_id = $1 AND candidate_id = $2`,
        [input.requisitionId, input.candidateId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This candidate has already applied to this requisition");
      }

      const result = await client.query(
        `INSERT INTO applications (company_id, requisition_id, candidate_id, stage) VALUES ($1, $2, $3, 'applied') RETURNING *`,
        [claims.company_id, input.requisitionId, input.candidateId]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
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
   * Forward-only (see `ApplicationStage`'s own doc comment): a move to
   * any later stage in `FORWARD_STAGES`' order is allowed, a move to
   * `rejected` is allowed from anywhere non-terminal, and `hired` is
   * refused here outright — it is set automatically, only by
   * `decideOffer()` accepting an offer, never by a direct stage move,
   * so accepting an offer is always what actually created the Employee
   * record behind a `hired` card.
   */
  async moveApplicationStage(claims: RequestClaims, id: string, newStage: ApplicationStage): Promise<ApplicationView> {
    await this.requireManage(claims);
    if (newStage === "hired") {
      throw new BadRequestException("An application moves to 'hired' automatically when an offer is accepted, not by a direct stage move");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM applications WHERE id = $1`, [id]);
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
        `UPDATE applications SET stage = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, newStage]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "application.move_stage",
        target: id,
        metadata: { from: current, to: newStage },
      });
      return rowToApplication(updated.rows[0]);
    });
  }

  // --- Offers -----------------------------------------------------------

  async extendOffer(claims: RequestClaims, input: ExtendOfferRequest): Promise<OfferView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const applicationResult = await client.query(`SELECT * FROM applications WHERE id = $1`, [input.applicationId]);
      if (applicationResult.rowCount === 0) throw new NotFoundException("Application not found");
      const application = applicationResult.rows[0];
      if (application.stage === "hired" || application.stage === "rejected") {
        throw new BadRequestException(`Cannot extend an offer to an application that is already ${application.stage}`);
      }
      const requisitionResult = await client.query(`SELECT status FROM job_requisitions WHERE id = $1`, [
        application.requisition_id,
      ]);
      if (requisitionResult.rows[0]?.status !== "approved") {
        throw new BadRequestException("Cannot extend an offer against a requisition that is not approved");
      }
      const existingPending = await client.query(
        `SELECT 1 FROM offers WHERE application_id = $1 AND status = 'pending'`,
        [input.applicationId]
      );
      if ((existingPending.rowCount ?? 0) > 0) {
        throw new ConflictException("This application already has a pending offer — rescind it before extending a new one");
      }

      if (application.stage !== "offer") {
        await client.query(`UPDATE applications SET stage = 'offer', updated_at = now() WHERE id = $1`, [input.applicationId]);
      }

      const result = await client.query(
        `INSERT INTO offers (company_id, application_id, salary, start_date, status, extended_by_user_account_id)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING *`,
        [claims.company_id, input.applicationId, input.salary, input.startDate, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offer.extend",
        target: result.rows[0].id,
        metadata: { salary: input.salary, startDate: input.startDate },
      });
      return rowToOffer(result.rows[0]);
    });
  }

  async rescindOffer(claims: RequestClaims, id: string): Promise<OfferView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM offers WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Offer not found");
      if (result.rows[0].status !== "pending") {
        throw new BadRequestException(`Offer is already ${result.rows[0].status}, cannot rescind`);
      }
      const updated = await client.query(
        `UPDATE offers SET status = 'rescinded', decided_at = now() WHERE id = $1 RETURNING *`,
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "offer.rescind", target: id });
      return rowToOffer(updated.rows[0]);
    });
  }

  /**
   * This phase's own exit criterion in its most concentrated form:
   * accepting an offer creates a real Employee record — the second real
   * caller of `EmployeesService.create()`'s Employee Number assignment,
   * after direct HR-Admin creation and bulk import (Phase 7). Declining
   * just records the candidate's decision; the application stays at
   * `offer` so the recruiter can extend a new offer to someone else or
   * manually reject the application.
   *
   * NOTE (see KNOWN_ISSUES.md): this calls `EmployeesService.create()`
   * directly, which enforces its OWN `employee.manage.all` gate — a
   * caller holding only `recruitment.manage.all` without ALSO holding
   * `employee.manage.all` would be refused at exactly this step. Today's
   * only `recruitment.manage.all` holder (`hr_admin`) already holds
   * `employee.manage.all` too, so this coupling isn't user-visible yet,
   * but it's a real, documented gap for a future dedicated recruiter
   * role that isn't also HR Admin.
   */
  async decideOffer(claims: RequestClaims, id: string, decision: "accepted" | "declined"): Promise<DecideOfferResponse> {
    await this.requireManage(claims);
    const { offer, application, candidate, requisition } = await this.db.withClaims(claims, async (client) => {
      const offerResult = await client.query(`SELECT * FROM offers WHERE id = $1`, [id]);
      if (offerResult.rowCount === 0) throw new NotFoundException("Offer not found");
      const off = offerResult.rows[0];
      if (off.status !== "pending") throw new BadRequestException(`Offer is already ${off.status}`);

      const applicationResult = await client.query(`SELECT * FROM applications WHERE id = $1`, [off.application_id]);
      const app = applicationResult.rows[0];
      const candidateResult = await client.query(`SELECT * FROM candidates WHERE id = $1`, [app.candidate_id]);
      const cand = candidateResult.rows[0];
      const requisitionResult = await client.query(`SELECT * FROM job_requisitions WHERE id = $1`, [app.requisition_id]);
      const req = requisitionResult.rows[0];
      return { offer: off, application: app, candidate: cand, requisition: req };
    });

    if (decision === "declined") {
      const updatedOffer = await this.db.withClaims(claims, async (client) => {
        const result = await client.query(
          `UPDATE offers SET status = 'declined', decided_at = now() WHERE id = $1 RETURNING *`,
          [id]
        );
        await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "offer.decline", target: id });
        return result.rows[0];
      });
      return { offer: rowToOffer(updatedOffer), employee: null };
    }

    // Accepted — a separate transaction from the offer/application
    // update below (EmployeesService.create() opens its own
    // db.withClaims()), the same cross-service non-atomicity tradeoff
    // Decision #9 already documents for leave requests.
    let employee: EmployeeView;
    try {
      employee = await this.employees.create(claims, {
        firstName: candidate.first_name,
        lastName: candidate.last_name,
        email: candidate.email ?? undefined,
        phone: candidate.phone ?? undefined,
        department: requisition.department ?? undefined,
        designation: requisition.title,
        managerId: requisition.hiring_manager_id ?? undefined,
        dateOfJoining: offer.start_date instanceof Date ? offer.start_date.toISOString().slice(0, 10) : offer.start_date,
        salaryBand: requisition.salary_band ?? undefined,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new ForbiddenException(
          "Accepting this offer requires employee.manage.all in addition to recruitment.manage.all — the caller is not permitted to create the resulting Employee record"
        );
      }
      throw err;
    }

    const updatedOffer = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE offers SET status = 'accepted', decided_at = now(), hired_employee_id = $2 WHERE id = $1 RETURNING *`,
        [id, employee.id]
      );
      await client.query(`UPDATE applications SET stage = 'hired', updated_at = now() WHERE id = $1`, [application.id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offer.accept",
        target: id,
        metadata: { hiredEmployeeId: employee.id },
      });
      return result.rows[0];
    });

    return { offer: rowToOffer(updatedOffer), employee };
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
