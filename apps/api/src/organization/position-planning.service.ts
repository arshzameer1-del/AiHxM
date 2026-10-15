import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { buildOrgEventPayload } from "../webhooks/org-event-payload.util";
import { PositionsService } from "./positions.service";
import type {
  PositionBudgetView,
  PositionIncumbentView,
  PositionPlanningSummaryRow,
  PositionRelationshipView,
} from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function iso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isoDate(value: any): string {
  return (value?.toISOString ? value.toISOString() : String(value)).slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBudget(r: any): PositionBudgetView {
  return {
    id: r.id,
    positionId: r.position_id,
    fiscalYear: r.fiscal_year,
    plannedHeadcount: Number(r.planned_headcount),
    budgetAmount: r.budget_amount === null ? null : Number(r.budget_amount),
    currency: r.currency,
    notes: r.notes,
    updatedAt: iso(r.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRelationship(r: any): PositionRelationshipView {
  return {
    id: r.id,
    positionId: r.position_id,
    relatedPositionId: r.related_position_id,
    relatedPositionTitle: r.related_title ?? null,
    relationshipType: r.relationship_type,
    status: r.status,
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: r.effective_to ? isoDate(r.effective_to) : null,
  };
}

/**
 * Gap Register ORG-02 — position planning beyond the single seat:
 *  - incumbents: who holds a (possibly multi-FTE) position, with FTE and dates;
 *  - budgets: planned headcount / amount per fiscal year;
 *  - relationships: position-to-position `reports_to` (one open parent, cycle
 *    guarded) and `dotted_line`.
 * Access is delegated to PositionsService (`position.view.*` to read,
 * `position.manage.*` + data scope to write) so there is one rule for who can
 * see or change a position. Incumbent writes are NOT here: occupancy changes go
 * through `OrgOccupancyService` (assign / unassign).
 */
@Injectable()
export class PositionPlanningService {
  constructor(
    private readonly db: DatabaseService,
    private readonly positions: PositionsService,
    private readonly audit: AuditService,
    private readonly webhooks?: WebhookDispatchService
  ) {}

  private publish(claims: RequestClaims, changeType: string, positionId: string): void {
    if (!claims.company_id) return;
    this.webhooks
      ?.enqueue(claims.company_id, "org.position.changed", buildOrgEventPayload(claims, changeType, "position", { id: positionId }))
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------- incumbents
  async listIncumbents(claims: RequestClaims, positionId: string, includeEnded = false): Promise<PositionIncumbentView[]> {
    await this.positions.assertCanViewPosition(claims, positionId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT i.*, COALESCE(NULLIF(trim(e.first_name || ' ' || e.last_name), ''), e.employee_number) AS employee_name
           FROM position_incumbents i JOIN employees e ON e.id = i.employee_id
          WHERE i.position_id = $1 AND i.company_id = $2 AND ($3::boolean OR i.status = 'active')
          ORDER BY i.effective_from, i.created_at`,
        [positionId, claims.company_id, includeEnded]
      );
      return r.rows.map((row) => ({
        id: row.id,
        positionId: row.position_id,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        fte: Number(row.fte),
        status: row.status,
        effectiveFrom: isoDate(row.effective_from),
        effectiveTo: row.effective_to ? isoDate(row.effective_to) : null,
      }));
    });
  }

  // ------------------------------------------------------------------- budgets
  async listBudgets(claims: RequestClaims, positionId: string): Promise<PositionBudgetView[]> {
    await this.positions.assertCanViewPosition(claims, positionId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM position_budgets WHERE position_id = $1 AND company_id = $2 ORDER BY fiscal_year DESC", [
        positionId,
        claims.company_id,
      ]);
      return r.rows.map(rowToBudget);
    });
  }

  async upsertBudget(
    claims: RequestClaims,
    positionId: string,
    fiscalYear: number,
    input: { plannedHeadcount: number; budgetAmount?: number | null; currency?: string; notes?: string }
  ): Promise<PositionBudgetView> {
    await this.positions.assertCanManagePosition(claims, positionId);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
      throw new BadRequestException("fiscalYear must be a four-digit year");
    }
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `INSERT INTO position_budgets (company_id, position_id, fiscal_year, planned_headcount, budget_amount, currency, notes, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'PKR'), $7, $8)
         ON CONFLICT (position_id, fiscal_year) DO UPDATE
           SET planned_headcount = EXCLUDED.planned_headcount, budget_amount = EXCLUDED.budget_amount,
               currency = COALESCE($6, position_budgets.currency), notes = EXCLUDED.notes, updated_at = now()
         RETURNING *`,
        [
          claims.company_id,
          positionId,
          fiscalYear,
          input.plannedHeadcount,
          input.budgetAmount ?? null,
          input.currency ?? null,
          input.notes ?? null,
          claims.sub,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position_budget.upsert",
        target: positionId,
        metadata: { fiscalYear, plannedHeadcount: input.plannedHeadcount, budgetAmount: input.budgetAmount ?? null },
      });
      this.publish(claims, "budget.upsert", positionId);
      return rowToBudget(r.rows[0]);
    });
  }

  async deleteBudget(claims: RequestClaims, positionId: string, fiscalYear: number): Promise<void> {
    await this.positions.assertCanManagePosition(claims, positionId);
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM position_budgets WHERE position_id = $1 AND fiscal_year = $2 AND company_id = $3", [
        positionId,
        fiscalYear,
        claims.company_id,
      ]);
      if ((r.rowCount ?? 0) === 0) throw new NotFoundException("Budget not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position_budget.delete",
        target: positionId,
        metadata: { fiscalYear },
      });
    });
    this.publish(claims, "budget.delete", positionId);
  }

  // ------------------------------------------------------------- relationships
  async listRelationships(claims: RequestClaims, positionId: string): Promise<PositionRelationshipView[]> {
    await this.positions.assertCanViewPosition(claims, positionId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT r.*, p.position_title AS related_title FROM position_relationships r
           JOIN positions p ON p.id = r.related_position_id
          WHERE r.position_id = $1 AND r.company_id = $2 AND r.status = 'active' ORDER BY r.relationship_type, r.created_at`,
        [positionId, claims.company_id]
      );
      return r.rows.map(rowToRelationship);
    });
  }

  async createRelationship(
    claims: RequestClaims,
    positionId: string,
    input: { relatedPositionId: string; relationshipType: "reports_to" | "dotted_line"; effectiveFrom?: string }
  ): Promise<PositionRelationshipView> {
    await this.positions.assertCanManagePosition(claims, positionId);
    if (input.relatedPositionId === positionId) throw new BadRequestException("A position cannot relate to itself");
    return this.db.withClaims(claims, async (client) => {
      const related = await client.query<{ status: string }>("SELECT status FROM positions WHERE id = $1 AND company_id = $2", [
        input.relatedPositionId,
        claims.company_id,
      ]);
      if (related.rowCount === 0) throw new NotFoundException("Related position not found");
      if (related.rows[0].status === "abolished" || related.rows[0].status === "rejected") {
        throw new BadRequestException(`A ${related.rows[0].status} position cannot be a reporting target`);
      }
      if (input.relationshipType === "reports_to") {
        await this.assertNoPositionCycle(client, claims.company_id!, positionId, input.relatedPositionId);
        await client.query(
          `UPDATE position_relationships SET status = 'ended', effective_to = GREATEST(effective_from, COALESCE($3::date, CURRENT_DATE))
            WHERE position_id = $1 AND company_id = $2 AND relationship_type = 'reports_to' AND status = 'active'`,
          [positionId, claims.company_id, input.effectiveFrom ?? null]
        );
      } else {
        const dup = await client.query(
          `SELECT 1 FROM position_relationships WHERE position_id = $1 AND related_position_id = $2 AND relationship_type = 'dotted_line' AND status = 'active'`,
          [positionId, input.relatedPositionId]
        );
        if ((dup.rowCount ?? 0) > 0) throw new ConflictException("This dotted-line relationship already exists");
      }
      const inserted = await client.query(
        `INSERT INTO position_relationships (company_id, position_id, related_position_id, relationship_type, effective_from)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE)) RETURNING *`,
        [claims.company_id, positionId, input.relatedPositionId, input.relationshipType, input.effectiveFrom ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position_relationship.create",
        target: positionId,
        metadata: { relatedPositionId: input.relatedPositionId, relationshipType: input.relationshipType },
      });
      this.publish(claims, "relationship.create", positionId);
      return rowToRelationship(inserted.rows[0]);
    });
  }

  async endRelationship(claims: RequestClaims, positionId: string, relationshipId: string, effectiveTo?: string): Promise<PositionRelationshipView> {
    await this.positions.assertCanManagePosition(claims, positionId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE position_relationships SET status = 'ended', effective_to = GREATEST(effective_from, COALESCE($4::date, CURRENT_DATE))
          WHERE id = $1 AND position_id = $2 AND company_id = $3 AND status = 'active' RETURNING *`,
        [relationshipId, positionId, claims.company_id, effectiveTo ?? null]
      );
      if (r.rowCount === 0) throw new NotFoundException("Active relationship not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position_relationship.end",
        target: positionId,
        metadata: { relationshipId },
      });
      this.publish(claims, "relationship.end", positionId);
      return rowToRelationship(r.rows[0]);
    });
  }

  /** Walks the open `reports_to` chain upward from the proposed parent; if the
   * child appears in it, adding the edge would close a loop. */
  private async assertNoPositionCycle(client: PoolClient, companyId: string, positionId: string, parentId: string): Promise<void> {
    const r = await client.query(
      `WITH RECURSIVE chain AS (
         SELECT $2::uuid AS pos, ARRAY[$2::uuid] AS path
         UNION ALL
         SELECT rel.related_position_id, chain.path || rel.related_position_id
           FROM position_relationships rel JOIN chain ON rel.position_id = chain.pos
          WHERE rel.relationship_type = 'reports_to' AND rel.status = 'active' AND rel.company_id = $3
            AND NOT rel.related_position_id = ANY(chain.path)
       )
       SELECT 1 FROM chain WHERE pos = $1 LIMIT 1`,
      [positionId, parentId, companyId]
    );
    if ((r.rowCount ?? 0) > 0) throw new BadRequestException("This would create a position reporting cycle");
  }

  // ------------------------------------------------------------------- summary
  /** Planned vs approved vs filled headcount per position for a fiscal year. */
  async summary(claims: RequestClaims, fiscalYear?: number): Promise<PositionPlanningSummaryRow[]> {
    const visible = await this.positions.list(claims);
    if (visible.length === 0) return [];
    const year = fiscalYear ?? new Date().getUTCFullYear();
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT p.id, p.position_title, p.org_unit_id, p.status, p.headcount_fte,
                b.planned_headcount, b.budget_amount,
                COALESCE((SELECT SUM(i.fte) FROM position_incumbents i WHERE i.position_id = p.id AND i.status = 'active'), 0) AS used_fte,
                COALESCE((SELECT SUM(rq.headcount - rq.filled_headcount) FROM job_requisitions rq
                           WHERE rq.position_id = p.id AND rq.status IN ('draft','pending_approval','approved','open','on_hold')), 0) AS open_requisition_headcount
           FROM positions p
           LEFT JOIN position_budgets b ON b.position_id = p.id AND b.fiscal_year = $2
          WHERE p.company_id = $1 AND p.id = ANY($3::uuid[])
          ORDER BY p.position_title`,
        [claims.company_id, year, visible.map((p) => p.id)]
      );
      return r.rows.map((row) => {
        const approved = Number(row.headcount_fte);
        const used = Number(row.used_fte);
        const planned = row.planned_headcount === null ? null : Number(row.planned_headcount);
        return {
          positionId: row.id,
          positionTitle: row.position_title,
          orgUnitId: row.org_unit_id,
          status: row.status,
          fiscalYear: year,
          approvedHeadcount: approved,
          plannedHeadcount: planned,
          filledFte: used,
          openCapacityFte: Math.max(0, approved - used),
          openRequisitionHeadcount: Number(row.open_requisition_headcount),
          budgetAmount: row.budget_amount === null ? null : Number(row.budget_amount),
          overPlanned: planned !== null && used > planned,
        };
      });
    });
  }
}
