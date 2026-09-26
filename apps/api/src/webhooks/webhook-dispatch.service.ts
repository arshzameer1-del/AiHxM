import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { createHmac } from "crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { WebhookEvent } from "@aihxm/shared-types";

// No real user session is behind either the sweep tick or a business-event
// enqueue() call (a controller's HTTP request claims aren't available from
// deep inside e.g. EmployeesService.create()) — same posture, and same
// fixed `sub`-per-concern convention, as CompaniesLifecycleScheduler's
// SWEEP_CLAIMS and usage-tracking.util.ts's SERVICE_CLAIMS.
const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "webhook-dispatch" };

// A dead-lettered event has failed this many times and will not be
// retried automatically again — only a manual replay() re-queues it.
const MAX_ATTEMPTS = 5;

// Backoff after the Nth failed attempt (1-indexed) before the next retry.
// Index 0 is used after the 1st failure, index 4 (the last) after the
// 5th — which is also MAX_ATTEMPTS, so that 5th failure dead-letters the
// row instead of consulting this array at all. Chosen to fail fast on a
// transient blip (1 minute) while not hammering an endpoint that's been
// down for a while (topping out at 12 hours) — proportionate for "basic
// webhook delivery", not tuned against any real customer's SLA.
const BACKOFF_SCHEDULE_MS = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  30 * 60_000, // 30 minutes
  2 * 60 * 60_000, // 2 hours
  12 * 60 * 60_000, // 12 hours
];

const SWEEP_BATCH_LIMIT = 50;
const DELIVERY_TIMEOUT_MS = 10_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toWebhookEvent(row: any): WebhookEvent {
  return {
    id: row.id,
    companyId: row.company_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    lastError: row.last_error,
    lastResponseStatus: row.last_response_status,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
  };
}

/**
 * Reads the ONE piece of config that matters for delivery — `config.url`
 * (the target endpoint) and `config.signingSecret` (what signs every
 * delivery). `config.url` reuses the field key the Integrations tab's
 * webhook config form already had sitting unused (see migration 0061's
 * header comment) rather than a second, differently-named field for the
 * same concept. Returns null for "nothing to deliver to" — not enabled,
 * not configured, or configured with only one of the two fields — so
 * every caller has exactly one thing to check.
 */
async function loadWebhookTarget(
  client: Pick<PoolClient, "query">,
  companyId: string
): Promise<{ url: string; signingSecret: string } | null> {
  const result = await client.query(
    `SELECT config FROM tenant_integrations WHERE company_id = $1 AND provider_key = 'webhook' AND enabled = true`,
    [companyId]
  );
  if (result.rowCount === 0) return null;
  const config = result.rows[0].config ?? {};
  const url: unknown = config.url;
  const signingSecret: unknown = config.signingSecret;
  if (typeof url !== "string" || !url || typeof signingSecret !== "string" || !signingSecret) return null;
  return { url, signingSecret };
}

