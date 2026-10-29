import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { SaveShiftRotationRequest, ShiftRotationView } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const day = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10));

/** Whole days between two YYYY-MM-DD dates, computed at UTC midnight so the server's time zone never shifts the answer. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10)) - Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10))) / 86_400_000);
}

/** The 1-based week of the cycle in force on a date: week 1 starts on the anchor date and the cycle repeats. */
export function rotationWeekFor(anchorIso: string, cycleWeeks: number, dateIso: string): number {
  const weeks = Math.floor(daysBetween(anchorIso, dateIso) / 7);
  return ((weeks % cycleWeeks) + cycleWeeks) % cycleWeeks + 1;
}

/**
 * Rotating shifts: a container schedule (type "rotating") whose members change week by week. Assign the container to
 * employees as usual; `memberFor` is what the schedule resolver calls to find the shift that really applies on a date.
 */
@Injectable()
export class ShiftRotationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  /** The member shift row in force for a container on a date, or null when the container has no rotation set up. */
  static async memberFor(client: PoolClient, containerShiftId: string, dateIso: string): Promise<Record<string, unknown> | null> {
    const r = await client.query(`SELECT id, cycle_weeks, anchor_date FROM shift_rotations WHERE shift_id = $1`, [containerShiftId]);
    if (!r.rowCount) return null;
    const week = rotationWeekFor(day(r.rows[0].anchor_date), r.rows[0].cycle_weeks, dateIso);
    const m = await client.query(
      `SELECT s.* FROM shift_rotation_weeks w JOIN shifts s ON s.id = w.member_shift_id WHERE w.rotation_id = $1 AND w.week_no = $2`,
      [r.rows[0].id, week]
    );
    return m.rows[0] ?? null;
  }

  async get(claims: RequestClaims, shiftId: string): Promise<ShiftRotationView | null> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.load(client, shiftId));
  }

  async save(claims: RequestClaims, shiftId: string, input: SaveShiftRotationRequest): Promise<ShiftRotationView> {
    await this.requireManage(claims);
    if (!Number.isInteger(input.cycleWeeks) || input.cycleWeeks < 2 || input.cycleWeeks > 12) throw new BadRequestException("A rotation repeats every 2 to 12 weeks");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate ?? "")) throw new BadRequestException("Choose the date week 1 starts on");
    const weekNos = input.weeks.map((w) => w.weekNo).sort((a, b) => a - b);
    if (weekNos.length !== input.cycleWeeks || weekNos.some((n, i) => n !== i + 1)) throw new BadRequestException(`Choose a shift for each of the ${input.cycleWeeks} weeks`);
    return this.db.withClaims(claims, async (client) => {
      const container = await client.query("SELECT id, name, schedule_type FROM shifts WHERE id = $1", [shiftId]);
      if (!container.rowCount) throw new NotFoundException("Schedule not found");
      if (container.rows[0].schedule_type !== "rotating") throw new BadRequestException('Only a schedule of type "rotating" can have a rotation. Change its type first.');
      const members = await client.query("SELECT id, schedule_type FROM shifts WHERE id = ANY($1::uuid[])", [[...new Set(input.weeks.map((w) => w.memberShiftId))]]);
      if (members.rowCount !== new Set(input.weeks.map((w) => w.memberShiftId)).size) throw new BadRequestException("One of the chosen shifts does not exist");
      if (members.rows.some((m) => m.id === shiftId || m.schedule_type === "rotating")) throw new BadRequestException("A rotation can only be made of ordinary shifts, not of itself or another rotation");
      const up = await client.query(
        `INSERT INTO shift_rotations (company_id, shift_id, cycle_weeks, anchor_date) VALUES ($1,$2,$3,$4)
         ON CONFLICT (shift_id) DO UPDATE SET cycle_weeks = EXCLUDED.cycle_weeks, anchor_date = EXCLUDED.anchor_date, updated_at = now() RETURNING id`,
        [claims.company_id, shiftId, input.cycleWeeks, input.anchorDate]
      );
      await client.query("DELETE FROM shift_rotation_weeks WHERE rotation_id = $1", [up.rows[0].id]);
      for (const w of input.weeks) {
        await client.query("INSERT INTO shift_rotation_weeks (company_id, rotation_id, week_no, member_shift_id) VALUES ($1,$2,$3,$4)", [claims.company_id, up.rows[0].id, w.weekNo, w.memberShiftId]);
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "shift_rotation.save", target: shiftId, metadata: { cycleWeeks: input.cycleWeeks } });
      return (await this.load(client, shiftId)) as ShiftRotationView;
    });
  }

  async remove(claims: RequestClaims, shiftId: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM shift_rotations WHERE shift_id = $1", [shiftId]);
      if (!r.rowCount) throw new NotFoundException("This schedule has no rotation");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "shift_rotation.remove", target: shiftId });
    });
  }

  private async load(client: PoolClient, shiftId: string): Promise<ShiftRotationView | null> {
    const r = await client.query(
      `SELECT r.id, r.cycle_weeks, r.anchor_date, s.name FROM shift_rotations r JOIN shifts s ON s.id = r.shift_id WHERE r.shift_id = $1`,
      [shiftId]
    );
    if (!r.rowCount) return null;
    const w = await client.query(
      `SELECT w.week_no, w.member_shift_id, s.name FROM shift_rotation_weeks w JOIN shifts s ON s.id = w.member_shift_id WHERE w.rotation_id = $1 ORDER BY w.week_no`,
      [r.rows[0].id]
    );
    return {
      shiftId, shiftName: r.rows[0].name, cycleWeeks: r.rows[0].cycle_weeks, anchorDate: day(r.rows[0].anchor_date),
      weeks: w.rows.map((x) => ({ weekNo: x.week_no, memberShiftId: x.member_shift_id, memberShiftName: x.name })),
    };
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "leave"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "shift.manage.all"))) throw new ForbiddenException("Not permitted to manage shifts");
  }
}
