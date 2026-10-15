import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import type { AuditLogEntry } from "@aihxm/shared-types";
import { getRequestContext } from "../common/request-context";
import { redactForAudit } from "../domain-events/payload-redaction";

type RecordInput = {
  companyId: string | null;
  action: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
  /** SEC-06 — all optional and additive; existing callers are unchanged. */
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Overrides the request-scoped correlation id (jobs/events pass their own). */
  correlationId?: string | null;
  sourceChannel?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): AuditLogEntry {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name ?? null,
    actor: row.actor,
    actorLabel: row.actor_label ?? null,
    actorId: row.actor_id ?? null,
    actorType: row.actor_type ?? null,
    correlationId: row.correlation_id ?? null,
    sourceChannel: row.source_channel ?? null,
    reason: row.reason ?? null,
    action: row.action,
    target: row.target,
    metadata: row.metadata ?? {},
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

@Injectable()
export class AuditService {
  /**
   * Writes within the SAME transaction/client the caller is already
   * using, so an audit entry either commits together with the action it
   * documents or rolls back with it — never one without the other. This
   * is what makes "every sensitive action has an audit log entry" (the
   * SDLC doc's Definition of Done) actually true rather than best-effort.
   */
  async record(client: PoolClient, claims: RequestClaims, input: RecordInput): Promise<void> {
    const ctx = getRequestContext();
    const actorIsUuid = UUID_RE.test(claims.sub);
    const actorType = !actorIsUuid || claims.is_service ? "service" : claims.is_platform_admin ? "platform_admin" : "user";
    await client.query(
      `INSERT INTO audit_log
         (company_id, actor, action, target, metadata,
          correlation_id, source_channel, actor_id, actor_type, ip_address, reason, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::inet, $11, $12::jsonb, $13::jsonb)`,
      [
        input.companyId,
        claims.sub,
        input.action,
        input.target ?? null,
        JSON.stringify(redactForAudit(input.metadata ?? {})),
        input.correlationId ?? ctx?.correlationId ?? null,
        input.sourceChannel ?? ctx?.sourceChannel ?? "api",
        actorIsUuid && actorType !== "service" ? claims.sub : null,
        actorType,
        ctx?.ipAddress ?? null,
        input.reason ?? null,
        input.before ? JSON.stringify(redactForAudit(input.before)) : null,
        input.after ? JSON.stringify(redactForAudit(input.after)) : null,
      ]
    );
  }

  // Tenant Management gap-fill Phase 1 item #6 — actor/action/date-range
  // filters, added alongside the original companyId filter. `actor` and
  // `action` are partial (ILIKE) matches: `action` values are free-form
  // dot-namespaced strings with no fixed vocabulary, so exact match would
  // be unusable as a search. `from`/`to` bound `created_at` inclusively.
  async list(
    client: PoolClient,
    filters: { companyId?: string; actor?: string; action?: string; from?: string; to?: string; limit?: number }
  ): Promise<AuditLogEntry[]> {
    const limit = Math.min(filters.limit ?? 100, 500);
    const result = await client.query(
      `SELECT a.*, c.name AS company_name,
              COALESCE(pa.full_name || ' (' || pa.email || ')', ua.email) AS actor_label
       FROM audit_log a
       LEFT JOIN companies c ON c.id = a.company_id
       LEFT JOIN platform_admins pa ON pa.id::text = a.actor
       LEFT JOIN user_accounts ua ON ua.id::text = a.actor
       WHERE ($1::uuid IS NULL OR a.company_id = $1)
         AND ($2::text IS NULL OR a.actor ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR a.action ILIKE '%' || $3 || '%')
         AND ($4::timestamptz IS NULL OR a.created_at >= $4)
         AND ($5::timestamptz IS NULL OR a.created_at <= $5)
       ORDER BY a.created_at DESC
       LIMIT $6`,
      [
        filters.companyId ?? null,
        filters.actor ?? null,
        filters.action ?? null,
        filters.from ?? null,
        filters.to ?? null,
        limit,
      ]
    );
    return result.rows.map(rowToEntry);
  }
}
