import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CreateHolidayCalendarRequest, HolidayCalendarView, UpdateHolidayCalendarRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const MODULE_KEY = "leave" as const;

/**
 * TLM-10 - named holiday calendars with applicability by location or org unit. The company-wide
 * holidays (no calendar) always apply; a calendar adds holidays for the places it is scoped to.
 * A calendar with no scope applies to everyone, so "Pakistan public holidays" and a "Sindh
 * provincial" calendar can live side by side.
 */
@Injectable()
export class HolidayCalendarsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  private async requireManage(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "holiday.manage.all"))) throw new ForbiddenException("Not permitted to manage holiday calendars");
  }

  private async requireView(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "holiday.manage.all")) && !(await this.rbac.can(claims, "holiday.view.all"))) {
      throw new ForbiddenException("Not permitted to view holiday calendars");
    }
  }

  private async view(client: PoolClient, id: string): Promise<HolidayCalendarView> {
    const c = await client.query("SELECT * FROM holiday_calendars WHERE id = $1", [id]);
    if (c.rowCount === 0) throw new NotFoundException("Holiday calendar not found");
    const scope = await client.query("SELECT location_id, org_unit_id FROM holiday_calendar_applicability WHERE calendar_id = $1", [id]);
    const count = await client.query("SELECT count(*)::int AS n FROM holidays WHERE calendar_id = $1", [id]);
    return {
      id: c.rows[0].id,
      name: c.rows[0].name,
      description: c.rows[0].description,
      status: c.rows[0].status,
      locationIds: scope.rows.filter((r) => r.location_id).map((r) => r.location_id as string),
      orgUnitIds: scope.rows.filter((r) => r.org_unit_id).map((r) => r.org_unit_id as string),
      holidayCount: count.rows[0].n,
    };
  }

  private async writeScope(client: PoolClient, companyId: string, calendarId: string, locationIds: string[] | undefined, orgUnitIds: string[] | undefined) {
    if (locationIds !== undefined) {
      if (locationIds.length > 0) {
        const ok = await client.query("SELECT count(*)::int AS n FROM locations WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, locationIds]);
        if (ok.rows[0].n !== new Set(locationIds).size) throw new NotFoundException("One or more locations were not found");
      }
      await client.query("DELETE FROM holiday_calendar_applicability WHERE calendar_id = $1 AND location_id IS NOT NULL", [calendarId]);
      for (const id of new Set(locationIds)) {
        await client.query("INSERT INTO holiday_calendar_applicability (company_id, calendar_id, location_id) VALUES ($1,$2,$3)", [companyId, calendarId, id]);
      }
    }
    if (orgUnitIds !== undefined) {
      if (orgUnitIds.length > 0) {
        const ok = await client.query("SELECT count(*)::int AS n FROM org_units WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, orgUnitIds]);
        if (ok.rows[0].n !== new Set(orgUnitIds).size) throw new NotFoundException("One or more organisation units were not found");
      }
      await client.query("DELETE FROM holiday_calendar_applicability WHERE calendar_id = $1 AND org_unit_id IS NOT NULL", [calendarId]);
      for (const id of new Set(orgUnitIds)) {
        await client.query("INSERT INTO holiday_calendar_applicability (company_id, calendar_id, org_unit_id) VALUES ($1,$2,$3)", [companyId, calendarId, id]);
      }
    }
  }

  async list(claims: RequestClaims, includeArchived = false): Promise<HolidayCalendarView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT id FROM holiday_calendars WHERE company_id = $1 ${includeArchived ? "" : "AND status = 'active'"} ORDER BY name`,
        [claims.company_id]
      );
      const out: HolidayCalendarView[] = [];
      for (const row of r.rows) out.push(await this.view(client, row.id));
      return out;
    });
  }

  async create(claims: RequestClaims, input: CreateHolidayCalendarRequest): Promise<HolidayCalendarView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      try {
        const r = await client.query(
          "INSERT INTO holiday_calendars (company_id, name, description) VALUES ($1,$2,$3) RETURNING id",
          [claims.company_id, input.name.trim(), input.description ?? null]
        );
        await this.writeScope(client, claims.company_id!, r.rows[0].id, input.locationIds ?? [], input.orgUnitIds ?? []);
        await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "holiday_calendar.create", target: r.rows[0].id, metadata: { name: input.name } });
        return this.view(client, r.rows[0].id);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`A holiday calendar named "${input.name}" already exists`);
        throw err;
      }
    });
  }

  async update(claims: RequestClaims, id: string, input: UpdateHolidayCalendarRequest): Promise<HolidayCalendarView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM holiday_calendars WHERE id = $1 AND company_id = $2", [id, claims.company_id]);
      if (cur.rowCount === 0) throw new NotFoundException("Holiday calendar not found");
      try {
        await client.query(
          "UPDATE holiday_calendars SET name = $2, description = $3, status = $4, updated_at = now() WHERE id = $1",
          [id, input.name?.trim() ?? cur.rows[0].name, input.description !== undefined ? input.description : cur.rows[0].description, input.status ?? cur.rows[0].status]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`A holiday calendar named "${input.name}" already exists`);
        throw err;
      }
      await this.writeScope(client, claims.company_id!, id, input.locationIds, input.orgUnitIds);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "holiday_calendar.update", target: id });
      return this.view(client, id);
    });
  }
}
