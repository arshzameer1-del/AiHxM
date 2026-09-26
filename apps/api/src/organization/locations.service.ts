import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import type {
  CreateLocationRequest,
  LocationTreeNode,
  LocationVersionView,
  LocationView,
  MoveLocationRequest,
  UpdateLocationRequest,
} from "@aihxm/shared-types";

// Locations are gated under the same `employee` module every other
// Organization Management object lives under.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "location.manage.all";
const VIEW_PERMISSION = "location.view.all";

type LocationRow = {
  id: string;
  company_id: string;
  parent_id: string | null;
  location_type: string;
  code: string | null;
  name: string;
  address: string | null;
  status: string;
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLocation(row: any): LocationView {
  return {
    id: row.id,
    companyId: row.company_id,
    parentId: row.parent_id,
    locationType: row.location_type,
    code: row.code,
    name: row.name,
    address: row.address,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(row: any): LocationVersionView {
  return {
    id: row.id,
    locationId: row.location_id,
    parentId: row.parent_id,
    locationType: row.location_type,
    code: row.code,
    name: row.name,
    address: row.address,
    status: row.status,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

/**
 * Organization Management, Phase 4 (see the Master Engineering
 * Instruction doc's Section 14, and
 * 0073_locations_and_financial_centers.sql's own header comment for the
 * full design writeup): the canonical, unlimited-depth, self-referencing
 * Location hierarchy that replaces free-text `employees.location`.
 *
 * Deliberately mirrors `OrgUnitsService`'s own shape exactly — same
 * layering, same stable-identity (`locations`) + effective-dated-history
 * (`location_versions`) split, same cycle-prevention approach for
 * `move()`. Location and Org Unit are two independent hierarchies (a
 * position lives in one org unit; an employee is at one location; the two
 * trees don't nest inside each other), so this is a sibling service, not a
 * generalization of `OrgUnitsService` — matching how `Job`/`Position` got
 * their own service each rather than one parameterized "hierarchy engine."
 */
@Injectable()
export class LocationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  async create(claims: RequestClaims, input: CreateLocationRequest): Promise<LocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      if (input.parentId) {
        await this.mustExist(client, input.parentId);
      }
      if (input.code) {
        const dup = await client.query("SELECT 1 FROM locations WHERE company_id = $1 AND code = $2", [
          claims.company_id,
          input.code,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A location with code "${input.code}" already exists`);
        }
      }

      const inserted = await client.query(
        `INSERT INTO locations (company_id, parent_id, location_type, code, name, address, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
        [claims.company_id, input.parentId ?? null, input.locationType, input.code ?? null, input.name, input.address ?? null]
      );
      const location = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "location_versions",
        scope: { location_id: location.id },
        extraInsertColumns: { company_id: claims.company_id },
        data: {
          parent_id: location.parent_id,
          location_type: location.location_type,
          code: location.code,
          name: location.name,
          address: location.address,
          status: location.status,
        },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "location.create",
        target: location.id,
        metadata: { name: input.name, locationType: input.locationType, parentId: input.parentId ?? null },
      });

      return rowToLocation(location);
    });
  }

  /** Every location in the tenant, flat, alphabetical. */
  async list(claims: RequestClaims): Promise<LocationView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM locations WHERE company_id = $1 ORDER BY name", [
        claims.company_id,
      ]);
      return result.rows.map(rowToLocation);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<LocationView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToLocation(await this.mustExist(client, id)));
  }

  /** Every descendant of `id` (not including `id` itself) — exactly
   * `OrgUnitsService.getDescendants()`'s own recursive-CTE shape, reused
   * by `move()` below to guard against reparenting under one's own
   * subtree. */
  private async descendantRows(client: PoolClient, companyId: string, rootId: string): Promise<Record<string, unknown>[]> {
    const result = await client.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, company_id, parent_id, location_type, code, name, address, status, created_at, updated_at,
                0 AS depth, ARRAY[id] AS path
         FROM locations
         WHERE company_id = $1 AND id = $2
         UNION ALL
         SELECT l.id, l.company_id, l.parent_id, l.location_type, l.code, l.name, l.address, l.status,
                l.created_at, l.updated_at, s.depth + 1, s.path || l.id
         FROM locations l
         JOIN subtree s ON l.parent_id = s.id
         WHERE l.company_id = $1 AND NOT l.id = ANY(s.path)
       )
       SELECT * FROM subtree WHERE depth > 0 ORDER BY depth ASC, name ASC`,
      [companyId, rootId]
    );
    return result.rows;
  }

  /** `GET /organization/locations/tree` — the whole company's hierarchy,
   * nested, in one call — exactly `OrgUnitsService.getTree()`'s own flat
   * fetch + in-memory nesting. */
  async getTree(claims: RequestClaims): Promise<LocationTreeNode[]> {
    const locations = await this.list(claims);
    const byId = new Map<string, LocationTreeNode>();
    for (const location of locations) {
      byId.set(location.id, { ...location, children: [] });
    }
    const roots: LocationTreeNode[] = [];
    for (const location of locations) {
      const node = byId.get(location.id)!;
      const parent = location.parentId ? byId.get(location.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /** Rename/retype/recode/re-address in place — reparenting is `move()`
   * below, kept deliberately separate since it's the one edit that needs
   * the cycle guard. */
  async update(claims: RequestClaims, id: string, patch: UpdateLocationRequest): Promise<LocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.code && patch.code !== before.code) {
        const dup = await client.query("SELECT 1 FROM locations WHERE company_id = $1 AND code = $2 AND id != $3", [
          claims.company_id,
          patch.code,
          id,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A location with code "${patch.code}" already exists`);
        }
      }

      const next = {
        parent_id: before.parent_id,
        location_type: patch.locationType ?? before.location_type,
        code: patch.code ?? before.code,
        name: patch.name ?? before.name,
        address: patch.address ?? before.address,
        status: before.status,
      };

      const location = await this.applyVersionAndSync(client, claims, id, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "location.update",
        target: id,
        metadata: { before: rowToLocation(before), after: rowToLocation(location) },
      });

      return rowToLocation(location);
    });
  }

  /** Reparent — exactly `OrgUnitsService.move()`'s own guard shape: reject
   * self-parenting and moving a location under its own descendant. */
  async move(claims: RequestClaims, id: string, input: MoveLocationRequest): Promise<LocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (input.parentId) {
        if (input.parentId === id) {
          throw new BadRequestException("A location cannot be its own parent");
        }
        await this.mustExist(client, input.parentId);
        const descendants = await this.descendantRows(client, claims.company_id!, id);
        if (descendants.some((d) => d.id === input.parentId)) {
          throw new BadRequestException("Cannot move a location under one of its own descendants");
        }
      }

      const next = {
        parent_id: input.parentId ?? null,
        location_type: before.location_type,
        code: before.code,
        name: before.name,
        address: before.address,
        status: before.status,
      };

      const location = await this.applyVersionAndSync(client, claims, id, next, input.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "location.move",
        target: id,
        metadata: { fromParentId: before.parent_id, toParentId: input.parentId ?? null },
      });

      return rowToLocation(location);
    });
  }

  async archive(claims: RequestClaims, id: string): Promise<LocationView> {
    return this.setStatus(claims, id, "archived");
  }

  async activate(claims: RequestClaims, id: string): Promise<LocationView> {
    return this.setStatus(claims, id, "active");
  }

  private async setStatus(claims: RequestClaims, id: string, status: "active" | "archived"): Promise<LocationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === status) return rowToLocation(before);

      const next = {
        parent_id: before.parent_id,
        location_type: before.location_type,
        code: before.code,
        name: before.name,
        address: before.address,
        status,
      };
      const location = await this.applyVersionAndSync(client, claims, id, next);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: status === "archived" ? "location.archive" : "location.activate",
        target: id,
      });

      return rowToLocation(location);
    });
  }

  /** `GET /organization/locations/:id/history` — every version this
   * location has ever had, oldest first. */
  async getHistory(claims: RequestClaims, id: string): Promise<LocationVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "location_versions",
        scope: { location_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  /** Shared by update()/move()/setStatus(): supersedes the open
   * `location_versions` row via the EffectiveDatingEngine, then syncs
   * `locations`' own denormalized current-state columns to match —
   * exactly `OrgUnitsService`'s own `applyVersionAndSync()`. */
  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    data: { parent_id: string | null; location_type: string; code: string | null; name: string; address: string | null; status: string },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "location_versions",
      scope: { location_id: id },
      extraInsertColumns: { company_id: claims.company_id },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE locations SET parent_id = $2, location_type = $3, code = $4, name = $5, address = $6, status = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.parent_id, data.location_type, data.code, data.name, data.address, data.status]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<LocationRow> {
    const result = await client.query<LocationRow>("SELECT * FROM locations WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Location not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage the location hierarchy");
    }
  }

  /** Manage implies view, same as every other Organization Management
   * service's requireView(). */
  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view the location hierarchy");
    }
  }
}
