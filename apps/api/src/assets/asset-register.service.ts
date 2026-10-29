import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  AssetCategory, AssetCondition, AssetDetailView, AssetEventType, AssetEventView, AssetMaintenanceRequest, AssetRegisterStatus, AssetSummaryView, AssetView, AssignAssetRequest,
  CreateAssetRequest, MyAssetView, RetireAssetRequest, ReturnAssetRequest, UpdateAssetRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";

const CATEGORIES: AssetCategory[] = ["laptop", "desktop", "mobile", "tablet", "vehicle", "furniture", "access_card", "uniform", "tool", "other"];
const CONDITIONS: AssetCondition[] = ["new", "good", "fair", "poor", "damaged"];
const DISPOSALS = ["sold", "scrapped", "donated", "returned_to_vendor"];
const CATEGORY_LABEL: Record<AssetCategory, string> = {
  laptop: "Laptop", desktop: "Desktop", mobile: "Mobile phone", tablet: "Tablet", vehicle: "Vehicle", furniture: "Furniture", access_card: "Access card", uniform: "Uniform", tool: "Tool", other: "Other",
};
const iso = (v: unknown): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10)) : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ASSET_SELECT = `SELECT a.*, trim(concat_ws(' ', h.first_name, h.last_name)) AS holder_name, h.employee_number AS holder_number
                        FROM asset_register a LEFT JOIN employees h ON h.id = a.current_employee_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(x: any, today: string): AssetView {
  const warranty = iso(x.warranty_until);
  return {
    id: x.id, assetTag: x.asset_tag, name: x.name, category: x.category, serialNumber: x.serial_number ?? null, vendor: x.vendor ?? null, purchaseDate: iso(x.purchase_date),
    purchaseCost: num(x.purchase_cost), warrantyUntil: warranty, warrantyExpired: warranty !== null && warranty < today, location: x.location ?? null, status: x.status,
    holderId: x.current_employee_id ?? null, holderName: x.holder_name || null, holderNumber: x.holder_number ?? null, lastVerifiedOn: iso(x.last_verified_on), retiredOn: iso(x.retired_on),
    disposalMethod: x.disposal_method ?? null, disposalValue: num(x.disposal_value), notes: x.notes ?? null,
  };
}

/**
 * The company asset register. An asset is in exactly one state (in stock, assigned, under maintenance, lost, retired) and every
 * change is an event, so "who had this laptop in March and what condition did it come back in" is always answerable. Assigning
 * and returning also keep the employee's own asset list (employee_assets) in step, so profiles and reports see the same facts.
 */
@Injectable()
export class AssetRegisterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly inbox?: UserNotificationsService
  ) {}

  // ------------------------------------------------------------------ HR: register

  async list(claims: RequestClaims, filter: { status?: string; category?: string; q?: string; employeeId?: string } = {}): Promise<AssetView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `${ASSET_SELECT}
          WHERE ($1::text IS NULL OR a.status = $1) AND ($2::text IS NULL OR a.category = $2) AND ($3::uuid IS NULL OR a.current_employee_id = $3)
            AND ($4::text IS NULL OR a.asset_tag ILIKE $4 OR a.name ILIKE $4 OR a.serial_number ILIKE $4)
          ORDER BY a.asset_tag LIMIT 1000`,
        [filter.status || null, filter.category || null, filter.employeeId || null, filter.q?.trim() ? `%${filter.q.trim()}%` : null]
      );
      const today = localToday();
      return r.rows.map((x) => toView(x, today));
    });
  }

  async summary(claims: RequestClaims): Promise<AssetSummaryView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const today = localToday();
      const r = await client.query(
        `SELECT status, count(*)::int AS n, COALESCE(sum(purchase_cost), 0) AS cost,
                count(*) FILTER (WHERE warranty_until BETWEEN $1::date AND $1::date + 60 AND status <> 'retired')::int AS warranty_soon,
                count(*) FILTER (WHERE status NOT IN ('retired', 'lost') AND (last_verified_on IS NULL OR last_verified_on < $1::date - 365))::int AS unverified
           FROM asset_register GROUP BY status`,
        [today]
      );
      const out: AssetSummaryView = { total: 0, byStatus: { in_stock: 0, assigned: 0, under_maintenance: 0, lost: 0, retired: 0 }, warrantyExpiringSoon: 0, notVerifiedInYear: 0, totalPurchaseCost: 0 };
      for (const x of r.rows) {
        out.byStatus[x.status as AssetRegisterStatus] = x.n;
        out.total += x.n;
        out.warrantyExpiringSoon += x.warranty_soon;
        out.notVerifiedInYear += x.unverified;
        if (x.status !== "retired") out.totalPurchaseCost += Number(x.cost);
      }
      return out;
    });
  }

  async get(claims: RequestClaims, id: string): Promise<AssetDetailView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.detail(client, id));
  }

  async create(claims: RequestClaims, input: CreateAssetRequest): Promise<AssetDetailView> {
    await this.requireManage(claims);
    const f = this.checkFields(input, true);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const clash = await client.query("SELECT 1 FROM asset_register WHERE company_id = $1 AND lower(asset_tag) = lower($2)", [companyId, f.assetTag]);
      if (clash.rowCount) throw new ConflictException("An asset with that tag already exists");
      const r = await client.query(
        `INSERT INTO asset_register (company_id, asset_tag, name, category, serial_number, vendor, purchase_date, purchase_cost, warranty_until, location, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [companyId, f.assetTag, f.name, f.category, f.serialNumber, f.vendor, f.purchaseDate, f.purchaseCost, f.warrantyUntil, f.location, f.notes, claims.sub]
      );
      await this.event(client, claims, r.rows[0].id, "registered", { note: f.notes });
      await this.audit.record(client, claims, { companyId, action: "asset.create", target: r.rows[0].id, metadata: { tag: f.assetTag } });
      return this.detail(client, r.rows[0].id);
    });
  }

  async update(claims: RequestClaims, id: string, input: UpdateAssetRequest): Promise<AssetDetailView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await this.lock(client, id);
      const merged = {
        assetTag: cur.asset_tag, name: cur.name, category: cur.category, serialNumber: cur.serial_number, vendor: cur.vendor, purchaseDate: iso(cur.purchase_date),
        purchaseCost: num(cur.purchase_cost), warrantyUntil: iso(cur.warranty_until), location: cur.location, notes: cur.notes, ...input,
      } as CreateAssetRequest;
      const f = this.checkFields(merged, false);
      if (f.assetTag.toLowerCase() !== String(cur.asset_tag).toLowerCase()) {
        const clash = await client.query("SELECT 1 FROM asset_register WHERE company_id = $1 AND lower(asset_tag) = lower($2) AND id <> $3", [cur.company_id, f.assetTag, id]);
        if (clash.rowCount) throw new ConflictException("An asset with that tag already exists");
      }
      await client.query(
        `UPDATE asset_register SET asset_tag=$2, name=$3, category=$4, serial_number=$5, vendor=$6, purchase_date=$7, purchase_cost=$8, warranty_until=$9, location=$10, notes=$11, updated_at=now() WHERE id=$1`,
        [id, f.assetTag, f.name, f.category, f.serialNumber, f.vendor, f.purchaseDate, f.purchaseCost, f.warrantyUntil, f.location, f.notes]
      );
      await this.event(client, claims, id, "updated", {});
      await this.audit.record(client, claims, { companyId: cur.company_id, action: "asset.update", target: id });
      return this.detail(client, id);
    });
  }

  // ------------------------------------------------------------------ HR: lifecycle

  async assign(claims: RequestClaims, id: string, input: AssignAssetRequest): Promise<AssetDetailView> {
    await this.requireManage(claims);
    const on = this.dateOrToday(input.occurredOn);
    const cond = this.condition(input.condition);
    const out = await this.db.withClaims(claims, async (client) => {
      const a = await this.lock(client, id);
      if (a.status !== "in_stock") throw new ConflictException(this.notAvailable(a.status));
      const emp = await this.employee(client, input.employeeId);
      const ea = await this.openEmployeeAsset(client, a, emp.id, on);
      await client.query("UPDATE asset_register SET status = 'assigned', current_employee_id = $2, updated_at = now() WHERE id = $1", [id, emp.id]);
      await this.event(client, claims, id, "assigned", { employeeId: emp.id, occurredOn: on, condition: cond, note: input.note, employeeAssetId: ea });
      await this.audit.record(client, claims, { companyId: a.company_id, action: "asset.assign", target: id, metadata: { employeeId: emp.id } });
      return { view: await this.detail(client, id), userId: emp.user_account_id as string | null, a, companyId: a.company_id as string };
    });
    await this.tell(out.companyId, out.userId, `Asset issued to you: ${out.a.name}`, `Tag ${out.a.asset_tag}. Please confirm you received it.`, "/app/ess/assets");
    return out.view;
  }

  async return(claims: RequestClaims, id: string, input: ReturnAssetRequest): Promise<AssetDetailView> {
    await this.requireManage(claims);
    const on = this.dateOrToday(input.occurredOn);
    const cond = this.condition(input.condition);
    const out = await this.db.withClaims(claims, async (client) => {
      const a = await this.lock(client, id);
      if (a.status !== "assigned") throw new ConflictException("This asset is not issued to anyone");
      const holder = await client.query("SELECT user_account_id FROM employees WHERE id = $1", [a.current_employee_id]);
      await this.closeEmployeeAsset(client, id, on);
      // damaged or poor on return goes to maintenance instead of back on the shelf
      const next: AssetRegisterStatus = cond === "damaged" ? "under_maintenance" : "in_stock";
      await client.query("UPDATE asset_register SET status = $2, current_employee_id = NULL, updated_at = now() WHERE id = $1", [id, next]);
      await this.event(client, claims, id, "returned", { employeeId: a.current_employee_id, occurredOn: on, condition: cond, note: input.note });
      await this.audit.record(client, claims, { companyId: a.company_id, action: "asset.return", target: id, metadata: { condition: cond } });
      return { view: await this.detail(client, id), userId: holder.rows[0]?.user_account_id as string | null, a, companyId: a.company_id as string };
    });
    await this.tell(out.companyId, out.userId, `Asset taken back: ${out.a.name}`, `Tag ${out.a.asset_tag} was recorded as returned.`, "/app/ess/assets");
    return out.view;
  }

  async transfer(claims: RequestClaims, id: string, input: AssignAssetRequest): Promise<AssetDetailView> {
    await this.requireManage(claims);
    const on = this.dateOrToday(input.occurredOn);
    const cond = this.condition(input.condition);
    const out = await this.db.withClaims(claims, async (client) => {
      const a = await this.lock(client, id);
      if (a.status !== "assigned") throw new ConflictException("Only an issued asset can be transferred");
      if (a.current_employee_id === input.employeeId) throw new BadRequestException("The asset is already with this person");
      const emp = await this.employee(client, input.employeeId);
      const from = a.current_employee_id as string;
      await this.closeEmployeeAsset(client, id, on);
      const ea = await this.openEmployeeAsset(client, a, emp.id, on);
      await client.query("UPDATE asset_register SET current_employee_id = $2, updated_at = now() WHERE id = $1", [id, emp.id]);
      await this.event(client, claims, id, "transferred", { employeeId: emp.id, fromEmployeeId: from, occurredOn: on, condition: cond, note: input.note, employeeAssetId: ea });
      await this.audit.record(client, claims, { companyId: a.company_id, action: "asset.transfer", target: id, metadata: { from, to: emp.id } });
      return { view: await this.detail(client, id), userId: emp.user_account_id as string | null, a, companyId: a.company_id as string };
    });
    await this.tell(out.companyId, out.userId, `Asset issued to you: ${out.a.name}`, `Tag ${out.a.asset_tag}. Please confirm you received it.`, "/app/ess/assets");
    return out.view;
  }

  async startMaintenance(claims: RequestClaims, id: string, input: AssetMaintenanceRequest): Promise<AssetDetailView> {
    return this.simple(claims, id, "asset.maintenance_start", async (client, a) => {
      if (a.status !== "in_stock") throw new ConflictException(a.status === "assigned" ? "Take the asset back from the employee first" : this.notAvailable(a.status));
      await client.query("UPDATE asset_register SET status = 'under_maintenance', updated_at = now() WHERE id = $1", [id]);
      await this.event(client, claims, id, "maintenance_started", { occurredOn: this.dateOrToday(input.occurredOn), note: input.note });
    });
  }

  async completeMaintenance(claims: RequestClaims, id: string, input: AssetMaintenanceRequest): Promise<AssetDetailView> {
    if (input.cost !== undefined && input.cost !== null && !(Number(input.cost) >= 0)) throw new BadRequestException("The cost cannot be negative");
    return this.simple(claims, id, "asset.maintenance_complete", async (client, a) => {
      if (a.status !== "under_maintenance") throw new ConflictException("This asset is not under maintenance");
      await client.query("UPDATE asset_register SET status = 'in_stock', updated_at = now() WHERE id = $1", [id]);
      await this.event(client, claims, id, "maintenance_completed", { occurredOn: this.dateOrToday(input.occurredOn), note: input.note, cost: input.cost ?? null });
    });
  }

  async markLost(claims: RequestClaims, id: string, input: { occurredOn?: string; note?: string }): Promise<AssetDetailView> {
    return this.simple(claims, id, "asset.lost", async (client, a) => {
      if (!["in_stock", "assigned", "under_maintenance"].includes(a.status)) throw new ConflictException(this.notAvailable(a.status));
      const on = this.dateOrToday(input.occurredOn);
      if (a.status === "assigned") await this.closeEmployeeAsset(client, id, on);
      await client.query("UPDATE asset_register SET status = 'lost', current_employee_id = NULL, updated_at = now() WHERE id = $1", [id]);
      await this.event(client, claims, id, "marked_lost", { employeeId: a.current_employee_id, occurredOn: on, note: input.note });
    });
  }

  async markFound(claims: RequestClaims, id: string, input: { occurredOn?: string; note?: string }): Promise<AssetDetailView> {
    return this.simple(claims, id, "asset.found", async (client, a) => {
      if (a.status !== "lost") throw new ConflictException("This asset is not marked lost");
      await client.query("UPDATE asset_register SET status = 'in_stock', updated_at = now() WHERE id = $1", [id]);
      await this.event(client, claims, id, "found", { occurredOn: this.dateOrToday(input.occurredOn), note: input.note });
    });
  }

  async retire(claims: RequestClaims, id: string, input: RetireAssetRequest): Promise<AssetDetailView> {
    if (!DISPOSALS.includes(input.disposalMethod)) throw new BadRequestException("Choose how the asset left the company: sold, scrapped, donated or returned to the vendor");
    if (input.disposalValue !== undefined && input.disposalValue !== null && !(Number(input.disposalValue) >= 0)) throw new BadRequestException("The disposal value cannot be negative");
    return this.simple(claims, id, "asset.retire", async (client, a) => {
      if (a.status === "retired") throw new ConflictException("Already retired");
      if (a.status === "assigned") throw new ConflictException("Take the asset back from the employee before retiring it");
      const on = this.dateOrToday(input.occurredOn);
      await client.query(
        "UPDATE asset_register SET status = 'retired', retired_on = $2, disposal_method = $3, disposal_value = $4, current_employee_id = NULL, updated_at = now() WHERE id = $1",
        [id, on, input.disposalMethod, input.disposalValue ?? null]
      );
      await this.event(client, claims, id, "retired", { occurredOn: on, note: input.note, cost: input.disposalValue ?? null });
    });
  }

  /** Stock-take: records that these assets were seen today. Retired assets are skipped. */
  async verify(claims: RequestClaims, ids: string[]): Promise<{ verified: number }> {
    await this.requireManage(claims);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new BadRequestException("Choose between 1 and 500 assets");
    return this.db.withClaims(claims, async (client) => {
      const today = localToday();
      const r = await client.query(
        "UPDATE asset_register SET last_verified_on = $2::date, updated_at = now() WHERE id = ANY($1::uuid[]) AND status <> 'retired' RETURNING id",
        [ids, today]
      );
      for (const row of r.rows) await this.event(client, claims, row.id, "verified", { occurredOn: today });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "asset.verify", target: "stock-take", metadata: { count: r.rowCount } });
      return { verified: r.rowCount ?? 0 };
    });
  }

  /** What an employee still holds: the list HR checks before an exit is cleared. */
  async heldBy(claims: RequestClaims, employeeId: string): Promise<AssetView[]> {
    return this.list(claims, { employeeId });
  }

  // ------------------------------------------------------------------ the employee

  async mine(claims: RequestClaims): Promise<MyAssetView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "asset.view.self", { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted to see assets");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT DISTINCT ON (a.id) ev.id AS event_id, a.id AS asset_id, a.asset_tag, a.name, a.category, ev.occurred_on, ev.condition, ev.acknowledged_at
           FROM asset_register a JOIN employees e ON e.id = a.current_employee_id
           JOIN asset_events ev ON ev.asset_id = a.id AND ev.employee_id = e.id AND ev.event_type IN ('assigned', 'transferred')
          WHERE e.user_account_id = $1 AND a.status = 'assigned'
          ORDER BY a.id, ev.created_at DESC`,
        [claims.sub]
      );
      return r.rows.map((x) => ({ eventId: x.event_id, assetId: x.asset_id, assetTag: x.asset_tag, name: x.name, category: x.category, assignedOn: iso(x.occurred_on) as string, condition: x.condition ?? null, acknowledgedAt: x.acknowledged_at ? new Date(x.acknowledged_at).toISOString() : null }));
    });
  }

  async acknowledge(claims: RequestClaims, eventId: string): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE asset_events ev SET acknowledged_at = now()
           FROM employees e, asset_register a
          WHERE ev.id = $1 AND ev.event_type IN ('assigned', 'transferred') AND e.id = ev.employee_id AND e.user_account_id = $2
            AND a.id = ev.asset_id AND a.current_employee_id = e.id AND ev.acknowledged_at IS NULL
        RETURNING ev.asset_id`,
        [eventId, claims.sub]
      );
      if (!r.rowCount) throw new NotFoundException("Nothing to confirm: the asset is not issued to you, or you already confirmed it");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "asset.acknowledge", target: r.rows[0].asset_id });
    });
  }

  // ------------------------------------------------------------------ internals

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async simple(claims: RequestClaims, id: string, action: string, fn: (client: PoolClient, a: Record<string, any>) => Promise<void>): Promise<AssetDetailView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const a = await this.lock(client, id);
      await fn(client, a);
      await this.audit.record(client, claims, { companyId: a.company_id as string, action, target: id });
      return this.detail(client, id);
    });
  }

  private async lock(client: PoolClient, id: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await client.query("SELECT * FROM asset_register WHERE id = $1 FOR UPDATE", [id]);
    if (!r.rowCount) throw new NotFoundException("Asset not found");
    return r.rows[0];
  }

  private async employee(client: PoolClient, id: string): Promise<{ id: string; user_account_id: string | null }> {
    const r = await client.query("SELECT id, user_account_id FROM employees WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Employee not found");
    return r.rows[0];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async openEmployeeAsset(client: PoolClient, a: Record<string, any>, employeeId: string, on: string): Promise<string> {
    const r = await client.query(
      `INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_tag, description, assigned_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [a.company_id, employeeId, CATEGORY_LABEL[a.category as AssetCategory], a.asset_tag, a.name, on]
    );
    return r.rows[0].id;
  }

  /** Closes the open employee_assets row that the latest assignment of this asset created. */
  private async closeEmployeeAsset(client: PoolClient, assetId: string, on: string): Promise<void> {
    const ev = await client.query(
      `SELECT employee_asset_id FROM asset_events WHERE asset_id = $1 AND event_type IN ('assigned', 'transferred') AND employee_asset_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [assetId]
    );
    const eaId = ev.rows[0]?.employee_asset_id;
    if (eaId) await client.query("UPDATE employee_assets SET status = 'returned', returned_date = GREATEST($2::date, assigned_date), updated_at = now() WHERE id = $1 AND status = 'assigned'", [eaId, on]);
  }

  private async event(
    client: PoolClient, claims: RequestClaims, assetId: string, type: AssetEventType,
    e: { employeeId?: string | null; fromEmployeeId?: string | null; occurredOn?: string; condition?: AssetCondition | null; cost?: number | null; note?: string | null; employeeAssetId?: string | null }
  ): Promise<void> {
    await client.query(
      `INSERT INTO asset_events (company_id, asset_id, event_type, employee_id, from_employee_id, occurred_on, condition, cost, note, employee_asset_id, recorded_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8,$9,$10,$11)`,
      [claims.company_id, assetId, type, e.employeeId ?? null, e.fromEmployeeId ?? null, e.occurredOn ?? null, e.condition ?? null, e.cost ?? null, e.note?.trim().slice(0, 1000) || null, e.employeeAssetId ?? null, claims.sub]
    );
  }

  private async detail(client: PoolClient, id: string): Promise<AssetDetailView> {
    const r = await client.query(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
    if (!r.rowCount) throw new NotFoundException("Asset not found");
    const h = await client.query(
      `SELECT ev.*, trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name, trim(concat_ws(' ', f.first_name, f.last_name)) AS from_name
         FROM asset_events ev LEFT JOIN employees e ON e.id = ev.employee_id LEFT JOIN employees f ON f.id = ev.from_employee_id
        WHERE ev.asset_id = $1 ORDER BY ev.created_at DESC, ev.occurred_on DESC LIMIT 200`,
      [id]
    );
    const history: AssetEventView[] = h.rows.map((x) => ({
      id: x.id, eventType: x.event_type, employeeId: x.employee_id ?? null, employeeName: x.employee_name || null, fromEmployeeName: x.from_name || null, occurredOn: iso(x.occurred_on) as string,
      condition: x.condition ?? null, cost: num(x.cost), note: x.note ?? null, acknowledgedAt: x.acknowledged_at ? new Date(x.acknowledged_at).toISOString() : null, recordedAt: new Date(x.created_at).toISOString(),
    }));
    return { ...toView(r.rows[0], localToday()), history };
  }

  private checkFields(i: CreateAssetRequest, create: boolean) {
    const assetTag = (i.assetTag ?? "").trim();
    const name = (i.name ?? "").trim();
    if (!assetTag || assetTag.length > 60) throw new BadRequestException("Enter an asset tag of up to 60 characters");
    if (!name || name.length > 160) throw new BadRequestException("Enter a name of up to 160 characters");
    if (!CATEGORIES.includes(i.category)) throw new BadRequestException("Choose a category");
    for (const [k, v] of [["purchase date", i.purchaseDate], ["warranty date", i.warrantyUntil]] as const) {
      if (v && !DATE_RE.test(v)) throw new BadRequestException(`The ${k} must be a valid date`);
    }
    if (i.purchaseCost !== null && i.purchaseCost !== undefined && !(Number(i.purchaseCost) >= 0)) throw new BadRequestException("The purchase cost cannot be negative");
    if (i.purchaseDate && i.warrantyUntil && i.warrantyUntil < i.purchaseDate) throw new BadRequestException("The warranty cannot end before the purchase date");
    void create;
    const t = (v: string | null | undefined, n: number) => (v?.trim() ? v.trim().slice(0, n) : null);
    return {
      assetTag, name, category: i.category, serialNumber: t(i.serialNumber, 120), vendor: t(i.vendor, 160), purchaseDate: i.purchaseDate || null,
      purchaseCost: i.purchaseCost === undefined || i.purchaseCost === null ? null : Number(i.purchaseCost), warrantyUntil: i.warrantyUntil || null, location: t(i.location, 160), notes: t(i.notes, 1000),
    };
  }

  private dateOrToday(v?: string): string {
    if (v && !DATE_RE.test(v)) throw new BadRequestException("Enter a valid date");
    return v || localToday();
  }

  private condition(v?: AssetCondition): AssetCondition | null {
    if (v && !CONDITIONS.includes(v)) throw new BadRequestException("Choose a valid condition");
    return v ?? null;
  }

  private notAvailable(status: string): string {
    return status === "assigned" ? "This asset is already issued to someone" : status === "retired" ? "This asset is retired" : status === "lost" ? "This asset is marked lost" : status === "under_maintenance" ? "This asset is under maintenance" : "This asset is not available";
  }

  private async tell(companyId: string, userId: string | null, title: string, body: string, link: string): Promise<void> {
    if (!this.inbox || !userId) return;
    await this.inbox.notify({ companyId, userAccountIds: [userId], category: "assets_travel", title, body, link });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "asset.manage"))) throw new ForbiddenException("Not permitted to manage company assets");
  }
}
