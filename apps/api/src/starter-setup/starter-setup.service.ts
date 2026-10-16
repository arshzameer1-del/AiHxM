import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { StarterSetupItem, StarterSetupResult, StarterSetupStatus } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { HolidaysService } from "../holidays/holidays.service";
import { ShiftsService } from "../shifts/shifts.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import {
  pakistanFixedHolidays,
  STARTER_LEAVE_POLICY,
  STARTER_SHIFT,
  STARTER_WORKFLOWS,
  workflowTemplateInput,
} from "./starter-setup.definitions";

const MANAGE_PERMISSION = "hr_business_policy.manage.all";
const VIEW_PERMISSION = "hr_business_policy.view.all";

/**
 * First-day defaults for a company: the approval routes the product cannot work without, Pakistan's
 * fixed-date public holidays, a standard leave policy and a general shift. Applied on request by an HR Admin
 * (nothing is created silently), safe to run again (it only adds what is missing), and every record it makes
 * is an ordinary one the company edits afterwards.
 */
@Injectable()
export class StarterSetupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly holidays: HolidaysService,
    private readonly shifts: ShiftsService,
    private readonly employeeGroups: EmployeeGroupsService
  ) {}

  private years(now = new Date()): number[] {
    const y = now.getFullYear();
    return [y, y + 1];
  }

  async getStatus(claims: RequestClaims): Promise<StarterSetupStatus> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, VIEW_PERMISSION)) && !(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to see the starter setup");
    }
    return this.db.withClaims(claims, async (client) => {
      const items: StarterSetupItem[] = [];

      const templates = await client.query<{ key: string; is_active: boolean }>(
        "SELECT key, is_active FROM workflow_templates WHERE company_id = $1",
        [claims.company_id]
      );
      const byKey = new Map(templates.rows.map((r) => [r.key, r.is_active]));
      for (const def of STARTER_WORKFLOWS) {
        const has = byKey.has(def.key);
        const active = byKey.get(def.key) === true;
        items.push({
          key: `workflow:${def.key}`,
          group: "approvals",
          label: def.name,
          detail: !has ? "No approval route yet, so requests of this kind cannot be submitted." : active ? "Approval route in place." : "An approval route exists but is switched off.",
          state: !has ? "missing" : active ? "ready" : "attention",
        });
      }

      const wanted = this.years().flatMap((y) => pakistanFixedHolidays(y));
      const have = await client.query<{ holiday_date: string; name: string }>(
        "SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name FROM holidays WHERE company_id = $1 AND holiday_date >= $2::date AND holiday_date <= $3::date",
        [claims.company_id, `${this.years()[0]}-01-01`, `${this.years()[1]}-12-31`]
      );
      const haveDates = new Set(have.rows.map((r) => r.holiday_date));
      const missingHolidays = wanted.filter((h) => !haveDates.has(h.holidayDate));
      items.push({
        key: "holidays",
        group: "calendar",
        label: "Public holidays",
        detail: missingHolidays.length
          ? `${missingHolidays.length} fixed-date public holidays for ${this.years().join(" and ")} would be added. Eid and other moon-sighting holidays are added by HR once announced.`
          : `Fixed-date public holidays for ${this.years().join(" and ")} are in the calendar. Eid and other moon-sighting holidays are added by HR once announced.`,
        state: missingHolidays.length ? "missing" : "ready",
      });

      const policies = await client.query("SELECT 1 FROM leave_policies WHERE company_id = $1 LIMIT 1", [claims.company_id]);
      items.push({
        key: "leave_policy",
        group: "leave",
        label: "Leave policy",
        detail: policies.rowCount
          ? "A leave policy exists."
          : `No leave policy yet, so nobody can request leave. The setup adds "${STARTER_LEAVE_POLICY.name}" (${STARTER_LEAVE_POLICY.annualLeaveDays} annual, ${STARTER_LEAVE_POLICY.casualLeaveDays} casual, ${STARTER_LEAVE_POLICY.sickLeaveDays} sick days a year) as the default; HR confirms the numbers.`,
        state: policies.rowCount ? "ready" : "missing",
      });

      const shifts = await client.query("SELECT 1 FROM shifts WHERE company_id = $1 LIMIT 1", [claims.company_id]);
      items.push({
        key: "shift",
        group: "attendance",
        label: "Working hours (shift)",
        detail: shifts.rowCount
          ? "A shift exists."
          : `No shift yet, so lateness and absence cannot be worked out. The setup adds "${STARTER_SHIFT.name}", ${STARTER_SHIFT.startTime}-${STARTER_SHIFT.endTime}, as the default.`,
        state: shifts.rowCount ? "ready" : "missing",
      });

      const approvers = await client.query<{ n: string }>(
        `SELECT count(DISTINCT ura.user_account_id)::text AS n
           FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id
          WHERE ura.company_id = $1 AND r.key = 'payroll_approver'`,
        [claims.company_id]
      );
      const approverCount = Number(approvers.rows[0]?.n ?? 0);
      items.push({
        key: "payroll_approver",
        group: "payroll",
        label: "Separate payroll approver",
        detail: approverCount
          ? `${approverCount} ${approverCount === 1 ? "person holds" : "people hold"} the Payroll Approver role.`
          : "Nobody holds the Payroll Approver role, so no payroll run can be approved and finalized yet. Give the role to the person who signs off payroll.",
        state: approverCount ? "ready" : "attention",
      });

      return {
        items,
        canApply: items.some((i) => i.state === "missing"),
        needsAttention: items.filter((i) => i.state === "attention").length,
      };
    });
  }

  async apply(claims: RequestClaims): Promise<StarterSetupResult> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to apply the starter setup");
    }
    const created: string[] = [];
    const skipped: string[] = [];

    // Approval routes: one transaction, so either all missing routes exist afterwards or none was half-made.
    await this.db.withClaims(claims, async (client) => {
      const roles = await client.query<{ id: string; key: string }>("SELECT id, key FROM roles WHERE key = ANY($1::text[])", [
        Array.from(new Set(STARTER_WORKFLOWS.flatMap((w) => w.approverRoleKeys))),
      ]);
      const roleIdByKey = new Map(roles.rows.map((r) => [r.key, r.id]));
      const result = await this.workflow.createMissingTemplatesInTx(
        client,
        claims,
        STARTER_WORKFLOWS.map((w) => workflowTemplateInput(w, roleIdByKey))
      );
      created.push(...result.created.map((k) => `workflow:${k}`));
      skipped.push(...result.skipped.map((k) => `workflow:${k}`));
    });

    // The rest go through each module's own service, so its checks, audit trail and module switch all apply.
    const attempt = async (key: string, work: () => Promise<boolean>) => {
      try {
        (await work()) ? created.push(key) : skipped.push(key);
      } catch (err) {
        if (err instanceof NotFoundException || err instanceof ForbiddenException) skipped.push(key);
        else throw err;
      }
    };

    await attempt("holidays", async () => {
      const existing = await this.db.withClaims(claims, async (client) =>
        (
          await client.query<{ holiday_date: string }>(
            "SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date FROM holidays WHERE company_id = $1 AND holiday_date >= $2::date AND holiday_date <= $3::date",
            [claims.company_id, `${this.years()[0]}-01-01`, `${this.years()[1]}-12-31`]
          )
        ).rows.map((r) => r.holiday_date)
      );
      const have = new Set(existing);
      let added = 0;
      for (const h of this.years().flatMap((y) => pakistanFixedHolidays(y))) {
        if (have.has(h.holidayDate)) continue;
        await this.holidays.createHoliday(claims, { name: h.name, holidayDate: h.holidayDate, isGazetted: true, dateBasis: "fixed" });
        added += 1;
      }
      return added > 0;
    });

    await attempt("leave_policy", async () => {
      const any = await this.db.withClaims(claims, async (client) => (await client.query("SELECT 1 FROM leave_policies WHERE company_id = $1 LIMIT 1", [claims.company_id])).rowCount);
      if (any) return false;
      await this.employeeGroups.createLeavePolicy(claims, { ...STARTER_LEAVE_POLICY, isDefault: true });
      return true;
    });

    await attempt("shift", async () => {
      const any = await this.db.withClaims(claims, async (client) => (await client.query("SELECT 1 FROM shifts WHERE company_id = $1 LIMIT 1", [claims.company_id])).rowCount);
      if (any) return false;
      await this.shifts.createShift(claims, { ...STARTER_SHIFT, isDefault: true });
      return true;
    });

    await this.db.withClaims(claims, async (client) => {
      await this.audit.record(client, claims, {
        companyId: claims.company_id!,
        action: "starter_setup.apply",
        target: claims.company_id!,
        metadata: { created, skipped },
      });
    });

    return { created, skipped, status: await this.getStatus(claims) };
  }
}
