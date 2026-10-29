import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AttendancePenaltyRowView, AttendancePenaltyRuleView, SaveAttendancePenaltyRuleRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { LeaveLedgerService } from "../leave/leave-ledger.service";
import { RbacService } from "../rbac/rbac.service";

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthBounds(month: string): { first: string; last: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { first: `${month}-01`, last };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toRule = (x: any): AttendancePenaltyRuleView => ({
  id: x.id, name: x.name, triggerKind: x.trigger_kind, minMinutes: x.min_minutes, everyN: x.every_n, penaltyType: x.penalty_type, leaveType: x.leave_type ?? null,
  penaltyDays: x.penalty_days === null ? null : Number(x.penalty_days), penaltyAmount: x.penalty_amount === null ? null : Number(x.penalty_amount), isActive: x.is_active,
});

/**
 * "Every 3 late arrivals of 10+ minutes in a month costs 1 day of annual leave (or PKR 1,500)". Nothing happens by itself:
 * HR previews a finished month, applies the penalty person by person and can reverse it. Counting uses the processed daily
 * results (so approved leave, holidays, rest days and corrections are already taken into account).
 */
@Injectable()
export class AttendancePenaltiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly ledger: LeaveLedgerService,
    private readonly payments: EmployeeAdditionalPaymentsService
  ) {}

  async listRules(claims: RequestClaims): Promise<AttendancePenaltyRuleView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => (await c.query("SELECT * FROM attendance_penalty_rules ORDER BY name")).rows.map(toRule));
  }

  async saveRule(claims: RequestClaims, id: string | null, input: SaveAttendancePenaltyRuleRequest): Promise<AttendancePenaltyRuleView> {
    await this.requireManage(claims);
    const name = (input.name ?? "").trim();
    if (!name || name.length > 120) throw new BadRequestException("Give the rule a name of up to 120 characters");
    if (!["late", "early_leave"].includes(input.triggerKind)) throw new BadRequestException("Choose late arrival or early leaving");
    if (!Number.isInteger(input.minMinutes) || input.minMinutes < 1 || input.minMinutes > 600) throw new BadRequestException("Minutes must be a whole number from 1 to 600");
    if (!Number.isInteger(input.everyN) || input.everyN < 1 || input.everyN > 31) throw new BadRequestException("Occurrences must be a whole number from 1 to 31");
    if (input.penaltyType === "leave_deduction") {
      if (!input.leaveType?.trim()) throw new BadRequestException("Choose the leave type the days are taken from");
      if (!(Number(input.penaltyDays) > 0) || Number(input.penaltyDays) > 30) throw new BadRequestException("Days to deduct must be more than 0 and at most 30");
    } else if (input.penaltyType === "salary_deduction") {
      if (!(Number(input.penaltyAmount) > 0)) throw new BadRequestException("The amount to deduct must be more than zero");
    } else throw new BadRequestException("Choose a leave deduction or a salary deduction");
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      if (input.penaltyType === "leave_deduction") {
        const t = await client.query("SELECT 1 FROM leave_types WHERE company_id = $1 AND code = $2", [companyId, input.leaveType]);
        if (!t.rowCount) throw new BadRequestException("That leave type does not exist");
      }
      const clash = await client.query("SELECT 1 FROM attendance_penalty_rules WHERE company_id = $1 AND name = $2 AND ($3::uuid IS NULL OR id <> $3)", [companyId, name, id]);
      if (clash.rowCount) throw new BadRequestException("A rule with that name already exists");
      const leave = input.penaltyType === "leave_deduction";
      const args = [name, input.triggerKind, input.minMinutes, input.everyN, input.penaltyType, leave ? input.leaveType : null, leave ? r2(Number(input.penaltyDays)) : null, leave ? null : r2(Number(input.penaltyAmount))];
      let row;
      if (id) {
        const r = await client.query(
          `UPDATE attendance_penalty_rules SET name=$2, trigger_kind=$3, min_minutes=$4, every_n=$5, penalty_type=$6, leave_type=$7, penalty_days=$8, penalty_amount=$9,
                  is_active = COALESCE($10, is_active), updated_at = now() WHERE id = $1 RETURNING *`,
          [id, ...args, input.isActive ?? null]
        );
        if (!r.rowCount) throw new NotFoundException("Rule not found");
        row = r.rows[0];
      } else {
        const r = await client.query(
          `INSERT INTO attendance_penalty_rules (company_id, name, trigger_kind, min_minutes, every_n, penalty_type, leave_type, penalty_days, penalty_amount, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,true)) RETURNING *`,
          [companyId, ...args, input.isActive ?? null]
        );
        row = r.rows[0];
      }
      await this.audit.record(client, claims, { companyId, action: id ? "attendance_penalty_rule.update" : "attendance_penalty_rule.create", target: row.id, metadata: { name } });
      return toRule(row);
    });
  }

  async deleteRule(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const used = await client.query("SELECT 1 FROM attendance_penalty_applications WHERE rule_id = $1 LIMIT 1", [id]);
      if (used.rowCount) throw new ConflictException("This rule has been applied before. Switch it off instead of deleting it, so the history stays explainable.");
      const r = await client.query("DELETE FROM attendance_penalty_rules WHERE id = $1", [id]);
      if (!r.rowCount) throw new NotFoundException("Rule not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "attendance_penalty_rule.delete", target: id });
    });
  }

  /** Who reached each active rule's threshold in a month, and what has already been applied. */
  async preview(claims: RequestClaims, month: string): Promise<AttendancePenaltyRowView[]> {
    await this.requireManage(claims);
    if (!MONTH_RE.test(month ?? "")) throw new BadRequestException("Choose a month like 2026-09");
    return this.db.withClaims(claims, async (client) => {
      const rules = (await client.query("SELECT * FROM attendance_penalty_rules WHERE is_active ORDER BY name")).rows;
      const out: AttendancePenaltyRowView[] = [];
      for (const rule of rules) out.push(...(await this.rowsForRule(client, rule, month)));
      return out;
    });
  }

  async apply(claims: RequestClaims, input: { ruleId: string; employeeId: string; month: string }): Promise<AttendancePenaltyRowView> {
    await this.requireManage(claims);
    if (!MONTH_RE.test(input.month ?? "")) throw new BadRequestException("Choose a month like 2026-09");
    const { first, last } = monthBounds(input.month);
    if (last >= localToday()) throw new BadRequestException("Apply penalties after the month has ended, so every day is counted");
    const prep = await this.db.withClaims(claims, async (client) => {
      const rule = (await client.query("SELECT * FROM attendance_penalty_rules WHERE id = $1", [input.ruleId])).rows[0];
      if (!rule) throw new NotFoundException("Rule not found");
      if (!rule.is_active) throw new BadRequestException("This rule is switched off");
      const row = (await this.rowsForRule(client, rule, input.month, input.employeeId))[0];
      if (!row || row.units < 1) throw new BadRequestException("This person did not reach the rule's threshold in that month");
      if (row.status !== "pending") throw new ConflictException(row.status === "applied" ? "Already applied for this month" : "This was applied and reversed; it cannot be applied again for the same month");
      const emp = (await client.query("SELECT company_id FROM employees WHERE id = $1", [input.employeeId])).rows[0];
      const app = await client.query(
        `INSERT INTO attendance_penalty_applications (company_id, rule_id, employee_id, period_month, occurrences, units, penalty_days, penalty_amount, applied_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [emp.company_id, rule.id, input.employeeId, first, row.occurrences, row.units, row.penaltyDays, row.penaltyAmount, claims.sub]
      );
      if (rule.penalty_type === "leave_deduction") {
        await this.ledger.post(client, {
          companyId: emp.company_id, employeeId: input.employeeId, leaveType: rule.leave_type, year: Number(input.month.slice(0, 4)), entryType: "deduction",
          days: -(row.penaltyDays as number), effectiveDate: last, sourceType: "attendance_penalty", sourceId: app.rows[0].id, sourceKey: `penalty:${app.rows[0].id}`,
          reason: `${rule.name} (${input.month})`, createdBy: claims.sub,
        });
      }
      await this.audit.record(client, claims, { companyId: emp.company_id, action: "attendance_penalty.apply", target: app.rows[0].id, metadata: { rule: rule.name, month: input.month, units: row.units } });
      return { appId: app.rows[0].id as string, rule, row };
    });
    if (prep.rule.penalty_type === "salary_deduction") {
      try {
        const today = localToday();
        const pay = await this.payments.create(claims, {
          employeeId: input.employeeId, paymentType: "deduction", label: `${prep.rule.name} (${input.month})`, amount: prep.row.penaltyAmount as number,
          effectiveDate: last < today ? today : last, reasonNote: `${prep.row.occurrences} occurrence(s) in ${input.month}`,
        });
        await this.db.withClaims(claims, (c) => c.query("UPDATE attendance_penalty_applications SET additional_payment_id = $2 WHERE id = $1", [prep.appId, pay.id]));
      } catch (err) {
        await this.db.withClaims(claims, (c) => c.query("DELETE FROM attendance_penalty_applications WHERE id = $1", [prep.appId]));
        throw err;
      }
    }
    return { ...prep.row, applicationId: prep.appId, status: "applied" };
  }

  async reverse(claims: RequestClaims, applicationId: string): Promise<void> {
    await this.requireManage(claims);
    const app = await this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM attendance_penalty_applications WHERE id = $1 FOR UPDATE", [applicationId]);
      if (!r.rowCount) throw new NotFoundException("Penalty not found");
      if (r.rows[0].status === "reversed") throw new ConflictException("Already reversed");
      return r.rows[0];
    });
    if (app.additional_payment_id) {
      const pay = await this.db.withClaims(claims, async (c) => (await c.query("SELECT status FROM employee_additional_payments WHERE id = $1", [app.additional_payment_id])).rows[0]);
      if (pay && pay.status === "consumed") throw new BadRequestException("This deduction has already been taken in a payroll run. Refund it as a payment instead.");
      if (pay && pay.status === "pending") await this.payments.cancel(claims, app.additional_payment_id);
    }
    await this.db.withClaims(claims, async (client) => {
      await this.ledger.reverseSource(client, app.company_id, "attendance_penalty", applicationId, "Penalty reversed", claims.sub);
      await client.query("UPDATE attendance_penalty_applications SET status = 'reversed', reversed_by = $2, reversed_at = now() WHERE id = $1", [applicationId, claims.sub]);
      await this.audit.record(client, claims, { companyId: app.company_id, action: "attendance_penalty.reverse", target: applicationId });
    });
  }

  // ------------------------------------------------------------------ internals

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async rowsForRule(client: PoolClient, rule: any, month: string, employeeId?: string): Promise<AttendancePenaltyRowView[]> {
    const { first, last } = monthBounds(month);
    const col = rule.trigger_kind === "late" ? "late_minutes" : "early_leave_minutes";
    const r = await client.query(
      `SELECT d.employee_id, count(*)::int AS occurrences, e.employee_number, trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name
         FROM attendance_daily_results d JOIN employees e ON e.id = d.employee_id
        WHERE d.work_date BETWEEN $1::date AND $2::date AND d.${col} >= $3
          AND d.status NOT IN ('on_leave', 'holiday', 'rest_day', 'on_duty', 'absent', 'no_schedule')
          AND ($4::uuid IS NULL OR d.employee_id = $4)
        GROUP BY d.employee_id, e.employee_number, e.first_name, e.last_name
       HAVING count(*) >= $5 ORDER BY e.employee_number`,
      [first, last, rule.min_minutes, employeeId ?? null, rule.every_n]
    );
    const apps = await client.query("SELECT id, employee_id, status FROM attendance_penalty_applications WHERE rule_id = $1 AND period_month = $2::date", [rule.id, first]);
    const byEmp = new Map(apps.rows.map((a) => [a.employee_id as string, a]));
    return r.rows.map((x) => {
      const units = Math.floor(x.occurrences / rule.every_n);
      const a = byEmp.get(x.employee_id);
      return {
        ruleId: rule.id, ruleName: rule.name, employeeId: x.employee_id, employeeNumber: x.employee_number, employeeName: x.employee_name, occurrences: x.occurrences, units,
        penaltyDays: rule.penalty_type === "leave_deduction" ? r2(units * Number(rule.penalty_days)) : null,
        penaltyAmount: rule.penalty_type === "salary_deduction" ? r2(units * Number(rule.penalty_amount)) : null,
        applicationId: a?.id ?? null, status: (a?.status ?? "pending") as AttendancePenaltyRowView["status"],
      };
    });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "leave"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "attendance_policy.manage"))) throw new ForbiddenException("Not permitted to manage attendance rules");
  }
}
