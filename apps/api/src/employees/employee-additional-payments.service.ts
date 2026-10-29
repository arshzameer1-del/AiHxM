import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { submitToEngineIfConfigured } from "../workflow/engine-routing";
import { applyAdjustmentOutcome, assertAdjustmentReason, resolveAdjustmentComponent } from "./payroll-adjustment-support";
import type { CreateEmployeeAdditionalPaymentRequest, EmployeeAdditionalPaymentView } from "@aihxm/shared-types";

const WORKFLOW_OBJECT_KEY = "additional_payment";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

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
function rowToView(row: any): EmployeeAdditionalPaymentView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    paymentType: row.payment_type,
    label: row.label,
    amount: Number(row.amount),
    isTaxable: row.is_taxable,
    effectiveDate: toIsoDate(row.effective_date),
    status: row.status,
    consumedPayrollRunId: row.consumed_payroll_run_id,
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at),
    componentId: row.component_id ?? null,
    reasonCatalogItemId: row.reason_catalog_item_id ?? null,
    reasonNote: row.reason_note ?? null,
    approvalStatus: row.approval_status ?? "not_required",
    workflowInstanceId: row.workflow_instance_id ?? null,
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ? toIso(row.approved_at) : null,
  };
}

/**
 * Payroll Enterprise Gap Analysis Phase P3, Section 6
 * (0112_loans_advances_additional_payments.sql) — the SAP IT0015
 * equivalent: a one-time earning or deduction tied to a specific date,
 * NOT a recurring component (see `EmployeeCompensationService`) and NOT
 * (yet — Phase P4's IT0267 equivalent) tied to a specific off-cycle run.
 * Core-Employee-owned, same reasoning as `EmployeeLoansService`.
 *
 * `status` only ever moves `pending` -> `consumed` (written by
 * `PayrollService.finalizeRun()`, never `calculate()` — same "only
 * commits on finalize" posture as loan repayments) or `pending` ->
 * `cancelled` (via `cancel()` below, HR's own undo for a mistaken entry
 * that hasn't been paid yet). A `consumed` or `cancelled` row is never
 * deleted — it's the permanent record of what was (or wasn't) actually
 * paid.
 */
