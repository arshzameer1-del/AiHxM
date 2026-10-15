import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import type { DecideInput, WorkflowService } from "./workflow.service";
import type { WorkflowOutcomeEvent } from "./workflow-adapter.registry";

/**
 * Gap Register WFL-01 helpers for modules that route a record through the
 * workflow engine only when the tenant has configured (activated) a template for
 * it. No template -> the module keeps its direct decision path, so nothing
 * changes for tenants that never configured a workflow.
 */

/** Tables a module may bind an instance to (guards the dynamic identifier below). */
const BINDABLE_TABLES = new Set([
  "attendance_correction_requests",
  "overtime_records",
  "on_duty_requests",
  "hire_processes",
  "employee_loans",
  "employee_additional_payments",
  "employee_offcycle_payments",
  "offers",
  "employee_compensation",
  "employee_payment_accounts",
  "employee_offboarding",
  "performance_reviews",
  "timesheets",
]);

export async function submitToEngineIfConfigured(
  workflow: WorkflowService | undefined,
  client: PoolClient,
  claims: RequestClaims,
  args: {
    objectKey: string;
    table: string;
    recordId: string;
    record: Record<string, unknown>;
    subjectUserAccountId?: string | null;
    title?: string;
    triggerEvent?: string;
  }
): Promise<string | null> {
  if (!workflow || !claims.company_id) return null;
  if (!BINDABLE_TABLES.has(args.table)) throw new Error(`Table ${args.table} is not bound to the workflow engine`);
  const templateKey = await workflow.resolveTemplateKey(client, claims.company_id, args.objectKey, args.record, args.triggerEvent);
  if (!templateKey) return null;
  const instance = await workflow.submitForApprovalInTx(client, claims, {
    templateKey,
    objectKey: args.objectKey,
    recordId: args.recordId,
    record: args.record,
    subjectUserAccountId: args.subjectUserAccountId ?? undefined,
    title: args.title,
  });
  await client.query(`UPDATE ${args.table} SET workflow_instance_id = $2 WHERE id = $1`, [args.recordId, instance.id]);
  return instance.id;
}

/** Decide on the caller's actionable approval line of an instance (own line, delegation, escalation). */
export async function decideInEngine(
  workflow: WorkflowService,
  client: PoolClient,
  claims: RequestClaims,
  instanceId: string,
  dto: DecideInput
) {
  const inst = await client.query("SELECT * FROM workflow_instances WHERE id = $1", [instanceId]);
  if (!inst.rowCount) throw new ForbiddenException("This request has no workflow instance");
  const found = await workflow.findActionableLine(client, claims.sub, inst.rows[0]);
  if (!found) throw new ForbiddenException("You are not an approver on this request");
  return workflow.decideInTx(client, claims, found.stepInstanceId, dto);
}

/** Record status a request takes for an engine outcome. */
export function statusForOutcome(event: WorkflowOutcomeEvent): "approved" | "rejected" | "returned" | "cancelled" | "pending" {
  switch (event) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "returned":
      return "returned";
    case "cancelled":
      return "cancelled";
    case "resubmitted":
      return "pending";
  }
}
