import { Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import { currentCorrelationId } from "../common/request-context";
import { eventTypeMatches, redactPayload } from "./payload-redaction";

export type DomainEvent = {
  id: string;
  companyId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  causationId: string | null;
  actor: string | null;
  occurredAt: string;
};

export type EventSubscription = {
  id: string;
  companyId: string;
  name: string;
  eventPatterns: string[];
  targetKind: "webhook" | "internal";
  targetUrl: string | null;
  status: "active" | "paused" | "disabled";
  secretVersion: number;
  maxAttempts: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(r: any): DomainEvent {
  return {
    id: r.id,
    companyId: r.company_id,
    eventType: r.event_type,
    schemaVersion: r.schema_version,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    payload: r.payload,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    actor: r.actor,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSubscription(r: any): EventSubscription {
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    eventPatterns: r.event_patterns,
    targetKind: r.target_kind,
    targetUrl: r.target_url,
    status: r.status,
    secretVersion: r.secret_version,
    maxAttempts: r.max_attempts,
  };
}

/** 30s, 60s, 2m ... capped at 6h. */
export function deliveryBackoffSeconds(attemptCount: number): number {
  return Math.min(30 * 2 ** Math.max(attemptCount - 1, 0), 6 * 3600);
}

/**
 * Gap Register PLT-04 — transactional outbox. `publish()` MUST be called on
 * the same client/transaction as the state change it announces: the event
 * (and its per-subscription delivery rows) commit or roll back together with
 * the change. Delivery to subscribers is asynchronous (a worker on
 * background_jobs / the existing webhook dispatcher consumes
 * event_deliveries), so a slow or dead subscriber can never fail or slow
 * the business transaction.
 */
@Injectable()
export class DomainEventsService {
  async publish(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      companyId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      aggregateVersion?: number;
      /** Payload schema version (defaults to 1); bump when a payload field is removed or changes meaning. */
      schemaVersion?: number;
      payload?: Record<string, unknown>;
      causationId?: string;
      correlationId?: string;
    }
  ): Promise<DomainEvent> {
    const r = await client.query(
      `INSERT INTO domain_events
         (company_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id, causation_id, actor, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING *`,
      [
        input.companyId,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        input.aggregateVersion ?? null,
        JSON.stringify(redactPayload(input.payload ?? {})),
        input.correlationId ?? currentCorrelationId(),
        input.causationId ?? null,
        claims.sub,
        input.schemaVersion ?? 1,
      ]
    );
    const event = toEvent(r.rows[0]);

    // Fan out to every active subscription whose pattern matches.
    const subs = await client.query(
      "SELECT id, event_patterns FROM event_subscriptions WHERE company_id = $1 AND status = 'active'",
      [input.companyId]
    );
    for (const sub of subs.rows) {
      if ((sub.event_patterns as string[]).some((p) => eventTypeMatches(p, input.eventType))) {
        await client.query(
          `INSERT INTO event_deliveries (company_id, event_id, subscription_id)
           VALUES ($1, $2, $3) ON CONFLICT (event_id, subscription_id) DO NOTHING`,
          [input.companyId, event.id, sub.id]
        );
      }
    }
    return event;
  }

  async createSubscription(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      companyId: string;
      name: string;
      eventPatterns: string[];
      targetKind?: "webhook" | "internal";
      targetUrl?: string;
      maxAttempts?: number;
    }
  ): Promise<EventSubscription> {
    const r = await client.query(
      `INSERT INTO event_subscriptions (company_id, name, event_patterns, target_kind, target_url, max_attempts, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        input.companyId,
        input.name,
        input.eventPatterns,
        input.targetKind ?? "webhook",
        input.targetUrl ?? null,
        input.maxAttempts ?? 8,
        claims.sub,
      ]
    );
    return toSubscription(r.rows[0]);
  }

  async listSubscriptions(client: PoolClient, companyId: string): Promise<EventSubscription[]> {
    const r = await client.query("SELECT * FROM event_subscriptions WHERE company_id = $1 ORDER BY name", [companyId]);
    return r.rows.map(toSubscription);
  }

  /** Bumps the signing-secret version (rotation); old signatures stay verifiable by version. */
  async rotateSecretVersion(client: PoolClient, subscriptionId: string): Promise<number> {
    const r = await client.query(
      "UPDATE event_subscriptions SET secret_version = secret_version + 1, updated_at = now() WHERE id = $1 RETURNING secret_version",
      [subscriptionId]
    );
    if (!r.rowCount) throw new NotFoundException("Subscription not found.");
    return r.rows[0].secret_version;
  }

  /** Worker claim: due, pending deliveries (SKIP LOCKED so workers don't collide). */
  async claimDueDeliveries(client: PoolClient, limit = 25) {
    const r = await client.query(
      `SELECT d.id, d.event_id, d.subscription_id, d.attempt_count, s.max_attempts, s.target_url, s.secret_version
         FROM event_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.status = 'active'
        ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
      [limit]
    );
    return r.rows as Array<{
      id: string;
      event_id: string;
      subscription_id: string;
      attempt_count: number;
      max_attempts: number;
      target_url: string | null;
      secret_version: number;
    }>;
  }

  /** Records one delivery attempt: success, retry with backoff, or dead-letter. */
  async recordDeliveryAttempt(
    client: PoolClient,
    deliveryId: string,
    outcome: { ok: boolean; statusCode?: number; error?: string }
  ): Promise<{ status: "delivered" | "pending" | "failed"; deadLettered: boolean }> {
    const cur = await client.query(
      `SELECT d.attempt_count, s.max_attempts FROM event_deliveries d
         JOIN event_subscriptions s ON s.id = d.subscription_id WHERE d.id = $1 FOR UPDATE OF d`,
      [deliveryId]
    );
    if (!cur.rowCount) throw new NotFoundException("Delivery not found.");
    const attempts = cur.rows[0].attempt_count + 1;
    if (outcome.ok) {
      await client.query(
        `UPDATE event_deliveries SET status = 'delivered', attempt_count = $2, delivered_at = now(),
                last_status_code = $3, last_error = NULL WHERE id = $1`,
        [deliveryId, attempts, outcome.statusCode ?? null]
      );
      return { status: "delivered", deadLettered: false };
    }
    const exhausted = attempts >= cur.rows[0].max_attempts;
    await client.query(
      `UPDATE event_deliveries
          SET attempt_count = $2, last_status_code = $3, last_error = left($4, 2000),
              status = $5, dead_lettered = $6,
              next_attempt_at = now() + ($7 || ' seconds')::interval
        WHERE id = $1`,
      [
        deliveryId,
        attempts,
        outcome.statusCode ?? null,
        outcome.error ?? null,
        exhausted ? "failed" : "pending",
        exhausted,
        String(deliveryBackoffSeconds(attempts)),
      ]
    );
    return { status: exhausted ? "failed" : "pending", deadLettered: exhausted };
  }

  /**
   * Replay by ORIGINAL event id: re-queues that event's delivery for one
   * subscription (or all of them) — never mints a new event, so consumers
   * de-duplicating on event id stay correct.
   */
  async replay(client: PoolClient, eventId: string, subscriptionId?: string): Promise<number> {
    const r = await client.query(
      `UPDATE event_deliveries
          SET status = 'pending', dead_lettered = false, attempt_count = 0, next_attempt_at = now(),
              replay_count = replay_count + 1, last_error = NULL, delivered_at = NULL
        WHERE event_id = $1 AND ($2::uuid IS NULL OR subscription_id = $2)`,
      [eventId, subscriptionId ?? null]
    );
    return r.rowCount ?? 0;
  }

  async listEvents(
    client: PoolClient,
    filters: { companyId: string; eventType?: string; aggregateType?: string; aggregateId?: string; limit?: number }
  ): Promise<DomainEvent[]> {
    const r = await client.query(
      `SELECT * FROM domain_events
        WHERE company_id = $1 AND ($2::text IS NULL OR event_type = $2)
          AND ($3::text IS NULL OR aggregate_type = $3) AND ($4::text IS NULL OR aggregate_id = $4)
        ORDER BY occurred_at DESC LIMIT $5`,
      [filters.companyId, filters.eventType ?? null, filters.aggregateType ?? null, filters.aggregateId ?? null, Math.min(filters.limit ?? 100, 500)]
    );
    return r.rows.map(toEvent);
  }
}
