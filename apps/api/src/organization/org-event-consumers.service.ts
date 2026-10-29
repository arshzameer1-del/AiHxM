import { ExclusiveCron } from "../common/cron-lock";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { WorkflowService } from "../workflow/workflow.service";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "org-event-consumer" };
const MAX_ATTEMPTS = 5;

type OrgEventRow = {
  id: string;
  company_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
};

export type OrgEventConsumer = {
  name: string;
  handles(eventType: string): boolean;
  handle(client: PoolClient, event: OrgEventRow): Promise<void>;
};

/**
 * Gap Register ORG-06 - what happens AFTER an organization change.
 *
 * Organization events (`org.unit.changed`, `org.position.changed`, ...) are
 * appended to the `domain_events` outbox by `WebhookDispatchService.enqueue()`.
 * This service is the in-process subscriber: a cron sweep (and a directly
 * callable `processPending()`) hands each unprocessed event to every consumer
 * that handles it, with a per-consumer idempotency receipt
 * (`event_consumer_receipts`, primary key consumer + event) written in the SAME
 * transaction as the consumer's effect - so an event is applied exactly once per
 * consumer, a failing consumer is retried (up to MAX_ATTEMPTS) without blocking
 * the others, and replays are harmless.
 *
 * Consumers (all idempotent):
 *  - workflow_approver_refresh: a manager / unit head / seat-holder change
 *    re-resolves the person behind still-pending approval lines.
 *  - denormalized_text_sync: renaming an org unit or a location refreshes the
 *    legacy free-text `employees.department` / `employees.location` copy and
 *    the department text on live requisitions (ORG-12).
 *
 * NOT consumers, by design: RBAC data scope and the manager hierarchy are read
 * live from `org_units` / `org_relationships` on every request - there is no
 * cache to invalidate, so a change is visible to authorisation immediately.
 */
@Injectable()
export class OrgEventConsumerService {
  private readonly logger = new Logger(OrgEventConsumerService.name);
  private running = false;
  readonly consumers: OrgEventConsumer[];

  constructor(
    private readonly db: DatabaseService,
    private readonly workflow?: WorkflowService
  ) {
    this.consumers = [
      {
        name: "workflow_approver_refresh",
        handles: (t) =>
          [
            "org.unit.changed",
            "org.position.changed",
            "org.assignment.changed",
            "org.relationship.changed",
            "org.reorganization.published",
          ].includes(t),
        handle: async (client, event) => {
          if (!this.workflow) return;
          await this.workflow.refreshDynamicApproversInTx(client, event.company_id);
        },
      },
      {
        name: "denormalized_text_sync",
        handles: (t) => ["org.unit.changed", "org.location.changed", "org.reorganization.published"].includes(t),
        handle: (client, event) => this.syncDenormalizedText(client, event),
      },
    ];
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @ExclusiveCron("OrgEventConsumerService.sweep")
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { processed, failed } = await this.processPending(200);
      if (processed > 0 || failed > 0) this.logger.log(`Org event consumers: ${processed} applied, ${failed} failed`);
    } catch (err) {
      this.logger.warn(`Org event consumer sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Applies every consumer to its unprocessed org events (oldest first). */
  async processPending(limit = 200, companyId?: string): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    for (const consumer of this.consumers) {
      const events = await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
        const r = await client.query<OrgEventRow>(
          `SELECT e.id, e.company_id, e.event_type, e.aggregate_type, e.aggregate_id, e.payload
             FROM domain_events e
            WHERE (e.event_type LIKE 'org.%') AND ($3::uuid IS NULL OR e.company_id = $3)
              AND NOT EXISTS (SELECT 1 FROM event_consumer_receipts r
                               WHERE r.consumer = $1 AND r.event_id = e.id AND (r.status = 'done' OR r.attempts >= $4))
            ORDER BY e.occurred_at, e.id LIMIT $2`,
          [consumer.name, limit, companyId ?? null, MAX_ATTEMPTS]
        );
        return r.rows;
      });
      for (const event of events) {
        if (!consumer.handles(event.event_type)) {
          // Not this consumer's concern: record it so it is never rescanned.
          await this.db.withClaims(SERVICE_CLAIMS, (client) => this.receipt(client, consumer.name, event, "done", null));
          continue;
        }
        try {
          await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
            await consumer.handle(client, event);
            await this.receipt(client, consumer.name, event, "done", null);
          });
          processed++;
        } catch (err) {
          failed++;
          await this.db.withClaims(SERVICE_CLAIMS, (client) =>
            this.receipt(client, consumer.name, event, "failed", (err as Error).message)
          );
        }
      }
    }
    return { processed, failed };
  }

  private async receipt(client: PoolClient, consumer: string, event: OrgEventRow, status: "done" | "failed", error: string | null): Promise<void> {
    await client.query(
      `INSERT INTO event_consumer_receipts (consumer, event_id, company_id, status, attempts, error)
       VALUES ($1, $2, $3, $4, 1, left($5, 2000))
       ON CONFLICT (consumer, event_id) DO UPDATE
         SET status = EXCLUDED.status, attempts = event_consumer_receipts.attempts + 1, error = EXCLUDED.error, processed_at = now()`,
      [consumer, event.id, event.company_id, status, error]
    );
  }

  /** Copies org unit / location names onto the legacy text columns that still
   * mirror them. Entity-scoped for a single-entity event, company-wide for a
   * reorganization. */
  private async syncDenormalizedText(client: PoolClient, event: OrgEventRow): Promise<void> {
    const scoped = event.event_type !== "org.reorganization.published";
    if (event.event_type !== "org.location.changed") {
      await client.query(
        `UPDATE employees e SET department = u.name, updated_at = now()
           FROM org_units u
          WHERE u.id = e.org_unit_id AND e.company_id = $1 AND e.department IS DISTINCT FROM u.name
            AND ($2::boolean = false OR u.id::text = $3)`,
        [event.company_id, scoped, event.aggregate_id]
      );
      await client.query(
        `UPDATE job_requisitions r SET department = u.name, updated_at = now()
           FROM org_units u
          WHERE u.id = r.org_unit_id AND r.company_id = $1 AND r.department IS DISTINCT FROM u.name
            AND r.status IN ('draft', 'pending_approval', 'approved', 'open', 'on_hold')
            AND ($2::boolean = false OR u.id::text = $3)`,
        [event.company_id, scoped, event.aggregate_id]
      );
    }
    if (event.event_type !== "org.unit.changed") {
      await client.query(
        `UPDATE employees e SET location = l.name, updated_at = now()
           FROM locations l
          WHERE l.id = e.location_id AND e.company_id = $1 AND e.location IS DISTINCT FROM l.name
            AND ($2::boolean = false OR l.id::text = $3)`,
        [event.company_id, scoped, event.aggregate_id]
      );
    }
  }
}
