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
import type { CreateEmployeeOffCyclePaymentRequest, EmployeeOffCyclePaymentView } from "@aihxm/shared-types";
import { assertSaneMoney } from "./employee-record-rules";

const WORKFLOW_OBJECT_KEY = "off_cycle_payment";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeeOffCyclePaymentView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    payrollRunId: row.payroll_run_id,
    paymentType: row.payment_type,
    label: row.label,
    amount: Number(row.amount),
    isTaxable: row.is_taxable,
    status: row.status,
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
 * Payroll Enterprise Gap Analysis Phase P4 (0113_payroll_off_cycle_runs.sql)
 * — the SAP IT0267 equivalent: `EmployeeAdditionalPaymentsService`
 * (IT0015)'s sibling for a one-time earning or deduction tied to a
 * SPECIFIC off-cycle payroll run, fixed at creation. Core-Employee-owned,
 * same posture as every other sub-entity on this profile.
 *
 * This is how HR enters a bonus figure, an arrears amount, or a
 * final-settlement line (gratuity, leave encashment — this platform does
 * NOT compute either from a statutory formula; HR enters the amount they
 * already worked out, same "don't presume a tax/statutory treatment
 * absent an accountant's say" posture `PayrollService`'s own class doc
 * comment takes everywhere else) against the off-cycle run that will pay
 * it. `PayrollService` reads this table directly (`listPendingForRunWithinTransaction`)
 * to preview each payslip at calculate() time, and commits it
 * (`markConsumedWithinTransaction`) only once THAT SAME run is finalized
 * — identical "preview at calculate, commit at finalize" discipline as
 * loans/IT0015.
 */
