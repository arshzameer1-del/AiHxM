import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { MailerService } from "../mailer/mailer.service";
import { incrementDailyUsage } from "../tenant-management/usage-tracking.util";
import { renderEmailTemplate } from "./email-templates";
import type { DispatchNotificationRequest, NotificationLogEntry } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntry(row: any): NotificationLogEntry {
  return {
    id: row.id,
    companyId: row.company_id,
    channel: row.channel,
    recipient: row.recipient,
    templateKey: row.template_key,
    payload: row.payload ?? {},
    status: row.status,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Plan doc Section 6's "Interfaces" WRICEF pillar, notification-dispatch
 * half. Originally deliberately just logging, per the plan doc's own
 * wording ("even if only logged/stubbed against a real provider") — as
 * of 2026-09-18, real delivery is wired in for the `email` channel via
 * the shared `MailerService`, exactly the extension point this class's
 * own prior comment anticipated ("adding a send step after the INSERT
 * and updating `status`, not changing this interface"). When
 * `MailerService.isConfigured()` is false (no `SMTP_HOST` set — true of
 * every dev/test environment by default), behavior is byte-for-byte
 * identical to before: a `logged` row, nothing sent, matching every
 * existing test's expectations. `whatsapp`/`push`/`in_app` remain
 * logged-only — no provider exists for any of them yet, and this
 * increment's scope is closing the specific "no real email delivery"
 * gap KNOWN_ISSUES.md and the roadmap both flagged as urgent post-launch,
 * not building three more provider integrations speculatively.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mailer: MailerService
  ) {}

  async dispatch(claims: RequestClaims, dto: DispatchNotificationRequest): Promise<NotificationLogEntry> {
    if (!claims.company_id) throw new ForbiddenException();
    const logged = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO notification_log (company_id, channel, recipient, template_key, payload, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'logged')
         RETURNING *`,
        [claims.company_id, dto.channel, dto.recipient, dto.templateKey, JSON.stringify(dto.payload ?? {})]
      );
      return toEntry(result.rows[0]);
    });

    if (dto.channel !== "email" || !this.mailer.isConfigured()) {
      return logged;
    }

    // A delivery failure never throws out of dispatch() — the caller
    // asked for a notification to be queued, and that already succeeded
    // (the `logged` row above); whether the real send behind it worked
    // is reflected in `status`, not in whether this call resolves.
    const finalStatus = await this.attemptEmailDelivery(claims, logged);
    return { ...logged, status: finalStatus };
  }

  private async attemptEmailDelivery(claims: RequestClaims, entry: NotificationLogEntry): Promise<"sent" | "failed"> {
    const rendered = renderEmailTemplate(entry.templateKey, entry.payload);
    let status: "sent" | "failed";
    try {
      await this.mailer.sendMail({ to: entry.recipient, subject: rendered.subject, text: rendered.text });
      status = "sent";
      // TM-027 Usage dashboard's real email counter.
      await incrementDailyUsage(this.db, entry.companyId, "email_sent_count");
    } catch (err) {
      this.logger.warn(`Notification ${entry.id} (${entry.templateKey} -> ${entry.recipient}) failed to send: ${(err as Error).message}`);
      status = "failed";
    }
    await this.db.withClaims(claims, async (client) => {
      await client.query("UPDATE notification_log SET status = $2 WHERE id = $1", [entry.id, status]);
    });
    return status;
  }

  async list(claims: RequestClaims, limit = 100): Promise<NotificationLogEntry[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM notification_log WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [claims.company_id, Math.min(limit, 500)]
      );
      return result.rows.map(toEntry);
    });
  }
}