/**
 * Phase 3 item #4 — Webhooks & Eventing. Real outbound delivery for the
 * `webhook` integration `tenant_integrations` has had a config row for
 * since Phase 1 (TM-031) but never anything that actually sent to it. See
 * migration 0061_webhook_event_delivery.sql's header comment for the full
 * design (queue table, backoff schedule, dead-lettering) — this class is
 * just that design made executable.
 *
 * Lives in its own small module (`WebhooksModule`) rather than inside
 * `TenantManagementModule`, specifically so a non-Tenant-Management
 * domain module (`EmployeesModule`) can import this one service without
 * pulling in TenantManagementModule's unrelated providers or risking a
 * circular import — see `webhooks.module.ts`'s own doc comment.
 */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  /**
   * Queues one event for delivery. Deliberately never throws for "nothing
   * to deliver to" — a tenant that hasn't configured (or hasn't enabled)
   * its webhook integration is the overwhelmingly common case, and every
   * call site (an employee-created event, a termination event, ...) would
   * otherwise need to duplicate this exact check before calling. Genuine
   * unexpected failures (e.g. the database is down) still propagate —
   * this is a no-op on "not configured", not a swallow-everything.
   */
  async enqueue(companyId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const target = await loadWebhookTarget(client, companyId);
      if (!target) return;
      await client.query(
        `INSERT INTO webhook_events (company_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
        [companyId, eventType, JSON.stringify(payload)]
      );
    });
  }

  /**
   * The one background sweep this feature needs — same shape as
   * `CompaniesLifecycleScheduler`'s cron sweep (a plain `@nestjs/schedule`
   * tick wrapping a directly-testable method; no job queue in this
   * codebase). Every minute is frequent enough that the 1-minute first
   * backoff step actually means "about a minute", without polling so
   * often it meaningfully loads the database between real deliveries.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleDeliverySweep(): Promise<void> {
    const due = await this.db.withClaims(SERVICE_CLAIMS, (client) =>
      client.query(
        `SELECT * FROM webhook_events
         WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         LIMIT $1`,
        [SWEEP_BATCH_LIMIT]
      )
    );
    let delivered = 0;
    let deadLettered = 0;
    for (const row of due.rows) {
      const outcome = await this.attemptDelivery(row);
      if (outcome === "delivered") delivered++;
      if (outcome === "dead_letter") deadLettered++;
    }
    if (delivered > 0 || deadLettered > 0) {
      this.logger.log(`Webhook sweep: ${delivered} delivered, ${deadLettered} dead-lettered (of ${due.rowCount} due).`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async attemptDelivery(row: any): Promise<"delivered" | "failed" | "dead_letter"> {
    const target = await this.db.withClaims(SERVICE_CLAIMS, (client) => loadWebhookTarget(client, row.company_id));
    if (!target) {
      // The integration was disabled/reconfigured after this event was
      // queued — there is nowhere left to send it, and it will never
      // regain a target on its own, so stop retrying rather than
      // rescheduling forever.
      await this.markDeadLetter(row.id, "Webhook integration is disabled or no longer configured.");
      return "dead_letter";
    }

    const body = JSON.stringify(row.payload);
    const signature = createHmac("sha256", target.signingSecret).update(body).digest("hex");

    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AIHXM-Signature": `sha256=${signature}`,
          "X-AIHXM-Event": row.event_type,
          "X-AIHXM-Delivery": row.id,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (response.ok) {
        await this.markDelivered(row.id, response.status);
        return "delivered";
      }
      return this.markFailedOrDeadLetter(row, `Endpoint responded HTTP ${response.status}`, response.status);
    } catch (err) {
      return this.markFailedOrDeadLetter(row, (err as Error).message, null);
    }
  }

  private async markDelivered(eventId: string, responseStatus: number): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, (client) =>
      client.query(
        `UPDATE webhook_events
         SET status = 'delivered', attempt_count = attempt_count + 1, delivered_at = now(),
             last_response_status = $2, last_error = NULL
         WHERE id = $1`,
        [eventId, responseStatus]
      )
    );
  }

  private async markFailedOrDeadLetter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any,
    errorMessage: string,
    responseStatus: number | null
  ): Promise<"failed" | "dead_letter"> {
    const nextAttemptCount = row.attempt_count + 1;
    if (nextAttemptCount >= MAX_ATTEMPTS) {
      await this.db.withClaims(SERVICE_CLAIMS, (client) =>
        client.query(
          `UPDATE webhook_events
           SET status = 'dead_letter', attempt_count = $2, last_error = $3, last_response_status = $4
           WHERE id = $1`,
          [row.id, nextAttemptCount, errorMessage, responseStatus]
        )
      );
      return "dead_letter";
    }
    const backoffMs = BACKOFF_SCHEDULE_MS[nextAttemptCount - 1] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
    await this.db.withClaims(SERVICE_CLAIMS, (client) =>
      client.query(
        `UPDATE webhook_events
         SET status = 'failed', attempt_count = $2, last_error = $3, last_response_status = $4,
             next_attempt_at = now() + make_interval(secs => $5)
         WHERE id = $1`,
        [row.id, nextAttemptCount, errorMessage, responseStatus, backoffMs / 1000]
      )
    );
    return "failed";
  }

  private async markDeadLetter(eventId: string, errorMessage: string): Promise<void> {
    await this.db.withClaims(SERVICE_CLAIMS, (client) =>
      client.query(
        `UPDATE webhook_events SET status = 'dead_letter', last_error = $2 WHERE id = $1`,
        [eventId, errorMessage]
      )
    );
  }

  /** Admin-facing delivery log — most recent first. */
  async list(claims: RequestClaims, companyId: string, opts?: { limit?: number }): Promise<WebhookEvent[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");

      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
      const result = await client.query(
        `SELECT * FROM webhook_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [companyId, limit]
      );
      return result.rows.map(toWebhookEvent);
    });
  }

  /**
   * Manual replay — resets a `failed`/`dead_letter` row back to `pending`
   * with a clean attempt count, so the very next sweep tick (at most a
   * minute away) picks it up as if newly queued. No step-up requirement,
   * unlike `IntegrationsService.rotateSecret()`: replaying a delivery
   * cannot expose or issue a credential, it can only re-send data the
   * tenant's own endpoint already legitimately expects to receive.
   */
  async replay(claims: RequestClaims, companyId: string, eventId: string): Promise<WebhookEvent> {
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(`SELECT * FROM webhook_events WHERE id = $1 AND company_id = $2`, [
        eventId,
        companyId,
      ]);
      if (existing.rowCount === 0) throw new NotFoundException("Webhook event not found");
      if (!["failed", "dead_letter"].includes(existing.rows[0].status)) {
        throw new BadRequestException(`Cannot replay an event that is currently '${existing.rows[0].status}'.`);
      }

      const updated = await client.query(
        `UPDATE webhook_events
         SET status = 'pending', attempt_count = 0, next_attempt_at = now(), last_error = NULL, last_response_status = NULL
         WHERE id = $1
         RETURNING *`,
        [eventId]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "webhook_event.replayed",
        target: eventId,
        metadata: { eventType: updated.rows[0].event_type },
      });

      return toWebhookEvent(updated.rows[0]);
    });
  }

  /**
   * Enqueues a synthetic `test` event immediately, so an admin can verify
   * a freshly-typed URL/secret actually works. Unlike `enqueue()`, this
   * throws when nothing is configured — a caller explicitly clicking
   * "Send test event" wants to know why nothing happened, not a silent
   * no-op.
   */
  async sendTestEvent(claims: RequestClaims, companyId: string): Promise<WebhookEvent> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) throw new NotFoundException("Company not found");

      const target = await loadWebhookTarget(client, companyId);
      if (!target) {
        throw new BadRequestException(
          "Enable the webhook integration with a target URL and signing secret before sending a test event."
        );
      }

      const inserted = await client.query(
        `INSERT INTO webhook_events (company_id, event_type, payload)
         VALUES ($1, 'test', $2::jsonb)
         RETURNING *`,
        [companyId, JSON.stringify({ message: "This is a test event from AIHXM.", sentAt: new Date().toISOString() })]
      );
      return toWebhookEvent(inserted.rows[0]);
    });
  }
}
