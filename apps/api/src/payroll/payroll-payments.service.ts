import { publishPaymentStatusChanged } from "./payroll-events";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess, type PayrollAreaAccess } from "./payroll-area-access";
import { PayrollRunControlService } from "./payroll-run-control.service";
import { PayrollService } from "./payroll.service";
import { renderBankFile, rowToBankFormat, rowToPaymentBatch, rowToPaymentItem } from "./payroll-payments-support";
import { DISBURSEMENT_FIELD_KEYS } from "./dto/update-payroll-disbursement-settings.dto";
import type {
  AcknowledgePaymentBatchRequest,
  BankFileFormatView,
  PayrollPaymentBatchView,
  PayrollPaymentItemView,
  ReissuePaymentItemsRequest,
  UpsertBankFileFormatRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const DISBURSE_BASE = "payroll.disburse";
const CALCULATE_BASE = "payroll.calculate";
const FINALIZE_BASE = "payroll.finalize";
const APPROVE_PERMISSION = "payroll.approve.all";
const DISBURSE_ALL = "payroll.disburse.all";
const RELEASABLE_RUN_STATUSES = ["finalized", "accounting", "reopened"];

/**
 * PAY-16 - the life of a payment file after it has been generated: tenant-defined file formats, a release step (with a
 * second person's approval when the tenant asks for one), acknowledgement of what the bank actually paid or rejected,
 * and reissue of rejected payments. `PayrollService.generateDisbursementFile` creates the batch and its items; the
 * database refuses a second live payment for the same payslip.
 *
 * Permissions are the existing ones: `payroll.disburse.*` releases, acknowledges and reissues (scoped by payroll area),
 * `payroll.approve.all` approves - and never the person who generated the file.
 */
@Injectable()
export class PayrollPaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly payroll: PayrollService,
    private readonly control: PayrollRunControlService
  ) {}

  // ------------------------------------------------------------------ formats

  async listFormats(claims: RequestClaims, includeInactive = false): Promise<BankFileFormatView[]> {
    await this.requireDisburseAll(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`SELECT * FROM bank_file_formats ${includeInactive ? "" : "WHERE is_active"} ORDER BY is_default DESC, name`);
      return r.rows.map(rowToBankFormat);
    });
  }

  async createFormat(claims: RequestClaims, input: UpsertBankFileFormatRequest): Promise<BankFileFormatView> {
    await this.requireDisburseAll(claims);
    if (!input.code || !input.name?.trim() || !input.columns) throw new BadRequestException("code, name and columns are required");
    this.assertFormat(input);
    return this.db.withClaims(claims, async (client) => {
      if (input.isDefault) await client.query("UPDATE bank_file_formats SET is_default = false, updated_at = now() WHERE is_default");
      try {
        const r = await client.query(
          `INSERT INTO bank_file_formats (company_id, code, name, delimiter, include_header, columns, header_labels, file_extension, is_default, is_active)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10) RETURNING *`,
          [
            claims.company_id, input.code, input.name!.trim(), input.delimiter ?? "comma", input.includeHeader ?? true,
            JSON.stringify(input.columns), JSON.stringify(input.headerLabels ?? {}), input.fileExtension ?? "csv", input.isDefault ?? false, input.isActive ?? true,
          ]
        );
        await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "bank_file_format.create", target: r.rows[0].id, metadata: { code: input.code } });
        return rowToBankFormat(r.rows[0]);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "23505") throw new ConflictException(`A payment file format with code "${input.code}" already exists`);
        if (code === "23514") throw new BadRequestException("The code must be lower-case letters, digits or underscores, starting with a letter");
        throw err;
      }
    });
  }

  async updateFormat(claims: RequestClaims, id: string, input: UpsertBankFileFormatRequest): Promise<BankFileFormatView> {
    await this.requireDisburseAll(claims);
    this.assertFormat(input);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM bank_file_formats WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rowCount) throw new NotFoundException("Payment file format not found");
      const c = cur.rows[0];
      const columns = input.columns ?? (c.columns as string[]);
      const labels = input.headerLabels ?? (c.header_labels as Record<string, string>);
      const stray = Object.keys(labels).filter((k) => !columns.includes(k));
      if (stray.length) throw new BadRequestException(`headerLabels names columns that are not in the file: ${stray.join(", ")}`);
      const isDefault = input.isDefault ?? c.is_default;
      const isActive = input.isActive ?? c.is_active;
      if (isDefault && !isActive) throw new BadRequestException("The default format must be active");
      if (isDefault) await client.query("UPDATE bank_file_formats SET is_default = false, updated_at = now() WHERE is_default AND id <> $1", [id]);
      const r = await client.query(
        `UPDATE bank_file_formats SET name = $2, delimiter = $3, include_header = $4, columns = $5::jsonb, header_labels = $6::jsonb,
                file_extension = $7, is_default = $8, is_active = $9, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          id, input.name?.trim() || c.name, input.delimiter ?? c.delimiter, input.includeHeader ?? c.include_header, JSON.stringify(columns),
          JSON.stringify(labels), input.fileExtension ?? c.file_extension, isDefault, isActive,
        ]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "bank_file_format.update", target: id, metadata: { fields: Object.keys(input) } });
      return rowToBankFormat(r.rows[0]);
    });
  }

  private assertFormat(input: UpsertBankFileFormatRequest) {
    if (input.columns !== undefined) {
      if (!Array.isArray(input.columns) || input.columns.length === 0) throw new BadRequestException("columns must be a non-empty array");
      const unknown = input.columns.filter((c) => !DISBURSEMENT_FIELD_KEYS.includes(c));
      if (unknown.length) throw new BadRequestException(`Unknown column(s): ${unknown.join(", ")}`);
      if (new Set(input.columns).size !== input.columns.length) throw new BadRequestException("A column can appear only once");
      const stray = Object.keys(input.headerLabels ?? {}).filter((k) => !input.columns!.includes(k as never));
      if (stray.length) throw new BadRequestException(`headerLabels names columns that are not in the file: ${stray.join(", ")}`);
    }
    if (input.delimiter !== undefined && !["comma", "semicolon", "pipe", "tab"].includes(input.delimiter)) throw new BadRequestException("delimiter must be comma, semicolon, pipe or tab");
  }

  // ------------------------------------------------------------------ reads

  async listRunItems(claims: RequestClaims, runId: string): Promise<PayrollPaymentItemView[]> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM payroll_payment_items WHERE payroll_run_id = $1 ORDER BY employee_number, created_at", [runId]);
      return r.rows.map(rowToPaymentItem);
    });
  }

  async listBatchItems(claims: RequestClaims, batchId: string): Promise<PayrollPaymentItemView[]> {
    return this.db.withClaims(claims, async (client) => {
      const b = await client.query("SELECT payroll_run_id FROM payroll_payment_batches WHERE id = $1", [batchId]);
      if (!b.rowCount) throw new NotFoundException("Payment batch not found");
      await this.requireViewWithin(claims, client, b.rows[0].payroll_run_id);
      const r = await client.query("SELECT * FROM payroll_payment_items WHERE batch_id = $1 ORDER BY employee_number", [batchId]);
      return r.rows.map(rowToPaymentItem);
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /** A second person signs off a generated file. Never the person who generated it. */
  async approveBatch(claims: RequestClaims, batchId: string): Promise<PayrollPaymentBatchView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, APPROVE_PERMISSION))) throw new ForbiddenException("Not permitted to approve payment batches");
    return this.db.withClaims(claims, async (client) => {
      const batch = await this.lockBatch(client, batchId);
      if (batch.status !== "generated") throw new BadRequestException(`Only a generated batch can be approved (current status: "${batch.status}")`);
      if (batch.generated_by_user_account_id === claims.sub) throw new ForbiddenException("The person who generated a payment file cannot approve it");
      const r = await client.query(
        "UPDATE payroll_payment_batches SET status = 'approved', approved_by_user_account_id = $2, approved_at = now() WHERE id = $1 RETURNING *",
        [batchId, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_payment_batch.approve", target: batchId, metadata: { batchReference: batch.batch_reference } });
      await publishPaymentStatusChanged(client, claims, r.rows[0], batch.status);
      return rowToPaymentBatch(r.rows[0]);
    });
  }

  /** The file has gone to the bank. With `require_release_approval` on, it must have been approved first. */
  async releaseBatch(claims: RequestClaims, batchId: string): Promise<PayrollPaymentBatchView> {
    const access = await this.requireRunAction(claims, DISBURSE_BASE, "Not permitted to release payment batches");
    return this.db.withClaims(claims, async (client) => {
      const batch = await this.lockBatch(client, batchId);
      const run = await this.loadRun(client, batch.payroll_run_id);
      this.assertInScope(access, run);
      const settings = await client.query("SELECT require_release_approval FROM payroll_disbursement_settings WHERE company_id = $1", [claims.company_id]);
      const needsApproval = !!settings.rows[0]?.require_release_approval;
      if (batch.status === "generated" && needsApproval) throw new BadRequestException("This tenant requires a second person to approve a payment batch before it is released");
      if (!["generated", "approved"].includes(batch.status)) throw new BadRequestException(`Only a generated or approved batch can be released (current status: "${batch.status}")`);
      if (!RELEASABLE_RUN_STATUSES.includes(run.status) && run.status !== "payment_released") {
        throw new BadRequestException(`Payroll run is ${run.status}; payments of a run in that state cannot be released`);
      }
      const r = await client.query(
        "UPDATE payroll_payment_batches SET status = 'released', released_by_user_account_id = $2, released_at = now() WHERE id = $1 RETURNING *",
        [batchId, claims.sub]
      );
      await client.query("UPDATE payroll_payment_items SET status = 'released', updated_at = now() WHERE batch_id = $1 AND status = 'generated'", [batchId]);
      if (RELEASABLE_RUN_STATUSES.includes(run.status)) {
        await this.control.transition(client, claims, run.id, "payment_released", { action: "release_payments", metadata: { batchReference: batch.batch_reference } });
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_payment_batch.release", target: batchId, metadata: { batchReference: batch.batch_reference, total: Number(batch.total_net_pay) } });
      await publishPaymentStatusChanged(client, claims, r.rows[0], batch.status);
      return rowToPaymentBatch(r.rows[0]);
    });
  }

  /**
   * Records what the bank answered. With no `items` every released payment is acknowledged; with `items` only those
   * named are settled, and the batch stays released until every payment has an answer. When none are left waiting the
   * batch is acknowledged (or rejected, if the bank paid none of it).
   */
  async acknowledgeBatch(claims: RequestClaims, batchId: string, input: AcknowledgePaymentBatchRequest = {}): Promise<PayrollPaymentBatchView> {
    const access = await this.requireRunAction(claims, DISBURSE_BASE, "Not permitted to record bank acknowledgements");
    return this.db.withClaims(claims, async (client) => {
      const batch = await this.lockBatch(client, batchId);
      const run = await this.loadRun(client, batch.payroll_run_id);
      this.assertInScope(access, run);
      if (batch.status !== "released") throw new BadRequestException(`Only a released batch can be acknowledged (current status: "${batch.status}")`);
      const released = await client.query("SELECT * FROM payroll_payment_items WHERE batch_id = $1 AND status = 'released' FOR UPDATE", [batchId]);
      const byId = new Map(released.rows.map((i) => [i.id as string, i]));
      const named: Array<{ itemId: string; status: "acknowledged" | "rejected"; bankReference?: string; reason?: string }> = input.items ?? released.rows.map((i) => ({ itemId: i.id as string, status: "acknowledged" as const }));
      const seen = new Set<string>();
      for (const n of named) {
        if (seen.has(n.itemId)) throw new BadRequestException("A payment cannot be named twice");
        seen.add(n.itemId);
        if (!byId.has(n.itemId)) throw new BadRequestException("One of the payments is not waiting for an answer in this batch");
        if (!["acknowledged", "rejected"].includes(n.status)) throw new BadRequestException("A payment is either acknowledged or rejected");
        if (n.status === "rejected" && (n.reason?.trim().length ?? 0) < 3) throw new BadRequestException("A reason is required for a rejected payment");
      }
      for (const n of named) {
        await client.query(
          `UPDATE payroll_payment_items
              SET status = $2, bank_reference = COALESCE($3, $4), rejection_reason = $5,
                  acknowledged_at = CASE WHEN $2 = 'acknowledged' THEN now() ELSE acknowledged_at END, updated_at = now()
            WHERE id = $1`,
          [n.itemId, n.status, n.bankReference ?? null, input.bankReference ?? null, n.status === "rejected" ? n.reason!.trim() : null]
        );
      }
      const waiting = await client.query("SELECT COUNT(*)::int AS n FROM payroll_payment_items WHERE batch_id = $1 AND status = 'released'", [batchId]);
      const paid = await client.query("SELECT COUNT(*)::int AS n FROM payroll_payment_items WHERE batch_id = $1 AND status = 'acknowledged'", [batchId]);
      const rejected = await client.query<{ reason: string }>("SELECT rejection_reason AS reason FROM payroll_payment_items WHERE batch_id = $1 AND status = 'rejected'", [batchId]);
      let status = "released";
      if (waiting.rows[0].n === 0) status = paid.rows[0].n > 0 ? "acknowledged" : "rejected";
      const r = await client.query(
        `UPDATE payroll_payment_batches
            SET status = $2, bank_reference = COALESCE($3, bank_reference),
                acknowledged_by_user_account_id = CASE WHEN $2 <> 'released' THEN $4 ELSE acknowledged_by_user_account_id END,
                acknowledged_at = CASE WHEN $2 <> 'released' THEN now() ELSE acknowledged_at END,
                rejection_reason = $5
          WHERE id = $1 RETURNING *`,
        [batchId, status, input.bankReference ?? null, claims.sub, rejected.rowCount ? `${rejected.rowCount} payment(s) rejected` : null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_payment_batch.acknowledge",
        target: batchId,
        metadata: { batchReference: batch.batch_reference, acknowledged: named.filter((n) => n.status === "acknowledged").length, rejected: named.filter((n) => n.status === "rejected").length, result: status },
      });
      if (r.rows[0].status !== batch.status) await publishPaymentStatusChanged(client, claims, r.rows[0], batch.status);
      return rowToPaymentBatch(r.rows[0]);
    });
  }

  /**
   * New file for payments the bank rejected, built from each employee's CURRENT payment account (the usual cause of a
   * rejection is a wrong account, corrected since). The old payments become `reissued` and point to their replacements.
   */
  async reissueRejected(claims: RequestClaims, batchId: string, input: ReissuePaymentItemsRequest = {}): Promise<{ batch: PayrollPaymentBatchView; csv: string; excluded: Array<{ employeeNumber: string; employeeName: string; reason: string }> }> {
    const access = await this.requireRunAction(claims, DISBURSE_BASE, "Not permitted to reissue payments");
    return this.db.withClaims(claims, async (client) => {
      const old = await this.lockBatch(client, batchId);
      const run = await this.loadRun(client, old.payroll_run_id);
      this.assertInScope(access, run);
      if (!["acknowledged", "rejected"].includes(old.status)) throw new BadRequestException(`Payments can be reissued once the bank has answered (batch status: "${old.status}")`);
      if (!RELEASABLE_RUN_STATUSES.includes(run.status) && run.status !== "payment_released") {
        throw new BadRequestException(`Payroll run is ${run.status}; its payments cannot be reissued`);
      }
      const rejected = await client.query(
        `SELECT * FROM payroll_payment_items WHERE batch_id = $1 AND status = 'rejected' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) FOR UPDATE`,
        [batchId, input.itemIds ?? null]
      );
      if (!rejected.rowCount) throw new BadRequestException("There are no rejected payments to reissue");
      if (input.itemIds && rejected.rowCount !== new Set(input.itemIds).size) throw new BadRequestException("One of the payments is not a rejected payment of this batch");

      const slipIds = rejected.rows.map((i) => i.payslip_id as string);
      const built = await this.payroll.buildDisbursementRows(client, run.id, slipIds);
      // free the live-payment slot of the payments being replaced before the new ones are inserted
      await client.query("UPDATE payroll_payment_items SET status = 'reissued', updated_at = now() WHERE id = ANY($1::uuid[])", [rejected.rows.map((i) => i.id)]);

      const settings = await client.query("SELECT columns FROM payroll_disbursement_settings WHERE company_id = $1", [claims.company_id]);
      const format = await this.payroll.resolveBankFormat(client, claims.company_id!, old.format_id ?? undefined, (settings.rows[0]?.columns ?? ["employeeNumber", "bankAccountNumber", "netPay"]) as never);
      const count = await client.query("SELECT COUNT(*)::int AS n FROM payroll_payment_batches WHERE payroll_run_id = $1", [run.id]);
      const total = Number(built.entries.reduce((a, e) => a + e.amount, 0).toFixed(2));
      const batchReference = `PB-${String(run.id).slice(0, 8).toUpperCase()}-${count.rows[0].n + 1}`;
      const inserted = await client.query(
        `INSERT INTO payroll_payment_batches
           (company_id, payroll_run_id, batch_reference, row_count, excluded_count, total_net_pay, generated_by_user_account_id, format_id, reissued_from_batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [claims.company_id, run.id, batchReference, built.entries.length, built.excluded.length, total, claims.sub, format.id, batchId]
      );
      await this.payroll.insertPaymentItems(client, claims.company_id!, inserted.rows[0].id, run.id, built.entries);
      // each replacement points back and counts the retry
      for (const oldItem of rejected.rows) {
        const fresh = await client.query("SELECT id FROM payroll_payment_items WHERE batch_id = $1 AND payslip_id = $2", [inserted.rows[0].id, oldItem.payslip_id]);
        if (fresh.rowCount) {
          await client.query("UPDATE payroll_payment_items SET retry_count = $2 WHERE id = $1", [fresh.rows[0].id, Number(oldItem.retry_count) + 1]);
          await client.query("UPDATE payroll_payment_items SET reissued_to_item_id = $2 WHERE id = $1", [oldItem.id, fresh.rows[0].id]);
        }
      }
      // a batch the bank rejected outright is closed out by its reissue
      const stillOpen = await client.query("SELECT 1 FROM payroll_payment_items WHERE batch_id = $1 AND status IN ('rejected', 'released', 'generated') LIMIT 1", [batchId]);
      if (old.status === "rejected" && !stillOpen.rowCount) {
        const closed = await client.query("UPDATE payroll_payment_batches SET status = 'reissued' WHERE id = $1 RETURNING *", [batchId]);
        await publishPaymentStatusChanged(client, claims, closed.rows[0], old.status);
      }
      await publishPaymentStatusChanged(client, claims, inserted.rows[0], null);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_payment_batch.reissue",
        target: batchId,
        metadata: { newBatchReference: batchReference, payments: built.entries.length, excluded: built.excluded.length, reason: input.reason ?? null },
      });
      return { batch: rowToPaymentBatch(inserted.rows[0]), csv: renderBankFile(format, built.rows), excluded: built.excluded };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async lockBatch(client: PoolClient, id: string) {
    const r = await client.query("SELECT * FROM payroll_payment_batches WHERE id = $1 FOR UPDATE", [id]);
    if (!r.rowCount) throw new NotFoundException("Payment batch not found");
    return r.rows[0];
  }

  private async loadRun(client: PoolClient, id: string) {
    const r = await client.query("SELECT * FROM payroll_runs WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Payroll run not found");
    return r.rows[0];
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireDisburseAll(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, DISBURSE_ALL))) throw new ForbiddenException("Not permitted to configure payment files");
  }

  private async requireRunAction(claims: RequestClaims, base: string, message: string): Promise<PayrollAreaAccess> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [base]);
    if (!access) throw new ForbiddenException(message);
    return access;
  }

  private assertInScope(access: PayrollAreaAccess, run: { payroll_area_id?: string | null }): void {
    if (!isPayrollAreaInScope(access, run.payroll_area_id)) {
      throw new ForbiddenException(
        run.payroll_area_id ? "This payroll run's payroll area is outside your data scope" : "Only a caller with the .all permission can act on a company-wide payroll run"
      );
    }
  }

  private async requireView(claims: RequestClaims, runId: string): Promise<void> {
    await this.db.withClaims(claims, (client) => this.requireViewWithin(claims, client, runId));
  }

  private async requireViewWithin(claims: RequestClaims, client: PoolClient, runId: string): Promise<void> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [CALCULATE_BASE, FINALIZE_BASE, DISBURSE_BASE]);
    const approver = await this.rbac.can(claims, APPROVE_PERMISSION);
    if (!access && !approver) throw new ForbiddenException("Not permitted to view payment items");
    if (access && !access.unrestricted) {
      const run = await this.loadRun(client, runId);
      if (!isPayrollAreaInScope(access, run.payroll_area_id)) throw new NotFoundException("Payroll run not found");
    }
  }
}
