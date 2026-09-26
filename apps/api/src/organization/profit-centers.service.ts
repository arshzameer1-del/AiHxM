import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { buildOrgEventPayload } from "../webhooks/org-event-payload.util";
import type { ProfitCenterVersionView, ProfitCenterView, CreateProfitCenterRequest, UpdateProfitCenterRequest } from "@aihxm/shared-types";

// Profit Centers are gated under the same `employee` module every other
// Organization Management object lives under.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "profit_center.manage.all";
const VIEW_PERMISSION = "profit_center.view.all";

type ProfitCenterRow = {
  id: string;
  company_id: string;
  code: string | null;
  name: string;
  org_unit_id: string | null;
  status: string;
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToProfitCenter(row: any): ProfitCenterView {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    name: row.name,
    orgUnitId: row.org_unit_id,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(row: any): ProfitCenterVersionView {
  return {
    id: row.id,
    profitCenterId: row.profit_center_id,
    code: row.code,
    name: row.name,
    orgUnitId: row.org_unit_id,
    status: row.status,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

/**
 * Organization Management, Phase 4 (see 0073_locations_and_financial_centers.sql's
 * own header comment for the full design writeup): a canonical, reusable
 * financial dimension a position can be tagged with. Deliberately mirrors
 * `JobsService`'s own shape exactly — a flat catalog, no hierarchy, no
 * move()/reparent concept, optionally linked to an org unit.
 */
@Injectable()
export class ProfitCentersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    // Optional for the same reason every other Organization Management
    // service's own `webhooks` field is. Organization Management Phase 7
    // (Unified Integration & Synchronization Requirements, Section 14) —
    // the shared `org.financial_center.changed` event this service and
    // `CostCentersService` both fire (distinguished by the payload's own
    // `centerType` field), fired at every one of this service's own
    // already-audited mutation points (create/update/archive/activate).
    private readonly webhooks?: WebhookDispatchService
  ) {}

  private publishChanged(claims: RequestClaims, changeType: string, profitCenter: ProfitCenterView): void {
    this.webhooks
      ?.enqueue(
        claims.company_id!,
        "org.financial_center.changed",
        buildOrgEventPayload(claims, changeType, "profitCenter", profitCenter, { centerType: "profit_center" })
      )
      .catch(() => undefined);
  }

  async create(claims: RequestClaims, input: CreateProfitCenterRequest): Promise<ProfitCenterView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      if (input.orgUnitId) {
        await this.mustExistOrgUnit(client, claims.company_id!, input.orgUnitId);
      }
      if (input.code) {
        const dup = await client.query("SELECT 1 FROM profit_centers WHERE company_id = $1 AND code = $2", [
          claims.company_id,
          input.code,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A profit center with code "${input.code}" already exists`);
        }
      }

      const inserted = await client.query(
        `INSERT INTO profit_centers (company_id, code, name, org_unit_id, status)
         VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
        [claims.company_id, input.code ?? null, input.name, input.orgUnitId ?? null]
      );
      const profitCenter = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "profit_center_versions",
        scope: { profit_center_id: profitCenter.id },
        extraInsertColumns: { company_id: claims.company_id },
        data: { code: profitCenter.code, name: profitCenter.name, org_unit_id: profitCenter.org_unit_id, status: profitCenter.status },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "profit_center.create",
        target: profitCenter.id,
        metadata: { name: input.name, orgUnitId: input.orgUnitId ?? null },
      });

      const view = rowToProfitCenter(profitCenter);
      this.publishChanged(claims, "create", view);
      return view;
    });
  }

  /** Every profit center in the tenant's catalog, flat, alphabetical. */
  async list(claims: RequestClaims): Promise<ProfitCenterView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM profit_centers WHERE company_id = $1 ORDER BY name", [
        claims.company_id,
      ]);
      return result.rows.map(rowToProfitCenter);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<ProfitCenterView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToProfitCenter(await this.mustExist(client, id)));
  }

  async update(claims: RequestClaims, id: string, patch: UpdateProfitCenterRequest): Promise<ProfitCenterView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.orgUnitId) {
        await this.mustExistOrgUnit(client, claims.company_id!, patch.orgUnitId);
      }
      if (patch.code && patch.code !== before.code) {
        const dup = await client.query("SELECT 1 FROM profit_centers WHERE company_id = $1 AND code = $2 AND id != $3", [
          claims.company_id,
          patch.code,
          id,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A profit center with code "${patch.code}" already exists`);
        }
      }

      const next = {
        code: patch.code ?? before.code,
        name: patch.name ?? before.name,
        // `null` explicitly clears the org unit link; `undefined` (field
        // omitted) leaves it unchanged — the same three-way distinction
        // `UpdatePositionRequest.jobId` established.
        org_unit_id: patch.orgUnitId === null ? null : patch.orgUnitId ?? before.org_unit_id,
        status: before.status,
      };

      const profitCenter = await this.applyVersionAndSync(client, claims, id, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "profit_center.update",
        target: id,
        metadata: { before: rowToProfitCenter(before), after: rowToProfitCenter(profitCenter) },
      });

      const view = rowToProfitCenter(profitCenter);
      this.publishChanged(claims, "update", view);
      return view;
    });
  }

  async archive(claims: RequestClaims, id: string): Promise<ProfitCenterView> {
    return this.setStatus(claims, id, "archived");
  }

  async activate(claims: RequestClaims, id: string): Promise<ProfitCenterView> {
    return this.setStatus(claims, id, "active");
  }

  private async setStatus(claims: RequestClaims, id: string, status: "active" | "archived"): Promise<ProfitCenterView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === status) return rowToProfitCenter(before);

      const next = { code: before.code, name: before.name, org_unit_id: before.org_unit_id, status };
      const profitCenter = await this.applyVersionAndSync(client, claims, id, next);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: status === "archived" ? "profit_center.archive" : "profit_center.activate",
        target: id,
      });

      const view = rowToProfitCenter(profitCenter);
      this.publishChanged(claims, status === "archived" ? "archive" : "activate", view);
      return view;
    });
  }

  /** `GET /organization/cost-centers/:id/history` — every version this
   * profit center has ever had, oldest first. */
  async getHistory(claims: RequestClaims, id: string): Promise<ProfitCenterVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "profit_center_versions",
        scope: { profit_center_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    data: { code: string | null; name: string; org_unit_id: string | null; status: string },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "profit_center_versions",
      scope: { profit_center_id: id },
      extraInsertColumns: { company_id: claims.company_id },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE profit_centers SET code = $2, name = $3, org_unit_id = $4, status = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.code, data.name, data.org_unit_id, data.status]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<ProfitCenterRow> {
    const result = await client.query<ProfitCenterRow>("SELECT * FROM profit_centers WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Cost center not found");
    return result.rows[0];
  }

  private async mustExistOrgUnit(client: PoolClient, companyId: string, orgUnitId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [orgUnitId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Org unit not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage profit centers");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view profit centers");
    }
  }
}
