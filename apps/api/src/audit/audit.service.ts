import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import type { AuditLogEntry } from "@aihxm/shared-types";

type RecordInput = {
  companyId: string | null;
  action: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): AuditLogEntry {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name ?? null,
    actor: row.actor,
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
    await client.query(
      `INSERT INTO audit_log (company_id, actor, action, target, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [input.companyId, claims.sub, input.action, input.target ?? null, JSON.stringify(input.metadata ?? {})]
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
      `SELECT a.*, c.name AS company_name
       FROM audit_log a
       LEFT JOIN companies c ON c.id = a.company_id
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