@Injectable()
export class EmployeeOffCyclePaymentsService {
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
      label: "Off-cycle payment",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT p.label, p.amount, p.payment_type, e.first_name, e.last_name
             FROM employee_offcycle_payments p JOIN employees e ON e.id = p.employee_id WHERE p.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const x = r.rows[0];
        return { title: `Off-cycle ${x.payment_type}: ${x.first_name} ${x.last_name}`, summary: `${x.label} - ${Number(x.amount).toFixed(2)}` };
      },
      onOutcome: async (ctx) => {
        const res = await applyAdjustmentOutcome("employee_offcycle_payments", ctx);
        if (res) {
          await this.audit.record(ctx.client, ctx.claims, {
            companyId: ctx.claims.company_id ?? null,
            action: `employee_offcycle_payment.${ctx.event}`,
            target: ctx.recordId,
            metadata: { approval: res.approval, viaWorkflow: ctx.instanceId },
          });
        }
      },
    });
  }

  /** Every off-cycle payment entered against one run — the admin surface
   * for reviewing/building up a bonus/arrears/final-settlement run
   * before calculating it. */
  async listForRun(claims: RequestClaims, payrollRunId: string): Promise<EmployeeOffCyclePaymentView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_offcycle_payments WHERE payroll_run_id = $1 ORDER BY created_at ASC",
        [payrollRunId]
      );
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateEmployeeOffCyclePaymentRequest): Promise<EmployeeOffCyclePaymentView> {
    assertSaneMoney(input.amount, "amount", "Amount");
    await this.requireManage(claims);
    if (input.amount <= 0) throw new BadRequestException("amount must be greater than zero");
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
      const component = input.componentId ? await resolveAdjustmentComponent(client, claims.company_id!, input.componentId, input.paymentType) : null;
      if (input.reasonCatalogItemId) await assertAdjustmentReason(client, claims.company_id!, input.reasonCatalogItemId);
      const label = (input.label?.trim() || component?.label || "").trim();
      if (!label) throw new BadRequestException("A label or a pay component is required");
      const isTaxable = input.paymentType === "deduction" ? false : input.isTaxable ?? component?.isTaxable ?? true;
      // Cross-module read, straight to SQL (the established "reads for
      // calculation-correctness go through an injected service, reads
      // for a plain existence/state check go straight to SQL" rule —
      // same as `EmployeeLoansService`'s own class doc comment). Only a
      // not-yet-finalized off-cycle run can still accept new lines —
      // once finalized its payslips are permanent, and a reversed run is
      // dead; HR adds to a fresh corrective run instead, same posture as
      // every other Phase P3/P4 ledger.
      const run = await client.query("SELECT company_id, run_type, status FROM payroll_runs WHERE id = $1", [input.payrollRunId]);
      if (run.rowCount === 0) throw new NotFoundException("Payroll run not found");
      const runRow = run.rows[0];
      if (runRow.company_id !== claims.company_id) throw new NotFoundException("Payroll run not found");
      if (runRow.run_type !== "off_cycle") {
        throw new BadRequestException("Additional Off-Cycle Payments can only be added to an off-cycle payroll run");
      }
      if (["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened", "reversed", "cancelled"].includes(runRow.status)) {
        throw new BadRequestException(`Cannot add a payment to a run that is already ${runRow.status}`);
      }
      let result = await client.query(
        `INSERT INTO employee_offcycle_payments
           (company_id, employee_id, payroll_run_id, payment_type, label, amount, is_taxable, created_by_user_account_id,
            component_id, reason_catalog_item_id, reason_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          claims.company_id, input.employeeId, input.payrollRunId, input.paymentType, label, input.amount, isTaxable, claims.sub,
          component?.id ?? null, input.reasonCatalogItemId ?? null, input.reasonNote?.trim() || null,
        ]
      );
      const instanceId = await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: WORKFLOW_OBJECT_KEY,
        table: "employee_offcycle_payments",
        recordId: result.rows[0].id,
        record: { employeeId: input.employeeId, paymentType: input.paymentType, amount: input.amount, componentId: component?.id ?? null },
        title: `Off-cycle ${input.paymentType}: ${label}`,
      });
      if (instanceId) {
        result = await client.query("UPDATE employee_offcycle_payments SET approval_status = 'pending' WHERE id = $1 RETURNING *", [result.rows[0].id]);
      }
      const view = rowToView(result.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_offcycle_payment.create",
        target: view.id,
        metadata: { employeeId: input.employeeId, payrollRunId: input.payrollRunId, paymentType: input.paymentType, amount: input.amount },
      });
      return view;
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<EmployeeOffCyclePaymentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM employee_offcycle_payments WHERE id = $1", [id]);
      if (existing.rowCount === 0) throw new NotFoundException("Off-cycle payment not found");
      const current = existing.rows[0];
      if (current.status !== "pending") {
        throw new BadRequestException(`Only a pending off-cycle payment can be cancelled (current status: "${current.status}")`);
      }
      const result = await client.query("UPDATE employee_offcycle_payments SET status = 'cancelled' WHERE id = $1 RETURNING *", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_offcycle_payment.cancel", target: id });
      return rowToView(result.rows[0]);
    });
  }

  /** `PayrollService.calculateOffCyclePayslip()` / `calculateOnePayslip()`'s
   * own read (the latter only when its `offCycleRunId` option is given,
   * for a `final_settlement` run) — every PENDING off-cycle payment tied
   * to this exact run and employee, so it can preview (never mutate) it
   * in the breakdown. */
  async listPendingForRunWithinTransaction(
    client: PoolClient,
    payrollRunId: string,
    employeeId: string
  ): Promise<EmployeeOffCyclePaymentView[]> {
    const result = await client.query(
      "SELECT * FROM employee_offcycle_payments WHERE payroll_run_id = $1 AND employee_id = $2 AND status = 'pending' AND approval_status IN ('not_required', 'approved') ORDER BY created_at ASC",
      [payrollRunId, employeeId]
    );
    return result.rows.map(rowToView);
  }

  /** `PayrollService.finalizeRun()`'s own write — marks it consumed by
   * the one run it was always scoped to. Idempotent (`WHERE status =
   * 'pending'`), same posture as `EmployeeAdditionalPaymentsService.markConsumedWithinTransaction()`. */
  async markConsumedWithinTransaction(client: PoolClient, id: string): Promise<void> {
    await client.query("UPDATE employee_offcycle_payments SET status = 'consumed' WHERE id = $1 AND status = 'pending'", [id]);
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee off-cycle payments");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee off-cycle payments");
    }
  }
}
