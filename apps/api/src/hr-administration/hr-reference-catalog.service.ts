import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { HR_CATALOG_REGISTRY, getCatalogTypeDefinition, isRegisteredCatalogType } from "./catalog-type-registry";
import { DEFAULT_CATALOG_SEED } from "./default-catalog-seed";
import type {
  CreateHrReferenceCatalogItemRequest,
  HrReferenceCatalogItemView,
  HrReferenceCatalogTypeSummary,
  UpdateHrReferenceCatalogItemRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "hr_reference_catalog.manage.all";
const VIEW_PERMISSION = "hr_reference_catalog.view.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): HrReferenceCatalogItemView {
  return {
    id: row.id,
    companyId: row.company_id,
    catalogType: row.catalog_type,
    code: row.code,
    label: row.label,
    description: row.description,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * HR Administration reference-catalog engine (Core Employee Configuration/
 * HR-Admin v2, 2026-09-27). One generic service driving every registered
 * `catalog-type-registry.ts` entry — see that file and
 * `0090_hr_administration_reference_catalog.sql` for the full rationale.
 *
 * `validateActiveCode()` is the piece other services call to enforce a
 * catalog at the point of use (EmployeesService for `employment_type`,
 * EmployeeLifecycleService for `lifecycle_reason:*`) — this is
 * deliberately an application-layer check, not a foreign key, because
 * `hr_reference_catalog_items` rows are soft-deactivatable
 * (`is_active = false`) rather than deleted, and a `code` living in
 * historical data (an old job-history row, an existing employee record)
 * must remain readable even after an HR Admin deactivates it going
 * forward — see spec Section 27's "reference masters cannot be
 * hard-deleted if historical transactions depend on them."
 */
@Injectable()
export class HrReferenceCatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  /**
   * Seeds this company's starter catalog items on first real read —
   * exactly the same "if any row already exists, assume already seeded,
   * otherwise insert every default" shape
   * `HiringProcessService.ensureCardDefinitions()` established, and for
   * the same reason: `0090_hr_administration_reference_catalog.sql`'s own
   * seed only ran once, for every company that existed AT MIGRATION TIME
   * — a company created afterward (a new signup, a Platform-Admin-created
   * company) would otherwise start with zero catalog items at all, which
   * would make `employment_type` validation reject every value including
   * the product's own defaults. `DEFAULT_CATALOG_SEED` is the same list
   * that migration inserted, kept in one place so the two never drift.
   */
  private async ensureDefaultCatalogItems(client: PoolClient, companyId: string): Promise<void> {
    const existing = await client.query("SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 LIMIT 1", [companyId]);
    if ((existing.rowCount ?? 0) > 0) return;
    for (const item of DEFAULT_CATALOG_SEED) {
      await client.query(
        `INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, catalog_type, code) DO NOTHING`,
        [companyId, item.catalogType, item.code, item.label, item.sortOrder]
      );
    }
  }

  /** The full registry plus each type's active-item count for this
   * company — the HR Administration landing screen's own data source. */
  async listCatalogTypes(claims: RequestClaims): Promise<HrReferenceCatalogTypeSummary[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultCatalogItems(client, claims.company_id!);
      // HR Administration v2 "then 2" Phase 1 (2026-10-01) — found while
      // verifying this phase's migration: this query had no explicit
      // `company_id` filter of its own, relying entirely on the RLS
      // SELECT policy's `is_platform_admin() OR is_service() OR
      // company_id = current_company_id()` predicate. Postgres's planner
      // can't prove that OR'd, function-gated predicate reduces to a plain
      // equality, so it was a full sequential scan over the ENTIRE table
      // across every tenant on every call — invisible while the table was
      // small, but a 9+ second scan once this phase's own 13-catalog seed
      // pushed it past 3M rows (same root cause `listItems()`'s own doc
      // comment already calls out, just never applied here). Adding the
      // explicit, redundant-under-RLS filter — exactly what `listItems()`
      // already does below — gives the planner a concrete equality on an
      // indexed column, turning this back into a sub-millisecond Index
      // Only Scan via `idx_hr_reference_catalog_items_lookup` regardless
      // of total table size.
      const counts = await client.query(
        "SELECT catalog_type, count(*)::int AS active_count FROM hr_reference_catalog_items WHERE is_active = true AND company_id = $1 GROUP BY catalog_type",
        [claims.company_id]
      );
      const countByType = new Map<string, number>(counts.rows.map((r) => [r.catalog_type, r.active_count]));
      return HR_CATALOG_REGISTRY.map((entry) => ({
        catalogType: entry.catalogType,
        groupLabel: entry.groupLabel,
        label: entry.label,
        description: entry.description,
        activeCount: countByType.get(entry.catalogType) ?? 0,
      }));
    });
  }

  async listItems(claims: RequestClaims, catalogType: string, includeInactive = false): Promise<HrReferenceCatalogItemView[]> {
    this.assertRegistered(catalogType);
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultCatalogItems(client, claims.company_id!);
      // Explicit `company_id` filter, matching every other query in this
      // service, even though RLS alone already scopes an ordinary tenant
      // caller — a `is_platform_admin`/`is_service` caller bypasses RLS
      // entirely, and without this filter would see every company's items
      // for this catalog type merged together.
      const result = await client.query(
        includeInactive
          ? "SELECT * FROM hr_reference_catalog_items WHERE catalog_type = $1 AND company_id = $2 ORDER BY sort_order, label"
          : "SELECT * FROM hr_reference_catalog_items WHERE catalog_type = $1 AND company_id = $2 AND is_active = true ORDER BY sort_order, label",
        [catalogType, claims.company_id]
      );
      return result.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateHrReferenceCatalogItemRequest): Promise<HrReferenceCatalogItemView> {
    this.assertRegistered(input.catalogType);
    if (!input.code?.trim()) throw new BadRequestException("code is required");
    if (!input.label?.trim()) throw new BadRequestException("label is required");
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultCatalogItems(client, claims.company_id!);
      const existing = await client.query(
        "SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2 AND code = $3",
        [claims.company_id, input.catalogType, input.code.trim()]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException(`A "${input.catalogType}" item with code "${input.code}" already exists`);
      }
      const maxOrder = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2",
        [claims.company_id, input.catalogType]
      );
      const inserted = await client.query(
        `INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, description, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [claims.company_id, input.catalogType, input.code.trim(), input.label.trim(), input.description ?? null, maxOrder.rows[0].next]
      );
      const view = rowToView(inserted.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "hr_reference_catalog_item.create",
        target: view.id,
        metadata: { catalogType: input.catalogType, code: input.code },
      });
      return view;
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateHrReferenceCatalogItemRequest): Promise<HrReferenceCatalogItemView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const result = await client.query(
        `UPDATE hr_reference_catalog_items SET
           label = COALESCE($2, label),
           description = COALESCE($3, description),
           is_active = COALESCE($4, is_active),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.label ?? null, patch.description ?? null, patch.isActive ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "hr_reference_catalog_item.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });
      return rowToView(result.rows[0]);
    });
  }

  async reorder(claims: RequestClaims, catalogType: string, orderedIds: string[]): Promise<HrReferenceCatalogItemView[]> {
    this.assertRegistered(catalogType);
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultCatalogItems(client, claims.company_id!);
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          "UPDATE hr_reference_catalog_items SET sort_order = $2, updated_at = now() WHERE id = $1 AND catalog_type = $3 AND company_id = $4",
          [orderedIds[i], i, catalogType, claims.company_id]
        );
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "hr_reference_catalog_item.reorder",
        target: catalogType,
        metadata: { orderedIds },
      });
      // Scoped to exactly the ids the caller reordered — NOT every row in
      // this catalog type — so an inactive item sitting outside the
      // caller's own (active-only, by default) list view never silently
      // reappears in the response just because it shares this catalog
      // type and company.
      const result = await client.query(
        "SELECT * FROM hr_reference_catalog_items WHERE id = ANY($1::uuid[]) AND catalog_type = $2 AND company_id = $3 ORDER BY sort_order, label",
        [orderedIds, catalogType, claims.company_id]
      );
      return result.rows.map(rowToView);
    });
  }

  /**
   * The enforcement half — called by EmployeesService (`employment_type`)
   * and EmployeeLifecycleService (`lifecycle_reason:*`). Silently accepts
   * `code === undefined/null` (the field or reason is optional at the
   * call site) — only a NON-EMPTY code that fails to match an active
   * catalog item throws. Runs on the SAME client/transaction the caller
   * is already inside, so this never opens a second connection or a
   * second RBAC/entitlement check.
   */
  async validateActiveCode(client: PoolClient, companyId: string, catalogType: string, code: string | null | undefined): Promise<void> {
    if (!code) return;
    await this.ensureDefaultCatalogItems(client, companyId);
    const result = await client.query(
      "SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2 AND code = $3 AND is_active = true",
      [companyId, catalogType, code]
    );
    if (result.rowCount === 0) {
      const def = getCatalogTypeDefinition(catalogType);
      throw new BadRequestException(`"${code}" is not a valid, active ${def?.label ?? catalogType} value for this company`);
    }
  }

  private assertRegistered(catalogType: string): void {
    if (!isRegisteredCatalogType(catalogType)) {
      throw new BadRequestException(`Unknown HR Administration catalog type: ${catalogType}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM hr_reference_catalog_items WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Reference catalog item not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage HR Administration reference data");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view HR Administration reference data");
    }
  }
}
