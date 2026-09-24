import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import type { RequestClaims } from "../database/tenant-context";
import type { SupportTicket, SupportTicketPriority, SupportTicketStatus } from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTicket(row: any): SupportTicket {
  return {
    id: row.id,
    companyId: row.company_id,
    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,
    createdBy: row.created_by,
    assignee: row.assignee ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// TM-033 — Support tickets.
@Injectable()
export class SupportTicketsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService
  ) {}

  async list(
    claims: RequestClaims,
    companyId: string,
    filters: { status?: SupportTicketStatus } = {}
  ): Promise<SupportTicket[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");

      const conditions = ["company_id = $1"];
      const params: unknown[] = [companyId];
      if (filters.status) {
        params.push(filters.status);
        conditions.push(`status = $${params.length}`);
      }
      const result = await client.query(
        `SELECT * FROM support_tickets WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
        params
      );
      return result.rows.map(toTicket);
    });
  }

  async create(
    claims: RequestClaims,
    companyId: string,
    dto: { subject: string; description: string; priority?: SupportTicketPriority }
  ): Promise<SupportTicket> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id, name FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");

      const result = await client.query(
        `INSERT INTO support_tickets (company_id, subject, description, priority, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [companyId, dto.subject, dto.description, dto.priority ?? "normal", claims.sub]
      );
      const ticket = toTicket(result.rows[0]);

      await this.audit.record(client, claims, {
        companyId,
        action: "support_ticket.created",
        target: ticket.id,
        metadata: { subject: ticket.subject, priority: ticket.priority },
      });

      // Ticket confirmation — fire-and-forget so a slow/broken mail provider
      // never blocks or fails the ticket creation itself.
      this.notifications
        .dispatch(
          { ...claims, company_id: companyId },
          {
            channel: "email",
            recipient: "platform-support@aihxm.internal",
            templateKey: "support_ticket_created",
            payload: { ticketId: ticket.id, companyName: companyCheck.rows[0].name, subject: ticket.subject },
          }
        )
        .catch(() => undefined);

      return ticket;
    });
  }

  async update(
    claims: RequestClaims,
    companyId: string,
    ticketId: string,
    patch: { status?: SupportTicketStatus; priority?: SupportTicketPriority; assignee?: string | null }
  ): Promise<SupportTicket> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM support_tickets WHERE id = $1 AND company_id = $2", [
        ticketId,
        companyId,
      ]);
      if (existing.rowCount === 0) throw new NotFoundException("Support ticket not found");

      const result = await client.query(
        `UPDATE support_tickets
         SET status = COALESCE($3, status),
             priority = COALESCE($4, priority),
             assignee = CASE WHEN $5 THEN $6 ELSE assignee END,
             updated_at = now()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [ticketId, companyId, patch.status ?? null, patch.priority ?? null, patch.assignee !== undefined, patch.assignee ?? null]
      );
      const ticket = toTicket(result.rows[0]);

      await this.audit.record(client, claims, {
        companyId,
        action: "support_ticket.updated",
        target: ticket.id,
        metadata: { status: ticket.status, priority: ticket.priority, assignee: ticket.assignee },
      });

      return ticket;
    });
  }
}
