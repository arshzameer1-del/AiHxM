import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { localParts } from "./attendance-evaluation.service";

const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Karachi";
/** Marker kept in attendance_records.derived_status for a clock-out the system filled in (no schema change needed). */
export const AUTO_CLOSED_STATUS = "auto_closed";

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The instant at which the wall clock of `tz` reads `date` `HH:mm` (a plain two-pass offset correction, no DST in Pakistan). */
export function instantOfLocalTime(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    guess += wanted - shown;
  }
  return new Date(guess);
}

type OpenRow = { id: string; company_id: string; employee_id: string; clock_in_at: Date; work_date: string | Date | null };

/**
 * A clock-in with no clock-out when the day is over is closed by the system at the day's shift end time (never later than
 * the day, never before the clock-in). Nothing is invented when there is no shift end to use (day off, no schedule): such a
 * record stays open and is fixed with an attendance correction, as before.
 *
 * Runs in two places: every hour for every company (the scheduler) and, for just that person, whenever they clock in, clock
 * out or open their attendance (so the answer is right even if the server slept through the hourly run).
 */
@Injectable()
export class AttendanceAutoCloseService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly workSchedule: WorkScheduleResolutionService
  ) {}

  /** Closes this person's forgotten clock-outs from earlier days, inside the caller's transaction. Returns how many were closed. */
  async closeForgottenForEmployee(client: PoolClient, claims: RequestClaims, employeeId: string): Promise<number> {
    const today = localParts(new Date(), DEFAULT_SCHEDULE_TIMEZONE).date;
    const rows = await client.query<OpenRow>(
      `SELECT id, company_id, employee_id, clock_in_at, work_date FROM attendance_records
        WHERE employee_id = $1 AND clock_out_at IS NULL
          AND COALESCE(work_date, (clock_in_at AT TIME ZONE 'Asia/Karachi')::date) < $2::date
        ORDER BY clock_in_at`,
      [employeeId, today]
    );
    let closed = 0;
    for (const row of rows.rows) if (await this.closeOne(client, claims, row)) closed++;
    return closed;
  }

  /** Every company: all forgotten clock-outs from days before today. */
  async closeAllDue(limit = 500): Promise<number> {
    const sweeper = { is_platform_admin: false, is_service: true, sub: "system", company_id: null } as RequestClaims;
    const today = localParts(new Date(), DEFAULT_SCHEDULE_TIMEZONE).date;
    const due = await this.db.withClaims(sweeper, async (client) => {
      const r = await client.query<OpenRow>(
        `SELECT id, company_id, employee_id, clock_in_at, work_date FROM attendance_records
          WHERE clock_out_at IS NULL
            AND COALESCE(work_date, (clock_in_at AT TIME ZONE 'Asia/Karachi')::date) < $1::date
          ORDER BY clock_in_at LIMIT $2`,
        [today, limit]
      );
      return r.rows;
    });
    let closed = 0;
    for (const row of due) {
      const claims = { is_platform_admin: false, is_service: true, sub: "system", company_id: row.company_id } as RequestClaims;
      const ok = await this.db.withClaims(claims, (client) => this.closeOne(client, claims, row));
      if (ok) closed++;
    }
    return closed;
  }

  private async closeOne(client: PoolClient, claims: RequestClaims, row: OpenRow): Promise<boolean> {
    const workDate =
      row.work_date instanceof Date ? row.work_date.toISOString().slice(0, 10) : row.work_date ? String(row.work_date).slice(0, 10) : localParts(row.clock_in_at, DEFAULT_SCHEDULE_TIMEZONE).date;
    const day = await this.workSchedule.resolve(client, row.employee_id, workDate);
    const endTime = day.endTime ?? day.flexibleEndTime ?? day.coreEndTime;
    if (!endTime || (!day.isWorking && !day.isHalfDay)) return false;
    const tz = day.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
    const startMinutes = day.startTime ? Number(day.startTime.split(":")[0]) * 60 + Number(day.startTime.split(":")[1]) : null;
    const endMinutes = Number(endTime.split(":")[0]) * 60 + Number(endTime.split(":")[1]);
    const overnight = day.crossesMidnight || (startMinutes !== null && endMinutes <= startMinutes);
    let closeAt = instantOfLocalTime(overnight ? addDays(workDate, 1) : workDate, endTime.slice(0, 5), tz);
    if (closeAt.getTime() < row.clock_in_at.getTime()) closeAt = row.clock_in_at;

    const result = await client.query(
      `UPDATE attendance_records SET clock_out_at = GREATEST($2::timestamptz, clock_in_at), derived_status = $3 WHERE id = $1 AND clock_out_at IS NULL RETURNING id`,
      [row.id, closeAt, AUTO_CLOSED_STATUS]
    );
    if (result.rowCount === 0) return false;
    await this.audit.record(client, claims, {
      companyId: row.company_id,
      action: "attendance.auto_clock_out",
      target: row.id,
      metadata: { workDate, clockOutAt: closeAt.toISOString(), reason: "No clock-out by the end of the day; set to the shift end time" },
    });
    return true;
  }
}