@Injectable()
export class EmployeeAdditionalPaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    // PAY-12: optional + appended so positional spec constructions keep working.
    private readonly workflow?: WorkflowService
  ) {
    this.workflow?.adapters?.register({
      objectKey: WORKFLOW_OBJECT_KEY,
      label: "One-time payment",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT p.label, p.amount, p.payment_type, e.first_name, e.last_name
             FROM employee_additional_payments p JOIN employees e ON e.id = p.employee_id WHERE p.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const x = r.rows[0];
        return { title: `${x.payment_type === "deduction" ? "Deduction" : "Payment"}: ${x.first_name} ${x.last_name}`, summary: `${x.label} - ${Number(x.amount).toFixed(2)}` };
      },
      onOutcome: async (ctx) => {
        const res = await applyAdjustmentOutcome("employee_additional_payments", ctx);
        if (res) {
          await this.audit.record(ctx.client, ctx.claims, {
            companyId: ctx.claims.company_id ?? null,
            action: `employee_additional_payment.${ctx.event}`,
            target: ctx.recordId,
            metadata: { approval: res.approval, viaWorkflow: ctx.instanceId },
          });
        }
      },
    });
  }

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeAdditionalPaymentView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, employeeId);
      const result = await client.query(
        "SELECT * FROM employee_additional_payments WHERE employee_id = $1 ORDER BY effective_date DESC, created_at DESC",
        [employeeId]
      );
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateEmployeeAdditionalPaymentRequest): Promise<EmployeeAdditionalPaymentView> {
    await this.requireManage(claims);
    if (input.amount <= 0) throw new BadRequestException("amount must be greater than zero");
    // A deduction is never taxable — same forced invariant
    // EmployeeCompensationService applies to deduction-type recurring
    // components, for the same reason (there is nothing to tax-exempt on
    // money being taken away).
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
      // PAY-12: paid under a catalog component when one is named; the component then supplies the label and the
      // default tax treatment, but whatever the caller sends for those wins.
      const component = input.componentId ? await resolveAdjustmentComponent(client, claims.company_id!, input.componentId, input.paymentType) : null;
      if (input.reasonCatalogItemId) await assertAdjustmentReason(client, claims.company_id!, input.reasonCatalogItemId);
      const label = (input.label?.trim() || component?.label || "").trim();
      if (!label) throw new BadRequestException("A label or a pay component is required");
      const isTaxable = input.paymentType === "deduction" ? false : input.isTaxable ?? component?.isTaxable ?? true;
      let result = await client.query(
        `INSERT INTO employee_additional_payments
           (company_id, employee_id, payment_type, label, amount, is_taxable, effective_date, created_by_user_account_id,
            component_id, reason_catalog_item_id, reason_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          claims.company_id, input.employeeId, input.paymentType, label, input.amount, isTaxable, input.effectiveDate, claims.sub,
          component?.id ?? null, input.reasonCatalogItemId ?? null, input.reasonNote?.trim() || null,
        ]
      );
      // PAY-12: with an active approval template the payment is only payable once the workflow approves it.
      const instanceId = await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: WORKFLOW_OBJECT_KEY,
        table: "employee_additional_payments",
        recordId: result.rows[0].id,
        record: { employeeId: input.employeeId, paymentType: input.paymentType, amount: input.amount, componentId: component?.id ?? null },
        title: `${input.paymentType === "deduction" ? "Deduction" : "Payment"}: ${label}`,
      });
      if (instanceId) {
        result = await client.query("UPDATE employee_additional_payments SET approval_status = 'pending' WHERE id = $1 RETURNING *", [result.rows[0].id]);
      }
      const view = rowToView(result.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_additional_payment.create",
        target: view.id,
        metadata: { employeeId: input.employeeId, paymentType: input.paymentType, amount: input.amount, effectiveDate: input.effectiveDate, componentId: component?.id ?? null, approval: view.approvalStatus },
      });
      return view;
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<EmployeeAdditionalPaymentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM employee_additional_payments WHERE id = $1", [id]);
      if (existing.rowCount === 0) throw new NotFoundException("Additional payment not found");
      const current = existing.rows[0];
      if (current.status !== "pending") {
        throw new BadRequestException(`Only a pending additional payment can be cancelled (current status: "${current.status}")`);
      }
      const result = await client.query(
        "UPDATE employee_additional_payments SET status = 'cancelled' WHERE id = $1 RETURNING *",
        [id]
      );
      // a reimbursement queued from an expense claim: the claim goes back to plain "approved"
      await client.query("UPDATE expense_claims SET payroll_payment_id = NULL, updated_at = now() WHERE payroll_payment_id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_additional_payment.cancel", target: id });
      return rowToView(result.rows[0]);
    });
  }

  /** `PayrollService.calculateOnePayslip()`'s own read — every PENDING
   * additional payment whose `effective_date` falls inside this period's
   * window, so it can preview (never mutate) it in the breakdown. */
  async listPendingInRangeWithinTransaction(
    client: PoolClient,
    employeeId: string,
    windowStart: string,
    windowEnd: string
  ): Promise<EmployeeAdditionalPaymentView[]> {
    const result = await client.query(
      `SELECT * FROM employee_additional_payments
       WHERE employee_id = $1 AND status = 'pending' AND approval_status IN ('not_required', 'approved') AND effective_date >= $2 AND effective_date <= $3
       ORDER BY effective_date ASC`,
      [employeeId, windowStart, windowEnd]
    );
    return result.rows.map(rowToView);
  }

  /** `PayrollService.finalizeRun()`'s own write — marks it consumed by
   * this run. Idempotent: a row already `consumed` is left untouched
   * rather than erroring, so re-finalizing (if that were ever possible)
   * can't double-fire — mirrors `employee_loan_repayments`'
   * `ON CONFLICT DO NOTHING` posture. */
  async markConsumedWithinTransaction(client: PoolClient, id: string, payrollRunId: string): Promise<void> {
    await client.query(
      "UPDATE employee_additional_payments SET status = 'consumed', consumed_payroll_run_id = $2 WHERE id = $1 AND status = 'pending'",
      [id, payrollRunId]
    );
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee additional payments");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee additional payments");
    }
  }
}
