import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { PayrollAdjustmentApprovalStatus } from "@aihxm/shared-types";
import type { WorkflowOutcomeContext } from "../workflow/workflow-adapter.registry";
import { statusForOutcome } from "../workflow/engine-routing";

/** PAY-12 - what the one-time and off-cycle payment services share: the component reference, the reason, the approval. */

export type AdjustmentComponent = { id: string; label: string; isTaxable: boolean; componentType: string };

/** The pay component an adjustment is paid under: must exist, be active and agree with the earning / deduction direction. */
export async function resolveAdjustmentComponent(
  client: PoolClient,
  companyId: string,
  componentId: string,
  paymentType: "earning" | "deduction"
): Promise<AdjustmentComponent> {
  const r = await client.query(
    "SELECT id, name, payslip_label, is_taxable, component_type, is_active FROM compensation_components WHERE id = $1 AND company_id = $2",
    [componentId, companyId]
  );
  if (r.rowCount === 0) throw new BadRequestException("The pay component does not exist");
  const c = r.rows[0];
  if (!c.is_active) throw new BadRequestException(`The pay component "${c.name}" is not active`);
  const deduction = c.component_type === "deduction";
  const earningLike = ["earning", "reimbursement", "arrears", "retro", "shift_premium"].includes(c.component_type);
  if (!deduction && !earningLike) {
    throw new BadRequestException(`"${c.name}" is a ${String(c.component_type).replace(/_/g, " ")} and cannot be used for a one-time payment`);
  }
  if ((paymentType === "deduction") !== deduction) {
    throw new BadRequestException(`"${c.name}" is ${deduction ? "a deduction" : "an earning"}, but this adjustment is ${paymentType === "deduction" ? "a deduction" : "an earning"}`);
  }
  return { id: c.id, label: c.payslip_label || c.name, isTaxable: !!c.is_taxable, componentType: c.component_type };
}

export async function assertAdjustmentReason(client: PoolClient, companyId: string, reasonId: string): Promise<void> {
  const r = await client.query(
    "SELECT 1 FROM hr_reference_catalog_items WHERE id = $1 AND company_id = $2 AND catalog_type = 'payroll_adjustment_reason' AND is_active",
    [reasonId, companyId]
  );
  if (r.rowCount === 0) throw new BadRequestException("The adjustment reason does not exist");
}

/**
 * Runs inside the workflow decision transaction: an approved adjustment becomes payable; a rejected or cancelled one
 * is withdrawn (kept on record, never paid); a returned / resubmitted one waits again.
 */
export async function applyAdjustmentOutcome(table: "employee_additional_payments" | "employee_offcycle_payments", ctx: WorkflowOutcomeContext): Promise<{ approval: PayrollAdjustmentApprovalStatus } | null> {
  const row = (await ctx.client.query(`SELECT id, status FROM ${table} WHERE id = $1 FOR UPDATE`, [ctx.recordId])).rows[0];
  if (!row) return null;
  const outcome = statusForOutcome(ctx.event);
  if (outcome === "approved") {
    await ctx.client.query(`UPDATE ${table} SET approval_status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [ctx.recordId, ctx.claims.sub]);
    return { approval: "approved" };
  }
  if (outcome === "rejected" || outcome === "cancelled") {
    await ctx.client.query(
      `UPDATE ${table} SET approval_status = 'rejected', status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END WHERE id = $1`,
      [ctx.recordId]
    );
    return { approval: "rejected" };
  }
  await ctx.client.query(`UPDATE ${table} SET approval_status = 'pending' WHERE id = $1 AND status = 'pending'`, [ctx.recordId]);
  return { approval: "pending" };
}
