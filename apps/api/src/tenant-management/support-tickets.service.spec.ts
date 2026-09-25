import { Pool } from "pg";
import { SupportTicketsService } from "./support-tickets.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MailerService } from "../mailer/mailer.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "support-sla-spec" };

/**
 * Tenant Management gap-fill Phase 1 item #9 — Support ticket SLA basics.
 * `dueBy`/`slaBreached` are computed in toTicket() from `createdAt` +
 * SLA_HOURS_BY_PRIORITY, not stored — these tests plant a ticket with a
 * backdated `created_at` (there's no API surface to fake "time has
 * passed" otherwise) and confirm the computed fields react correctly.
 */
describe("SupportTicketsService — SLA basics", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: SupportTicketsService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new SupportTicketsService(db, new AuditService(), new NotificationsService(db, new MailerService()));

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Support SLA Spec Co ${stamp}`,
        `support-sla-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  async function backdateTicket(ticketId: string, hoursAgo: number): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE support_tickets SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1", [
        ticketId,
        String(hoursAgo),
      ])
    );
  }

  it("sets dueBy 4 hours out for an urgent ticket, and not yet breached when fresh", async () => {
    const ticket = await service.create(FIXTURE_CLAIMS, companyId, {
      subject: "Fresh urgent",
      description: "Just filed",
      priority: "urgent",
    });

    const expectedDueBy = new Date(ticket.createdAt).getTime() + 4 * 60 * 60 * 1000;
    expect(new Date(ticket.dueBy).getTime()).toBe(expectedDueBy);
    expect(ticket.slaBreached).toBe(false);
  });

  it("sets dueBy 120 hours out for a low-priority ticket", async () => {
    const ticket = await service.create(FIXTURE_CLAIMS, companyId, {
      subject: "Low priority",
      description: "Whenever",
      priority: "low",
    });

    const expectedDueBy = new Date(ticket.createdAt).getTime() + 120 * 60 * 60 * 1000;
    expect(new Date(ticket.dueBy).getTime()).toBe(expectedDueBy);
  });

  it("marks an open ticket as breached once its priority's SLA window has passed", async () => {
    const ticket = await service.create(FIXTURE_CLAIMS, companyId, {
      subject: "Aging urgent ticket",
      description: "Should breach",
      priority: "urgent",
    });
    await backdateTicket(ticket.id, 5); // urgent SLA is 4 hours

    const found = (await service.list(FIXTURE_CLAIMS, companyId, {})).find((t) => t.id === ticket.id)!;
    expect(found.slaBreached).toBe(true);
  });

  it("never reports a resolved ticket as breached, no matter how old", async () => {
    const ticket = await service.create(FIXTURE_CLAIMS, companyId, {
      subject: "Old but resolved",
      description: "Resolved late, but resolved",
      priority: "urgent",
    });
    await backdateTicket(ticket.id, 100);
    await service.update(FIXTURE_CLAIMS, companyId, ticket.id, { status: "resolved" });

    const found = (await service.list(FIXTURE_CLAIMS, companyId, {})).find((t) => t.id === ticket.id)!;
    expect(found.status).toBe("resolved");
    expect(found.slaBreached).toBe(false);
  });

  it("does not report a fresh high-priority ticket as breached", async () => {
    const ticket = await service.create(FIXTURE_CLAIMS, companyId, {
      subject: "Fresh high",
      description: "Just filed",
      priority: "high",
    });
    expect(ticket.slaBreached).toBe(false);
  });
});
