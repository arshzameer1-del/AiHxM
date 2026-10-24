import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { MailerService } from "../mailer/mailer.service";
import { NotificationsService } from "../notifications/notifications.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import { payslipsHiddenFromSelf } from "./payroll-payslip-publication";
import type { PayrollPayslipNoticeResult } from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const FINALIZE_OR_DISBURSE = ["payroll.finalize", "payroll.disburse"];
const FINAL_STATUSES = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened"];
const TEMPLATE = "payslip_ready";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pretty = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * Tells employees by email that their payslip for a finalised run is ready. It is a deliberate action (never automatic on finalise), the
 * email carries no amounts, people are told once per run, and an employee whose payslip is not yet published to them is left out.
 */
@Injectable()
export class PayrollPayslipNoticesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
    // BACKLOG51 - people can switch payslip emails off in their notification preferences.
    private readonly userNotifications?: UserNotificationsService
  ) {}

  async notifyRun(claims: RequestClaims, runId: string): Promise<PayrollPayslipNoticeResult> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, FINALIZE_OR_DISBURSE);
    if (!access) throw new ForbiddenException("Not permitted to email payslip notices");

    const data = await this.db.withClaims(claims, async (client) => {
      const run = await client.query("SELECT id, status, period_start, period_end, payroll_area_id, is_simulation FROM payroll_runs WHERE id = $1", [runId]);
      if (!run.rowCount) throw new NotFoundException("Payroll run not found");
      const row = run.rows[0];
      if (!isPayrollAreaInScope(access, row.payroll_area_id)) {
        throw access.unrestricted ? new NotFoundException("Payroll run not found") : new ForbiddenException("This payroll run is outside your payroll area scope");
      }
      if (row.is_simulation || !FINAL_STATUSES.includes(row.status)) throw new BadRequestException("Payslip notices can only be sent for a finalised run");
      const slips = await client.query(
        `SELECT p.id, p.employee_number, e.first_name, e.last_name, e.email, e.user_account_id
           FROM payslips p JOIN employees e ON e.id = p.employee_id
          WHERE p.payroll_run_id = $1 ORDER BY p.employee_number`,
        [runId]
      );
      const hidden = await payslipsHiddenFromSelf(client, slips.rows.map((s) => s.id as string));
      const told = await client.query(
        "SELECT payload->>'payslipId' AS id FROM notification_log WHERE template_key = $1 AND payload->>'payrollRunId' = $2 AND status = 'sent'",
        [TEMPLATE, runId]
      );
      const company = await client.query("SELECT slug FROM companies WHERE id = $1", [claims.company_id]);
      return { run: row, slips: slips.rows, hidden, told: new Set(told.rows.map((t) => t.id as string)), slug: company.rows[0]?.slug as string | undefined };
    });

    if (!this.mailer.isConfigured()) {
      throw new BadRequestException("Email delivery is not set up on this server (SMTP settings are missing), so nothing was sent");
    }

    const period = `${pretty(day(data.run.period_start))} to ${pretty(day(data.run.period_end))}`;
    const base = process.env.APP_BASE_URL ?? "http://localhost:5173";
    const loginUrl = data.slug ? `${base}/${data.slug}/login` : base;
    const result: PayrollPayslipNoticeResult = { payrollRunId: runId, sent: 0, alreadySent: 0, notPublished: 0, noEmail: [], failed: [], optedOut: 0 };
    const optedOut = this.userNotifications ? await this.userNotifications.emailOptedOut(data.slips.map((s) => s.user_account_id), "payslip") : new Set<string>();

    for (const s of data.slips) {
      if (data.told.has(s.id)) {
        result.alreadySent += 1;
      } else if (data.hidden.has(s.id)) {
        result.notPublished += 1;
      } else if (s.user_account_id && optedOut.has(s.user_account_id as string)) {
        result.optedOut = (result.optedOut ?? 0) + 1;
      } else if (!s.email || !String(s.email).includes("@")) {
        result.noEmail.push(s.employee_number);
      } else {
        const entry = await this.notifications.dispatch(claims, {
          channel: "email",
          recipient: String(s.email),
          templateKey: TEMPLATE,
          payload: { payrollRunId: runId, payslipId: s.id, period, employeeName: s.first_name, loginUrl },
        });
        if (entry.status === "sent") result.sent += 1;
        else result.failed.push(s.employee_number);
      }
    }

    await this.db.withClaims(claims, (client) =>
      this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.notify_payslips",
        target: runId,
        metadata: { sent: result.sent, alreadySent: result.alreadySent, notPublished: result.notPublished, noEmail: result.noEmail.length, failed: result.failed.length, optedOut: result.optedOut },
      })
    );
    return result;
  }
}
