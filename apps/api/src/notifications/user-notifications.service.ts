import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import type { NotificationCategoryKey, NotificationPreferenceView, UserNotificationInbox, UserNotificationView } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { MailerService } from "../mailer/mailer.service";
import { NOTIFICATION_CATEGORIES, categoryOf } from "./notification-categories";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "user-notifications" };
const MAX_INBOX = 30;

export type NotifyInput = {
  companyId: string;
  userAccountIds: Array<string | null | undefined>;
  category: NotificationCategoryKey;
  title: string;
  body?: string | null;
  /** an address inside the app, e.g. "/app/profile?tab=documents" */
  link?: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(row: any): UserNotificationView {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body ?? null,
    link: row.link ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    readAt: row.read_at ? (row.read_at instanceof Date ? row.read_at.toISOString() : String(row.read_at)) : null,
  };
}

/**
 * BACKLOG51 - the in-app inbox (the bell) and each person's notification preferences. `notify()` is what the rest of the platform
 * calls when something happens to a person: it honours their preferences, writes the in-app entry and sends the email. It never
 * throws - a notification must not make the action that caused it fail.
 */
@Injectable()
export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mailer: MailerService
  ) {}

  // ---- producers --------------------------------------------------------------------------------------------------

  async notify(input: NotifyInput): Promise<void> {
    try {
      const category = categoryOf(input.category);
      if (!category) return;
      const ids = Array.from(new Set(input.userAccountIds.filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x))));
      if (ids.length === 0) return;
      const emails: Array<{ to: string; name?: string }> = [];
      await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
        const prefs = await client.query(
          "SELECT user_account_id, email, in_app FROM user_notification_preferences WHERE category = $1 AND user_account_id = ANY($2::uuid[])",
          [input.category, ids]
        );
        const byUser = new Map(prefs.rows.map((r) => [r.user_account_id as string, r]));
        const accounts = await client.query("SELECT id, email FROM user_accounts WHERE id = ANY($1::uuid[])", [ids]);
        const emailOf = new Map(accounts.rows.map((r) => [r.id as string, r.email as string]));
        for (const id of ids) {
          const pref = byUser.get(id);
          const wantInApp = category.channels.includes("in_app") && (pref ? pref.in_app : category.defaults.inApp);
          const wantEmail = category.channels.includes("email") && (pref ? pref.email : category.defaults.email);
          if (wantInApp) {
            await client.query(
              "INSERT INTO user_notifications (company_id, user_account_id, category, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)",
              [input.companyId, id, input.category, input.title.slice(0, 200), input.body?.slice(0, 1000) ?? null, input.link ?? null]
            );
          }
          if (wantEmail && emailOf.get(id)) emails.push({ to: emailOf.get(id)! });
        }
      });
      if (emails.length > 0 && this.mailer.isConfigured()) {
        const base = process.env.APP_BASE_URL ?? "http://localhost:5173";
        const text = [input.title, input.body ?? "", input.link ? `${base}${input.link}` : ""].filter(Boolean).join("\n\n");
        for (const e of emails) {
          await this.mailer.sendMail({ to: e.to, subject: input.title, text }).catch((err) => this.logger.warn(`Notification email failed: ${(err as Error).message}`));
        }
      }
    } catch (err) {
      this.logger.warn(`Could not notify: ${(err as Error).message}`);
    }
  }

  /** Login accounts of the company's HR Admins - the people an "waiting for HR" notice goes to. */
  async hrAdminUserIds(companyId: string): Promise<string[]> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const r = await client.query(
        `SELECT DISTINCT a.user_account_id FROM user_role_assignments a JOIN roles r ON r.id = a.role_id
          WHERE a.company_id = $1 AND r.key = 'hr_admin'`,
        [companyId]
      );
      return r.rows.map((x) => x.user_account_id as string);
    });
  }

  /** Of these people, the ones who switched EMAIL off for this category. */
  async emailOptedOut(userAccountIds: Array<string | null | undefined>, category: NotificationCategoryKey): Promise<Set<string>> {
    const ids = userAccountIds.filter((x): x is string => !!x);
    if (ids.length === 0) return new Set();
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const r = await client.query(
        "SELECT user_account_id FROM user_notification_preferences WHERE category = $1 AND email = false AND user_account_id = ANY($2::uuid[])",
        [category, ids]
      );
      return new Set(r.rows.map((x) => x.user_account_id as string));
    });
  }

  // ---- the signed-in person ---------------------------------------------------------------------------------------

  async inbox(claims: RequestClaims): Promise<UserNotificationInbox> {
    this.requireUser(claims);
    return this.db.withClaims(claims, async (client) => {
      const items = await client.query("SELECT * FROM user_notifications WHERE user_account_id = $1 ORDER BY created_at DESC LIMIT $2", [claims.sub, MAX_INBOX]);
      const unread = await client.query("SELECT COUNT(*)::int AS n FROM user_notifications WHERE user_account_id = $1 AND read_at IS NULL", [claims.sub]);
      return { items: items.rows.map(toView), unreadCount: unread.rows[0].n as number };
    });
  }

  /** Marks the given notifications (or all of them) as read. */
  async markRead(claims: RequestClaims, ids?: string[]): Promise<{ unreadCount: number }> {
    this.requireUser(claims);
    return this.db.withClaims(claims, async (client) => {
      if (ids && ids.length > 0) {
        await client.query("UPDATE user_notifications SET read_at = now() WHERE user_account_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])", [claims.sub, ids]);
      } else {
        await client.query("UPDATE user_notifications SET read_at = now() WHERE user_account_id = $1 AND read_at IS NULL", [claims.sub]);
      }
      const unread = await client.query("SELECT COUNT(*)::int AS n FROM user_notifications WHERE user_account_id = $1 AND read_at IS NULL", [claims.sub]);
      return { unreadCount: unread.rows[0].n as number };
    });
  }

  async getPreferences(claims: RequestClaims): Promise<NotificationPreferenceView[]> {
    this.requireUser(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT category, email, in_app FROM user_notification_preferences WHERE user_account_id = $1", [claims.sub]);
      const saved = new Map(r.rows.map((x) => [x.category as string, x]));
      return NOTIFICATION_CATEGORIES.map((c) => {
        const s = saved.get(c.key);
        return {
          category: c.key,
          label: c.label,
          description: c.description,
          channels: c.channels,
          email: c.channels.includes("email") ? (s ? s.email : c.defaults.email) : false,
          inApp: c.channels.includes("in_app") ? (s ? s.in_app : c.defaults.inApp) : false,
        };
      });
    });
  }

  async savePreferences(claims: RequestClaims, items: Array<{ category: string; email?: boolean; inApp?: boolean }>): Promise<NotificationPreferenceView[]> {
    this.requireUser(claims);
    for (const i of items) if (!categoryOf(i.category)) throw new BadRequestException(`Unknown notification type: ${i.category}`);
    await this.db.withClaims(claims, async (client) => {
      for (const i of items) {
        const c = categoryOf(i.category)!;
        const email = c.channels.includes("email") ? i.email ?? c.defaults.email : false;
        const inApp = c.channels.includes("in_app") ? i.inApp ?? c.defaults.inApp : false;
        await client.query(
          `INSERT INTO user_notification_preferences (user_account_id, category, email, in_app)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_account_id, category) DO UPDATE SET email = EXCLUDED.email, in_app = EXCLUDED.in_app, updated_at = now()`,
          [claims.sub, c.key, email, inApp]
        );
      }
    });
    return this.getPreferences(claims);
  }

  private requireUser(claims: RequestClaims): void {
    if (!claims.sub || !/^[0-9a-f-]{36}$/i.test(claims.sub)) throw new ForbiddenException();
  }
}
