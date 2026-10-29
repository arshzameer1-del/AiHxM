import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ExclusiveCron } from "../common/cron-lock";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { UserNotificationsService } from "../notifications/user-notifications.service";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "payroll-deadline-reminders-job" };
const START_LEAD_DAYS = 3;
const PAY_LEAD_DAYS = 2;
/** A run that has reached one of these is no longer "waiting to be finalised". */
const DONE = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reversed", "cancelled"];

const addDays = (isoDate: string, days: number): string => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export type PayrollDeadline = { stage: "start" | "finalise"; label: string; payDate: string };

/**
 * What needs doing for one payroll period, given the runs that exist for it.
 *  - "start": the period ends within 3 days (or has ended) and no regular run exists yet.
 *  - "finalise": the pay date is within 2 days (or has passed) and the run is not finalised yet.
 */
export function deadlineFor(period: { label: string; periodEnd: string; payDate: string }, runStatuses: string[], today: string): PayrollDeadline | null {
  const live = runStatuses.filter((s) => !["reversed", "cancelled"].includes(s));
  if (live.length === 0) {
    return period.periodEnd <= addDays(today, START_LEAD_DAYS) ? { stage: "start", label: period.label, payDate: period.payDate } : null;
  }
  if (live.some((s) => DONE.includes(s))) return null;
  return period.payDate <= addDays(today, PAY_LEAD_DAYS) ? { stage: "finalise", label: period.label, payDate: period.payDate } : null;
}

/**
 * Payroll calendar reminders. Nothing here creates, calculates or pays a run: money never moves without a person. The sweep only tells the
 * people who can run payroll (payroll.calculate.all) that a period needs their attention, once per period and stage.
 */
@Injectable()
export class PayrollDeadlineRemindersService {
  private readonly logger = new Logger(PayrollDeadlineRemindersService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: UserNotificationsService
  ) {}

  @Cron("0 40 6 * * *")
  @ExclusiveCron("PayrollDeadlineRemindersService.sweep")
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.run();
      if (n > 0) this.logger.log(`Payroll deadline reminders sent: ${n}`);
    } catch (err) {
      this.logger.warn(`Payroll deadline sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run(today: string = localToday(), companyId?: string): Promise<number> {
    const { periods, people } = await this.db.withClaims(SERVICE, async (client) => {
      const p = await client.query(
        `SELECT pp.id, pp.company_id, pp.label, pp.period_start::text AS period_start, pp.period_end::text AS period_end, pp.pay_date::text AS pay_date,
                COALESCE(array_agg(r.status) FILTER (WHERE r.id IS NOT NULL), '{}') AS statuses
           FROM payroll_periods pp
           JOIN tenant_module_entitlement m ON m.company_id = pp.company_id AND m.module_key = 'payroll' AND m.enabled
           LEFT JOIN payroll_runs r ON r.payroll_period_id = pp.id AND r.run_type = 'regular' AND r.is_simulation IS NOT TRUE
          WHERE pp.status = 'open' AND pp.period_end <= $1::date + 31 AND pp.pay_date >= $1::date - 31 AND ($2::uuid IS NULL OR pp.company_id = $2)
          GROUP BY pp.id`,
        [today, companyId ?? null]
      );
      const u = await client.query(
        `SELECT DISTINCT ura.company_id, ura.user_account_id
           FROM user_role_assignments ura
           JOIN role_permissions rp ON rp.role_id = ura.role_id
           JOIN permissions pm ON pm.id = rp.permission_id AND pm.key = 'payroll.calculate.all'
          WHERE (ura.effective_from IS NULL OR ura.effective_from <= CURRENT_DATE) AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)
            AND ($1::uuid IS NULL OR ura.company_id = $1)`,
        [companyId ?? null]
      );
      return { periods: p.rows, people: u.rows };
    });

    let sent = 0;
    for (const period of periods) {
      const d = deadlineFor({ label: period.label, periodEnd: period.period_end, payDate: period.pay_date }, period.statuses as string[], today);
      if (!d) continue;
      const title = d.stage === "start" ? `Payroll for ${d.label} has not been started` : `Payroll for ${d.label} is not finalised`;
      const body = d.stage === "start" ? `The period ends ${period.period_end}; the pay date is ${d.payDate}. Create the payroll run when attendance and inputs are ready.` : `The pay date is ${d.payDate}. Calculate, approve and finalise the run in time.`;
      for (const person of people.filter((x) => x.company_id === period.company_id)) {
        if (await this.sendOnce(period.company_id, person.user_account_id, title, body)) sent++;
      }
    }
    return sent;
  }

  private async sendOnce(companyId: string, userId: string, title: string, body: string): Promise<boolean> {
    const seen = await this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query(`SELECT 1 FROM user_notifications WHERE user_account_id = $1 AND category = 'payroll_deadlines' AND title = $2 LIMIT 1`, [userId, title.slice(0, 200)]);
      return (r.rowCount ?? 0) > 0;
    });
    if (seen) return false;
    await this.notifications.notify({ companyId, userAccountIds: [userId], category: "payroll_deadlines", title, body, link: "/app/payroll" });
    return true;
  }
}
