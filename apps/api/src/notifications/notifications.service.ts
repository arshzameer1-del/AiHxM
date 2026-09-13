import { ForbiddenException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { DispatchNotificationRequest, NotificationLogEntry } from "@boostfactor/shared-types";

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
 * half — deliberately just logging for now, per the plan doc's own
 * wording ("even if only logged/stubbed against a real provider"). This
 * is the entire implementation: dispatch() writes a row and returns it.
 * Wiring a real email/WhatsApp/push provider later means adding a send
 * step after the INSERT and updating `status`, not changing this
 * interface — see KNOWN_ISSUES.md.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  async dispatch(claims: RequestClaims, dto: DispatchNotificationRequest): Promise<NotificationLogEntry> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO notification_log (company_id, channel, recipient, template_key, payload, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'logged')
         RETURNING *`,
        [claims.company_id, dto.channel, dto.recipient, dto.templateKey, JSON.stringify(dto.payload ?? {})]
      );
      return toEntry(result.rows[0]);
    });
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
