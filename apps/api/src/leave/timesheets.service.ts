import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { decideInEngine, statusForOutcome, submitToEngineIfConfigured } from "../workflow/engine-routing";
import type { DecideTimesheetRequest, SaveTimesheetEntriesRequest, TimesheetStatus, TimesheetView } from "@aihxm/shared-types";

const MODULE_KEY = "leave" as const;
const OBJECT_KEY = "timesheet";

function isoDate(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** The Monday of the ISO week containing `iso`. */
export function weekStart(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}

/**
 * Gap Register TLM-06 - weekly timesheets.
 *
 * One sheet per employee per ISO week (Monday-Sunday), created on demand as a draft. The
 * employee (or HR on their behalf) records minutes per day against an optional cost centre /
 * task; the attendance engine's processed minutes are returned alongside for comparison.
 * Submitting routes the sheet through the workflow engine when the tenant activated a
 * `timesheet` template, otherwise the employee's direct manager or HR decides it. A returned
 * sheet is editable again; an approved one is final.
 */
@Injectable()
export class TimesheetsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly workflow?: WorkflowService
  ) {
    this.workflow?.adapters?.register({
      objectKey: OBJECT_KEY,
      label: "Timesheet",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT t.period_start, t.total_minutes, e.first_name, e.last_name FROM timesheets t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const x = r.rows[0];
        return { title: `Timesheet: ${x.first_name} ${x.last_name}`, summary: `Week of ${isoDate(x.period_start)} - ${Math.round(x.total_minutes / 6) / 10} h`, deepLink: "/attendance/timesheets" };
      },
      onOutcome: async (ctx) => {
        const status = statusForOutcome(ctx.event);
        const decided = status === "approved" || status === "rejected";
        await ctx.client.query(
          `UPDATE timesheets SET status = CASE WHEN $2 = 'pending' THEN 'pending' ELSE $2 END, updated_at = now(),
                  decided_by_user_account_id = CASE WHEN $3 THEN $4::uuid ELSE decided_by_user_account_id END,
                  decision_comment = CASE WHEN $3 OR $2 = 'returned' THEN $5 ELSE decision_comment END,
                  decided_at = CASE WHEN $3 THEN now() ELSE decided_at END
            WHERE id = $1`,
          [ctx.recordId, status, decided, ctx.claims.sub, ctx.comment ?? null]
        );
        await this.audit.record(ctx.client, ctx.claims, {
          companyId: ctx.claims.company_id ?? null,
          action: `timesheet.${ctx.event}`,
          target: ctx.recordId,
          metadata: { viaWorkflow: ctx.instanceId },
        });
      },
    });
  }

  /** The sheet for the week containing `date`, created as a draft the first time it is opened. */
  async getOrCreate(claims: RequestClaims, employeeId: string, date: string): Promise<TimesheetView> {
    await this.requireModule(claims);
    const start = weekStart(date);
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.loadEmployee(client, employeeId);
      await this.requireAccess(claims, emp);
      const created = await client.query(
        `INSERT INTO timesheets (company_id, employee_id, period_start, period_end)
         VALUES ($1,$2,$3,$4) ON CONFLICT (employee_id, period_start) DO NOTHING RETURNING id`,
        [emp.company_id, employeeId, start, addDays(start, 6)]
      );
      void created;
      const id = (await client.query("SELECT id FROM timesheets WHERE employee_id = $1 AND period_start = $2", [employeeId, start])).rows[0].id;
      return this.view(client, id);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<TimesheetView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const ts = await this.loadSheet(client, id);
      await this.requireAccess(claims, await this.loadEmployee(client, ts.employee_id));
      return this.view(client, id);
    });
  }

  async list(claims: RequestClaims, filter: { employeeId?: string; status?: TimesheetStatus; forApproval?: boolean }): Promise<TimesheetView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const canAll = await this.rbac.can(claims, "attendance.record.all");
      const r = await client.query(
        `SELECT t.id FROM timesheets t JOIN employees e ON e.id = t.employee_id LEFT JOIN employees mgr ON mgr.id = e.manager_id
          WHERE ($1::uuid IS NULL OR t.employee_id = $1) AND ($2::text IS NULL OR t.status = $2)
            AND ($3::boolean = false OR t.status = 'pending')
            AND ($4::boolean OR e.user_account_id = $5 OR mgr.user_account_id = $5)
          ORDER BY t.period_start DESC, e.last_name LIMIT 200`,
        [filter.employeeId ?? null, filter.status ?? null, filter.forApproval === true, canAll, claims.sub]
      );
      const out: TimesheetView[] = [];
      for (const row of r.rows) out.push(await this.view(client, row.id));
      return out;
    });
  }

  /** Replaces the sheet's entries (draft / returned only). */
  async saveEntries(claims: RequestClaims, id: string, input: SaveTimesheetEntriesRequest): Promise<TimesheetView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const ts = await this.loadSheet(client, id);
      const emp = await this.loadEmployee(client, ts.employee_id);
      await this.requireEdit(claims, emp);
      if (!["draft", "returned"].includes(ts.status)) throw new ConflictException(`A ${ts.status} timesheet cannot be edited`);
      const start = isoDate(ts.period_start);
      const end = isoDate(ts.period_end);
      const perDay = new Map<string, number>();
      const costCenters = new Set<string>();
      for (const e of input.entries) {
        if (e.workDate < start || e.workDate > end) throw new BadRequestException(`${e.workDate} is outside this timesheet's week (${start} to ${end})`);
        if (!Number.isInteger(e.minutes) || e.minutes <= 0) throw new BadRequestException("Each entry needs a whole number of minutes above zero");
        perDay.set(e.workDate, (perDay.get(e.workDate) ?? 0) + e.minutes);
        if (e.costCenterId) costCenters.add(e.costCenterId);
      }
      for (const [day, minutes] of perDay) {
        if (minutes > 1440) throw new BadRequestException(`${day} has more than 24 hours recorded`);
      }
      if (costCenters.size > 0) {
        const found = await client.query("SELECT id FROM cost_centers WHERE id = ANY($1::uuid[])", [[...costCenters]]);
        if (found.rowCount !== costCenters.size) throw new BadRequestException("One or more cost centres were not found");
      }
      await client.query("DELETE FROM timesheet_entries WHERE timesheet_id = $1", [id]);
      let total = 0;
      for (const e of input.entries) {
        total += e.minutes;
        await client.query(
          `INSERT INTO timesheet_entries (company_id, timesheet_id, work_date, minutes, cost_center_id, task_ref, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ts.company_id, id, e.workDate, e.minutes, e.costCenterId ?? null, e.taskRef ?? null, e.description ?? null]
        );
      }
      await client.query("UPDATE timesheets SET total_minutes = $2, updated_at = now() WHERE id = $1", [id, total]);
      return this.view(client, id);
    });
  }

  async submit(claims: RequestClaims, id: string): Promise<TimesheetView> {
    await this.requireModule(claims);
    const resubmitInstance = await this.db.withClaims(claims, async (client) => {
      const ts = await this.loadSheet(client, id);
      const emp = await this.loadEmployee(client, ts.employee_id);
      await this.requireEdit(claims, emp);
      if (!["draft", "returned"].includes(ts.status)) throw new ConflictException(`A ${ts.status} timesheet cannot be submitted`);
      if (Number(ts.total_minutes) <= 0) throw new BadRequestException("Add at least one entry before submitting");
      await this.audit.record(client, claims, { companyId: ts.company_id, action: "timesheet.submit", target: id, metadata: { totalMinutes: ts.total_minutes } });
      if (ts.status === "returned" && ts.workflow_instance_id && this.workflow) {
        // The engine reopens the returned step and reports back through onOutcome ("resubmitted" -> pending).
        return ts.workflow_instance_id as string;
      }
      await client.query(
        `UPDATE timesheets SET status = 'pending', submitted_at = now(), submitted_by_user_account_id = $2, updated_at = now() WHERE id = $1`,
        [id, claims.sub]
      );
      await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: OBJECT_KEY,
        table: "timesheets",
        recordId: id,
        record: { employeeId: ts.employee_id, totalMinutes: Number(ts.total_minutes), orgUnitId: emp.org_unit_id ?? null },
        subjectUserAccountId: emp.user_account_id,
        title: `Timesheet ${isoDate(ts.period_start)}`,
      });
      return null;
    });
    if (resubmitInstance) await this.workflow!.resubmit(claims, resubmitInstance);
    return this.db.withClaims(claims, (client) => this.view(client, id));
  }

  async decide(claims: RequestClaims, id: string, input: DecideTimesheetRequest): Promise<TimesheetView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const ts = await this.loadSheet(client, id);
      if (ts.status !== "pending") throw new ConflictException("This timesheet is not awaiting a decision");
      // "returned" = sent back to the employee to change and submit again; it always needs a reason they can read.
      if (input.decision === "returned" && !input.comment?.trim()) throw new BadRequestException("Say what should be changed");
      if (ts.workflow_instance_id && this.workflow) {
        await decideInEngine(this.workflow, client, claims, ts.workflow_instance_id, { decision: input.decision === "returned" ? "send_back" : input.decision, comment: input.comment });
        return this.view(client, id);
      }
      const emp = await this.loadEmployee(client, ts.employee_id);
      const isManager = Boolean(emp.manager_user_account_id) && emp.manager_user_account_id === claims.sub;
      const isHr = await this.rbac.can(claims, "attendance.record.all");
      if (!isManager && !isHr) throw new ForbiddenException("Not permitted to decide this timesheet");
      if (emp.user_account_id === claims.sub && !isHr) throw new ForbiddenException("You cannot decide your own timesheet");
      await client.query(
        `UPDATE timesheets SET status = $2, decided_by_user_account_id = $3, decided_at = now(), decision_comment = $4, updated_at = now() WHERE id = $1`,
        [id, input.decision, claims.sub, input.comment ?? null]
      );
      await this.audit.record(client, claims, { companyId: ts.company_id, action: `timesheet.${input.decision}`, target: id });
      return this.view(client, id);
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<TimesheetView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const ts = await this.loadSheet(client, id);
      await this.requireEdit(claims, await this.loadEmployee(client, ts.employee_id));
      if (!["draft", "returned", "pending"].includes(ts.status)) throw new ConflictException(`A ${ts.status} timesheet cannot be cancelled`);
      await client.query("UPDATE timesheets SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: ts.company_id, action: "timesheet.cancel", target: id });
      return this.view(client, id);
    });
  }

  // ------------------------------------------------------------ internals

  private async view(client: PoolClient, id: string): Promise<TimesheetView> {
    const ts = (await client.query(
      `SELECT t.*, e.first_name, e.last_name FROM timesheets t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`,
      [id]
    )).rows[0];
    const entries = await client.query("SELECT * FROM timesheet_entries WHERE timesheet_id = $1 ORDER BY work_date, created_at", [id]);
    const recorded = await client.query(
      `SELECT work_date, worked_minutes FROM attendance_daily_results WHERE employee_id = $1 AND work_date BETWEEN $2::date AND $3::date`,
      [ts.employee_id, ts.period_start, ts.period_end]
    );
    return {
      id: ts.id,
      employeeId: ts.employee_id,
      employeeName: `${ts.first_name} ${ts.last_name}`,
      periodStart: isoDate(ts.period_start),
      periodEnd: isoDate(ts.period_end),
      status: ts.status,
      totalMinutes: ts.total_minutes,
      submittedAt: ts.submitted_at ? ts.submitted_at.toISOString() : null,
      decidedAt: ts.decided_at ? ts.decided_at.toISOString() : null,
      decisionComment: ts.decision_comment,
      workflowInstanceId: ts.workflow_instance_id,
      entries: entries.rows.map((e) => ({
        id: e.id, workDate: isoDate(e.work_date), minutes: e.minutes, costCenterId: e.cost_center_id, taskRef: e.task_ref, description: e.description,
      })),
      recordedMinutesByDay: Object.fromEntries(recorded.rows.map((r) => [isoDate(r.work_date), r.worked_minutes])),
    };
  }

  private async loadSheet(client: PoolClient, id: string) {
    const r = await client.query("SELECT * FROM timesheets WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Timesheet not found");
    return r.rows[0];
  }

  private async loadEmployee(client: PoolClient, employeeId: string) {
    const r = await client.query(
      `SELECT e.id, e.company_id, e.user_account_id, e.org_unit_id, mgr.user_account_id AS manager_user_account_id
         FROM employees e LEFT JOIN employees mgr ON mgr.id = e.manager_id WHERE e.id = $1`,
      [employeeId]
    );
    if (r.rowCount === 0) throw new NotFoundException("Employee not found");
    return r.rows[0] as { id: string; company_id: string; user_account_id: string | null; org_unit_id: string | null; manager_user_account_id: string | null };
  }

  private async canEdit(claims: RequestClaims, emp: { user_account_id: string | null }): Promise<boolean> {
    if (await this.rbac.can(claims, "attendance.record.all")) return true;
    return emp.user_account_id === claims.sub && (await this.rbac.can(claims, "attendance.record.self", { ownerId: emp.user_account_id }));
  }

  private async requireEdit(claims: RequestClaims, emp: { user_account_id: string | null }): Promise<void> {
    if (!(await this.canEdit(claims, emp))) throw new NotFoundException("Timesheet not found");
  }

  private async requireAccess(claims: RequestClaims, emp: { user_account_id: string | null; manager_user_account_id: string | null }): Promise<void> {
    const isManager = Boolean(emp.manager_user_account_id) && emp.manager_user_account_id === claims.sub;
    if (isManager || (await this.canEdit(claims, emp))) return;
    throw new NotFoundException("Timesheet not found");
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }
}
