import { createServer, type IncomingMessage, type Server } from "http";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { WebhookDispatchService } from "./webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "webhook-dispatch-spec" };

/** Spins up a plain Node HTTP server on an ephemeral port — no new dependency needed for a fake delivery target. */
function startMockServer(
  handler: (req: IncomingMessage, body: string) => { status: number }
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const { status } = handler(req, body);
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Phase 3 item #4 — Webhooks & Eventing. Covers `enqueue()`'s no-op vs.
 * real-row behavior, a real HTTP round trip (success and failure) driving
 * the sweep's status/backoff transitions all the way to `dead_letter`,
 * the HMAC signature itself, and `replay()`.
 */
describe("WebhookDispatchService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: WebhookDispatchService;
  let integrations: IntegrationsService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new WebhookDispatchService(db, new AuditService());
    integrations = new IntegrationsService(db, new AuditService());

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Webhook Dispatch Spec Co ${stamp}`,
        `webhook-dispatch-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  afterEach(async () => {
    // Every test starts from a clean queue — order/count assertions below
    // would otherwise see rows earlier tests in this file left behind.
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM webhook_events WHERE company_id = $1", [companyId]));
  });

  async function eventRow(eventId: string) {
    const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT * FROM webhook_events WHERE id = $1", [eventId])
    );
    return result.rows[0];
  }

  describe("enqueue()", () => {
    it("no-ops (creates no row) when the webhook integration isn't configured at all", async () => {
      const freshCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const stamp = Date.now();
        const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
          `Webhook Unconfigured Spec Co ${stamp}`,
          `webhook-unconfigured-spec-${stamp}`,
        ]);
        return result.rows[0].id as string;
      });

      await service.enqueue(freshCompanyId, "employee.created", { hello: "world" });

      const rows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT * FROM webhook_events WHERE company_id = $1", [freshCompanyId])
      );
      expect(rows.rowCount).toBe(0);

      await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [freshCompanyId]));
    });

    it("no-ops when the webhook integration is configured but disabled", async () => {
      await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
        enabled: false,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "whatever" },
      });

      await service.enqueue(companyId, "employee.created", { hello: "world" });

      const rows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT * FROM webhook_events WHERE company_id = $1", [companyId])
      );
      expect(rows.rowCount).toBe(0);
    });

    it("no-ops when enabled but missing a target url or signing secret", async () => {
      await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
        enabled: true,
        config: { url: "", signingSecret: "" },
      });
      await service.enqueue(companyId, "employee.created", { hello: "world" });
      const rows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT * FROM webhook_events WHERE company_id = $1", [companyId])
      );
      expect(rows.rowCount).toBe(0);
    });

    it("creates a real pending row when the integration is enabled and fully configured", async () => {
      await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "test-signing-secret" },
      });

      await service.enqueue(companyId, "employee.created", { employeeId: "abc-123" });

      const list = await service.list(FIXTURE_CLAIMS, companyId);
      expect(list).toHaveLength(1);
      expect(list[0].eventType).toBe("employee.created");
      expect(list[0].status).toBe("pending");
      expect(list[0].attemptCount).toBe(0);
      expect(list[0].payload).toEqual({ employeeId: "abc-123" });
    });
  });

  describe("delivery sweep", () => {
    it("delivers successfully against a real HTTP server, marking the event delivered, with a verifiable HMAC signature", async () => {
      const signingSecret = "sweep-success-secret";
      let receivedSignature: string | null = null;
      let receivedEventHeader: string | null = null;
      let receivedBody = "";
      const { server, url } = await startMockServer((req, body) => {
        receivedSignature = req.headers["x-aihxm-signature"] as string;
        receivedEventHeader = req.headers["x-aihxm-event"] as string;
        receivedBody = body;
        return { status: 200 };
      });

      try {
        await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
          enabled: true,
          config: { url, signingSecret },
        });
        await service.enqueue(companyId, "employee.created", { employeeId: "sweep-success" });

        await service.handleDeliverySweep();

        const list = await service.list(FIXTURE_CLAIMS, companyId);
        const delivered = list.find((e) => e.eventType === "employee.created");
        expect(delivered).toBeDefined();
        expect(delivered!.status).toBe("delivered");
        expect(delivered!.attemptCount).toBe(1);
        expect(delivered!.lastResponseStatus).toBe(200);
        expect(delivered!.deliveredAt).not.toBeNull();

        expect(receivedEventHeader).toBe("employee.created");
        const expectedSignature = `sha256=${createHmac("sha256", signingSecret).update(receivedBody).digest("hex")}`;
        expect(receivedSignature).toBe(expectedSignature);
        expect(JSON.parse(receivedBody)).toEqual({ employeeId: "sweep-success" });
      } finally {
        await closeServer(server);
      }
    });

    it("retries with backoff on a failing response, then dead-letters after MAX_ATTEMPTS", async () => {
      let requestCount = 0;
      const { server, url } = await startMockServer(() => {
        requestCount++;
        return { status: 500 };
      });

      try {
        await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
          enabled: true,
          config: { url, signingSecret: "sweep-failure-secret" },
        });
        await service.enqueue(companyId, "employee.terminated", { employeeId: "sweep-failure" });
        const list = await service.list(FIXTURE_CLAIMS, companyId);
        const eventId = list[0].id;

        // 1st attempt: real HTTP round trip through the sweep -> failed, backoff scheduled.
        await service.handleDeliverySweep();
        let row = await eventRow(eventId);
        expect(row.status).toBe("failed");
        expect(row.attempt_count).toBe(1);
        expect(row.last_response_status).toBe(500);
        expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

        // A sweep run immediately after does nothing more — the row isn't
        // due yet (next_attempt_at is in the future), proving the sweep
        // actually respects backoff rather than hammering the endpoint.
        await service.handleDeliverySweep();
        expect(requestCount).toBe(1);

        // Fast-forward through attempts 2-4 by manipulating next_attempt_at
        // directly (this is what the task's own testing guidance calls
        // out as the normal way to test backoff without really waiting
        // through real multi-hour windows).
        for (let i = 0; i < 3; i++) {
          await db.withClaims(FIXTURE_CLAIMS, (client) =>
            client.query("UPDATE webhook_events SET next_attempt_at = now() WHERE id = $1", [eventId])
          );
          await service.handleDeliverySweep();
        }
        row = await eventRow(eventId);
        expect(row.status).toBe("failed");
        expect(row.attempt_count).toBe(4);

        // 5th attempt (MAX_ATTEMPTS) dead-letters instead of scheduling a 6th retry.
        await db.withClaims(FIXTURE_CLAIMS, (client) =>
          client.query("UPDATE webhook_events SET next_attempt_at = now() WHERE id = $1", [eventId])
        );
        await service.handleDeliverySweep();
        row = await eventRow(eventId);
        expect(row.status).toBe("dead_letter");
        expect(row.attempt_count).toBe(5);
        expect(requestCount).toBe(5);

        // A 6th sweep tick leaves it alone — dead_letter is a terminal
        // status the sweep never selects.
        await db.withClaims(FIXTURE_CLAIMS, (client) =>
          client.query("UPDATE webhook_events SET next_attempt_at = now() WHERE id = $1", [eventId])
        );
        await service.handleDeliverySweep();
        expect(requestCount).toBe(5);
      } finally {
        await closeServer(server);
      }
    });

    it("dead-letters immediately (without an HTTP call) once the integration has been disabled after enqueue", async () => {
      const { server, url } = await startMockServer(() => ({ status: 200 }));
      try {
        await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
          enabled: true,
          config: { url, signingSecret: "disabled-mid-flight-secret" },
        });
        await service.enqueue(companyId, "employee.created", { employeeId: "disabled-mid-flight" });
        const list = await service.list(FIXTURE_CLAIMS, companyId);
        const eventId = list[0].id;

        await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", { enabled: false });
        await service.handleDeliverySweep();

        const row = await eventRow(eventId);
        expect(row.status).toBe("dead_letter");
        expect(row.last_error).toContain("no longer configured");
      } finally {
        await closeServer(server);
      }
    });
  });

  describe("replay()", () => {
    it("resets a dead-lettered event back to pending with a clean attempt count", async () => {
      await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "replay-secret" },
      });
      const inserted = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          `INSERT INTO webhook_events (company_id, event_type, payload, status, attempt_count, last_error, last_response_status)
           VALUES ($1, 'employee.terminated', '{}'::jsonb, 'dead_letter', 5, 'boom', 500) RETURNING id`,
          [companyId]
        )
      );
      const eventId = inserted.rows[0].id;

      const replayed = await service.replay(FIXTURE_CLAIMS, companyId, eventId);
      expect(replayed.status).toBe("pending");
      expect(replayed.attemptCount).toBe(0);
      expect(replayed.lastError).toBeNull();
      expect(replayed.lastResponseStatus).toBeNull();

      const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT * FROM audit_log WHERE company_id = $1 AND action = 'webhook_event.replayed' AND target = $2", [
          companyId,
          eventId,
        ])
      );
      expect(auditRows.rowCount).toBe(1);
    });

    it("rejects replaying an event that is still pending", async () => {
      await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "replay-secret-2" },
      });
      await service.enqueue(companyId, "employee.created", {});
      const list = await service.list(FIXTURE_CLAIMS, companyId);
      await expect(service.replay(FIXTURE_CLAIMS, companyId, list[0].id)).rejects.toThrow(BadRequestException);
    });

    it("404s for an event id that doesn't exist", async () => {
      await expect(
        service.replay(FIXTURE_CLAIMS, companyId, "00000000-0000-0000-0000-000000000000")
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("sendTestEvent()", () => {
    it("rejects when the integration isn't configured", async () => {
      const freshCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const stamp = Date.now();
        const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
          `Webhook Test-Event Spec Co ${stamp}`,
          `webhook-test-event-spec-${stamp}`,
        ]);
        return result.rows[0].id as string;
      });
      await expect(service.sendTestEvent(FIXTURE_CLAIMS, freshCompanyId)).rejects.toThrow(BadRequestException);
      await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [freshCompanyId]));
    });

    it("queues a synthetic test event immediately when configured", async () => {
      await integrations.configure(FIXTURE_CLAIMS, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "test-event-secret" },
      });
      const event = await service.sendTestEvent(FIXTURE_CLAIMS, companyId);
      expect(event.eventType).toBe("test");
      expect(event.status).toBe("pending");
    });
  });
});
