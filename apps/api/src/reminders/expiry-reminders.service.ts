import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ExclusiveCron } from "../common/cron-lock";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { UserNotificationsService } from "../notifications/user-notifications.service";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "expiry-reminders-job" };

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Which reminder an item is due for. Each stage is sent once, so a person is nudged at 30 days, at 7 days and when it has lapsed, not every night. */
export function reminderStage(dueDate: string, today: string): "lapsed" | "week" | "month" | null {
  if (dueDate < today) return "lapsed";
  if (dueDate <= addDays(today, 7)) return "week";
  if (dueDate <= addDays(today, 30)) return "month";
  return null;
}

const STAGE_TEXT = {
  lapsed: "has expired",
  week: "expires within 7 days",
  month: "expires within 30 days",
} as const;

const DUE_TEXT = {
  lapsed: "is overdue",
  week: "is due within 7 days",
  month: "is due within 30 days",
} as const;

/**
 * Functional gaps 1 and 13 - nobody was told when a mandatory document was about to expire or a course was about to fall due.
 * (Gap 12 is in the same sweep: mandatory courses are assigned to everyone active.) A nightly sweep writes in-app (and, per preference, email) notices:
 *  - to the employee, for their own approved documents with an expiry date and their open course enrollments with a due date;
 * Each stage is remembered through the notification itself (same person, same title) so nothing is sent twice.
 */
@Injectable()
export class ExpiryRemindersService {
  private readonly logger = new Logger(ExpiryRemindersService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: UserNotificationsService
  ) {}

  @Cron("0 15 6 * * *")
  @ExclusiveCron("ExpiryRemindersService.sweep")
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.run();
      if (r.documents + r.courses + r.assigned > 0) this.logger.log(`Reminders sent: ${r.documents} document, ${r.courses} course; ${r.assigned} mandatory course(s) assigned`);
    } catch (err) {
      this.logger.warn(`Reminder sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Gap 12 - every active course marked mandatory is assigned to every active employee who is not yet on it, due in 30 days. Running
   * it nightly also covers people hired after the course was created. Only tenants that have the Learning module are touched.
   */
  async assignMandatory(today: string = localToday(), companyId?: string): Promise<number> {
    return this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query(
        `INSERT INTO course_enrollments (company_id, employee_id, course_id, due_date)
         SELECT e.company_id, e.id, c.id, $1::date + 30
           FROM courses c
           JOIN employees e ON e.company_id = c.company_id AND e.employment_status = 'active'
           JOIN tenant_module_entitlement m ON m.company_id = c.company_id AND m.module_key = 'learning' AND m.enabled
          WHERE c.is_mandatory AND c.is_active AND ($2::uuid IS NULL OR c.company_id = $2)
         ON CONFLICT (employee_id, course_id) DO NOTHING`,
        [today, companyId ?? null]
      );
      return r.rowCount ?? 0;
    });
  }

  async run(today: string = localToday(), companyId?: string): Promise<{ documents: number; courses: number; assigned: number }> {
    const assigned = await this.assignMandatory(today, companyId);
    const horizon = addDays(today, 30);
    const [docs, courses] = await this.db.withClaims(SERVICE, async (client) => {
      const d = await client.query(
        `SELECT d.id, d.company_id, d.document_type, d.expiry_date::text AS due, e.user_account_id
           FROM employee_documents d JOIN employees e ON e.id = d.employee_id
          WHERE d.expiry_date IS NOT NULL AND d.expiry_date <= $1::date AND d.review_status = 'approved'
            AND d.expiry_date >= $2::date - 60 AND e.user_account_id IS NOT NULL
            AND ($3::uuid IS NULL OR d.company_id = $3)`,
        [horizon, today, companyId ?? null]
      );
      const c = await client.query(
        `SELECT ce.id, ce.company_id, co.title, ce.due_date::text AS due, e.user_account_id
           FROM course_enrollments ce JOIN courses co ON co.id = ce.course_id JOIN employees e ON e.id = ce.employee_id
          WHERE ce.due_date IS NOT NULL AND ce.due_date <= $1::date AND ce.status <> 'completed'
            AND ce.due_date >= $2::date - 60 AND e.user_account_id IS NOT NULL
            AND ($3::uuid IS NULL OR ce.company_id = $3)`,
        [horizon, today, companyId ?? null]
      );
      return [d.rows, c.rows] as const;
    });

    let documents = 0;
    let courseCount = 0;
    for (const row of docs) {
      const stage = reminderStage(row.due, today);
      if (!stage) continue;
      const label = String(row.document_type).replace(/_/g, " ");
      if (
        await this.sendOnce({
          companyId: row.company_id,
          userId: row.user_account_id,
          category: "document_expiry",
          title: `Your ${label} ${STAGE_TEXT[stage]}`,
          body: `Expiry date: ${row.due}. Upload a renewed copy so HR can approve it.`,
          link: "/app/profile?tab=documents",
        })
      ) {
        documents++;
      }
    }
    for (const row of courses) {
      const stage = reminderStage(row.due, today);
      if (!stage) continue;
      if (
        await this.sendOnce({
          companyId: row.company_id,
          userId: row.user_account_id,
          category: "learning_due",
          title: `Your course "${row.title}" ${DUE_TEXT[stage]}`,
          body: `Due date: ${row.due}.`,
          link: "/app/learning",
        })
      ) {
        courseCount++;
      }
    }
    return { documents, courses: courseCount, assigned };
  }

  /** Sends the notice unless this person already received the identical one in the last 90 days. */
  private async sendOnce(n: { companyId: string; userId: string; category: "document_expiry" | "learning_due"; title: string; body: string; link: string }): Promise<boolean> {
    const already = await this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query(
        `SELECT 1 FROM user_notifications WHERE user_account_id = $1 AND category = $2 AND title = $3 AND created_at > now() - interval '90 days' LIMIT 1`,
        [n.userId, n.category, n.title.slice(0, 200)]
      );
      return (r.rowCount ?? 0) > 0;
    });
    if (already) return false;
    await this.notifications.notify({ companyId: n.companyId, userAccountIds: [n.userId], category: n.category, title: n.title, body: n.body, link: n.link });
    return true;
  }
}
