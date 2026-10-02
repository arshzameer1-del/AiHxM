import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type {
  DecideExpenseClaimRequest,
  ExpenseCategory,
  ExpenseClaimView,
  ExpenseReceiptView,
  SubmitExpenseClaimRequest,
} from "@aihxm/shared-types";

const EXPENSE_MODULE_KEY = "expense" as const;
const WORKFLOW_TEMPLATE_KEY = "expense_claim";
const WORKFLOW_OBJECT_KEY = "expense_claim";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10MB — same limit as employee_documents.
// Same reasoning as EmployeesService's ALLOWED_DOCUMENT_MIME_TYPES: a
// receipt is a photo or a scanned/PDF invoice, never an executable or
// archive, regardless of a tenant's storage quota headroom.
const ALLOWED_RECEIPT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  manager_id: string | null;
  manager_user_account_id: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToReceipt(row: any): ExpenseReceiptView {
  return {
    id: row.id,
    expenseClaimId: row.expense_claim_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: toIso(row.created_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToClaim(row: any, employeeUserAccountId: string | null, receipts: ExpenseReceiptView[]): ExpenseClaimView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    category: row.category,
    expenseDate: toIsoDate(row.expense_date),
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description,
    status: row.status,
    submittedByUserAccountId: row.submitted_by_user_account_id,
    isOnBehalf:
      employeeUserAccountId !== null &&
      row.submitted_by_user_account_id !== null &&
      row.submitted_by_user_account_id !== employeeUserAccountId,
    workflowInstanceId: row.workflow_instance_id,
    paidAt: row.paid_at ? toIso(row.paid_at) : null,
    paidByUserAccountId: row.paid_by_user_account_id,
    receipts,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Expense Management — Part 2 category 6 of the design spec, built as a
 * new end-to-end module per kumail's "develop ESS end to end as per
 * documentation" instruction (2026-10). Structurally a near-twin of
 * LeaveRequestsService: a lifecycle object, routed through the same
 * generic WorkflowService (Part 2's own "no module may create a second
 * approval center" rule), gated by the same three-role RBAC shape every
 * module since Phase 4 has used.
 *
 * Deliberately simpler than Leave in two ways, both documented tradeoffs
 * rather than oversights: (1) no balance/entitlement concept — an
 * expense claim isn't drawn against a yearly allowance the way leave is,
 * so there is nothing here analogous to LeaveBalanceView/getBalances();
 * (2) "payment" is recorded, not executed — markPaid() only stamps who/
 * when an already-approved claim was paid, since no accounting/banking
 * disbursement integration exists for this object yet (unlike Payroll's
 * own bank-file export, a real, separately-scoped integration).
 *
 * Same KNOWN NON-ATOMICITY as LeaveRequestsService.submit(): the claim
 * row insert and the WorkflowService.submitForApproval() call are
 * separate DatabaseService.withClaims() transactions.
 */
@Injectable()
export class ExpenseClaimsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  /**
   * Creates the claim row in `draft` and immediately submits it into the
   * workflow — Part 2 describes draft as a real, distinct state ("support
   * draft -> submit -> approval -> payment states"), but this service
   * doesn't yet expose a separate "save as draft, submit later" entry
   * point: every claim that reaches this method is submitted right away,
   * same as how LeaveRequestsService.submit() has no separate draft step
   * either. A row still passes through `draft` as its very first status
   * value for an instant, which is enough for a future "save draft, edit,
   * submit later" flow to build on without a schema change — not
   * building that flow now, since nothing asked for it yet, is the same
   * "don't over-build ahead of actual demand" call LeaveRequestsService's
   * own doc comments make repeatedly.
   */
  async submit(claims: RequestClaims, input: SubmitExpenseClaimRequest): Promise<ExpenseClaimView> {
    await this.requireExpenseModule(claims);

    const employee = await this.db.withClaims(claims, async (client) => this.loadEmployee(client, input.employeeId));
    if (!employee) throw new NotFoundException("Employee not found");
    if (!employee.user_account_id) {
      throw new BadRequestException(
        "This employee has no user account and cannot have expense claims routed for approval — assign them a login first"
      );
    }

    const isOnBehalf = employee.user_account_id !== claims.sub;
    const [canSelf, canManageAll] = await Promise.all([
      !isOnBehalf
        ? this.rbac.can(claims, "expense_claim.create.self", { ownerId: employee.user_account_id })
        : Promise.resolve(false),
      this.rbac.can(claims, "expense_claim.manage.all"),
    ]);
    if (!canSelf && !canManageAll) {
      throw new ForbiddenException("Not permitted to submit an expense claim for this employee");
    }

    const currency = input.currency?.trim() || "PKR";

    const claimRow = await this.db.withClaims(claims, async (client) => {
      const insertResult = await client.query(
        `INSERT INTO expense_claims
           (company_id, employee_id, category, expense_date, amount, currency, description, status, submitted_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         RETURNING *`,
        [
          employee.company_id,
          employee.id,
          input.category,
          input.expenseDate,
          input.amount,
          currency,
          input.description ?? null,
          claims.sub,
        ]
      );
      const row = insertResult.rows[0];

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "expense_claim.submit",
        target: row.id,
        metadata: { category: input.category, amount: input.amount, currency, isOnBehalf },
      });

      return row;
    });

    // Separate transaction — see this class's own doc comment on the
    // deliberate non-atomicity this introduces (same as Leave).
    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: claimRow.id,
      record: { category: input.category, amount: input.amount },
      subjectUserAccountId: employee.user_account_id,
    });

    const updatedRow = await this.db.withClaims(claims, async (client) => {
      const updateResult = await client.query(
        `UPDATE expense_claims SET workflow_instance_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [claimRow.id, instance.id]
      );
      return updateResult.rows[0];
    });

    return rowToClaim(updatedRow, employee.user_account_id, []);
  }

  async decide(claims: RequestClaims, claimId: string, dto: DecideExpenseClaimRequest): Promise<ExpenseClaimView> {
    await this.requireExpenseModule(claims);

    const { claimRow, employee } = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM expense_claims WHERE id = $1`, [claimId]);
      if (result.rowCount === 0) throw new NotFoundException("Expense claim not found");
      const row = result.rows[0];
      const emp = await this.loadEmployee(client, row.employee_id);
      return { claimRow: row, employee: emp };
    });
    if (!employee) throw new NotFoundException("Employee not found");
    if (claimRow.status !== "pending") {
      throw new BadRequestException(`Expense claim is already ${claimRow.status}`);
    }
    if (!claimRow.workflow_instance_id) {
      throw new BadRequestException("Expense claim has no workflow instance to decide on");
    }

    // Same split as LeaveRequestsService.decide(): the workflow engine IS
    // the authorization mechanism for this action (WorkflowService.decide()
    // throws ForbiddenException for a non-approver) — no separate
    // expense-specific "may approve" permission on top of that.
    const instance = await this.workflow.getInstance(claims, claimRow.workflow_instance_id);
    const pendingStep = instance.steps.find((s) => s.status === "pending");
    if (!pendingStep) {
      throw new BadRequestException("No pending approval step found on this expense claim");
    }
    const decidedInstance = await this.workflow.decide(claims, pendingStep.id, dto);

    const updatedRow = await this.db.withClaims(claims, async (client) => {
      if (decidedInstance.status === "approved") {
        await client.query(`UPDATE expense_claims SET status = 'approved', updated_at = now() WHERE id = $1`, [claimId]);
      } else if (decidedInstance.status === "rejected") {
        await client.query(`UPDATE expense_claims SET status = 'rejected', updated_at = now() WHERE id = $1`, [claimId]);
      }
      const result = await client.query(`SELECT * FROM expense_claims WHERE id = $1`, [claimId]);

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "expense_claim.decide",
        target: claimId,
        metadata: { decision: dto.decision, workflowStatus: decidedInstance.status },
      });

      return result.rows[0];
    });

    const receipts = await this.listReceiptRows(claims, claimId);
    return rowToClaim(updatedRow, employee.user_account_id, receipts.map(rowToReceipt));
  }

  /**
   * Records that an already-approved claim has been paid —
   * `expense_claim.pay.all` only (hr_admin today, same seed as Leave's
   * `.manage.all`). Deliberately not routed through WorkflowService: the
   * approval decision is already final by the time this runs, so there
   * is no further workflow step to decide — this is bookkeeping on top
   * of a completed workflow, the same way LeaveRequestsService's balance
   * decrement happens after decide() resolves rather than as another
   * workflow step.
   */
  async markPaid(claims: RequestClaims, claimId: string): Promise<ExpenseClaimView> {
    await this.requireExpenseModule(claims);
    if (!(await this.rbac.can(claims, "expense_claim.pay.all"))) {
      throw new ForbiddenException("Not permitted to mark expense claims as paid");
    }

    const { updatedRow, employee } = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM expense_claims WHERE id = $1`, [claimId]);
      if (result.rowCount === 0) throw new NotFoundException("Expense claim not found");
      const row = result.rows[0];
      if (row.status !== "approved") {
        throw new BadRequestException(`Cannot mark as paid: expense claim is ${row.status}, not approved`);
      }
      const emp = await this.loadEmployee(client, row.employee_id);

      const updateResult = await client.query(
        `UPDATE expense_claims SET status = 'paid', paid_at = now(), paid_by_user_account_id = $2, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [claimId, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: "expense_claim.mark_paid",
        target: claimId,
      });

      return { updatedRow: updateResult.rows[0], employee: emp };
    });

    const receipts = await this.listReceiptRows(claims, claimId);
    return rowToClaim(updatedRow, employee?.user_account_id ?? null, receipts.map(rowToReceipt));
  }

  async cancel(claims: RequestClaims, claimId: string): Promise<void> {
    await this.requireExpenseModule(claims);
    // Same manage.all-only posture as LeaveRequestsService.cancel() — a
    // self-cancel-your-own-still-pending-claim path is a reasonable
    // future addition, not built here since it isn't asked for yet.
    if (!(await this.rbac.can(claims, "expense_claim.manage.all"))) {
      throw new ForbiddenException("Not permitted to cancel expense claims");
    }
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT status FROM expense_claims WHERE id = $1`, [claimId]);
      if (result.rowCount === 0) throw new NotFoundException("Expense claim not found");
      if (!["draft", "pending"].includes(result.rows[0].status)) {
        throw new BadRequestException(`Cannot cancel an expense claim that is already ${result.rows[0].status}`);
      }
      await client.query(`UPDATE expense_claims SET status = 'cancelled', updated_at = now() WHERE id = $1`, [claimId]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "expense_claim.cancel",
        target: claimId,
      });
    });
  }

  async getClaim(claims: RequestClaims, id: string): Promise<ExpenseClaimView> {
    await this.requireExpenseModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT ec.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
         FROM expense_claims ec
         JOIN employees e ON e.id = ec.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         WHERE ec.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Expense claim not found");
      const row = result.rows[0];
      const visible = await this.isVisible(claims, row.employee_user_account_id, row.manager_user_account_id);
      if (!visible) throw new NotFoundException("Expense claim not found");
      const receiptsResult = await client.query(
        `SELECT * FROM expense_claim_receipts WHERE expense_claim_id = $1 ORDER BY created_at ASC`,
        [id]
      );
      return rowToClaim(row, row.employee_user_account_id, receiptsResult.rows.map(rowToReceipt));
    });
  }

  async listClaims(claims: RequestClaims, filter?: { employeeId?: string }): Promise<ExpenseClaimView[]> {
    await this.requireExpenseModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const scope = await this.rbac.resolveViewScope(claims, "expense_claim.view");
      const result = await client.query(
        `SELECT ec.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
         FROM expense_claims ec
         JOIN employees e ON e.id = ec.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         WHERE ($1::uuid IS NULL OR ec.employee_id = $1)
         ORDER BY ec.created_at DESC`,
        [filter?.employeeId ?? null]
      );
      const visibleRows = result.rows.filter(
        (row) =>
          scope.hasAll ||
          (scope.hasSelf && row.employee_user_account_id === claims.sub) ||
          (scope.hasTeam && row.manager_user_account_id === claims.sub)
      );
      if (visibleRows.length === 0) return [];
      const claimIds = visibleRows.map((row) => row.id);
      const receiptsResult = await client.query(
        `SELECT * FROM expense_claim_receipts WHERE expense_claim_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
        [claimIds]
      );
      return visibleRows.map((row) =>
        rowToClaim(
          row,
          row.employee_user_account_id,
          receiptsResult.rows.filter((r) => r.expense_claim_id === row.id).map(rowToReceipt)
        )
      );
    });
  }

  /**
   * Receipt upload — same shape as EmployeesService.addDocument(): size
   * cap + MIME allowlist, then FileStorageService.save() with the claim's
   * own id as the storage `scope` (that parameter is already scope-
   * agnostic — see 0115_expense_management.sql's header comment). Anyone
   * who can see the claim (self/team/all per expense_claim.view.*) may
   * attach a receipt to it; this deliberately does NOT require manage.all
   * the way EmployeesService.addDocument() requires employee.manage.all,
   * since attaching your own receipt to your own still-editable claim is
   * exactly what an ordinary employee needs to do here, not an HR-only
   * action.
   */
  async addReceipt(
    claims: RequestClaims,
    claimId: string,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number }
  ): Promise<ExpenseReceiptView> {
    await this.requireExpenseModule(claims);
    if (file.size > MAX_RECEIPT_BYTES) {
      throw new BadRequestException(`File exceeds the ${MAX_RECEIPT_BYTES / (1024 * 1024)}MB limit`);
    }
    if (!ALLOWED_RECEIPT_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`"${file.mimetype}" isn't an allowed receipt file type. Allowed: PDF, JPEG, PNG, WEBP.`);
    }

    const claim = await this.getClaim(claims, claimId);
    const stored = await this.fileStorage.save(claim.companyId, claimId, file.originalname, file.buffer);

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO expense_claim_receipts
           (company_id, expense_claim_id, file_name, mime_type, size_bytes, storage_path, uploaded_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [claim.companyId, claimId, file.originalname, file.mimetype, stored.sizeBytes, stored.storagePath, claims.sub]
      );
      return rowToReceipt(result.rows[0]);
    });
  }

  async downloadReceipt(
    claims: RequestClaims,
    claimId: string,
    receiptId: string
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    await this.getClaim(claims, claimId); // enforces visibility
    const row = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM expense_claim_receipts WHERE id = $1 AND expense_claim_id = $2`,
        [receiptId, claimId]
      );
      if (result.rowCount === 0) throw new NotFoundException("Receipt not found");
      return result.rows[0];
    });
    const buffer = await this.fileStorage.read(row.storage_path);
    return { buffer, fileName: row.file_name, mimeType: row.mime_type };
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async requireExpenseModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, EXPENSE_MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async isVisible(claims: RequestClaims, ownerId: string | null, teamOwnerId: string | null): Promise<boolean> {
    const scope = await this.rbac.resolveViewScope(claims, "expense_claim.view");
    return (
      scope.hasAll ||
      (scope.hasSelf && Boolean(ownerId) && ownerId === claims.sub) ||
      (scope.hasTeam && Boolean(teamOwnerId) && teamOwnerId === claims.sub)
    );
  }

  private async loadEmployee(
    client: PoolClient,
    employeeId: string
  ): Promise<(EmployeeRow & { manager_user_account_id: string | null }) | null> {
    const result = await client.query(
      `SELECT e.*, mgr.user_account_id AS manager_user_account_id
       FROM employees e
       LEFT JOIN employees mgr ON mgr.id = e.manager_id
       WHERE e.id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async listReceiptRows(claims: RequestClaims, claimId: string): Promise<any[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM expense_claim_receipts WHERE expense_claim_id = $1 ORDER BY created_at ASC`,
        [claimId]
      );
      return result.rows;
    });
  }
}

export type { ExpenseCategory };
