import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { localParts } from "./attendance-evaluation.service";
import { STALE_OPEN_CLOCK_IN_HOURS } from "./attendance.service";
import type {
  AttendanceDeviceView,
  AttendanceDeviceWithKey,
  CreateAttendanceDeviceRequest,
  DeviceEnrollmentView,
  DevicePunchInput,
  EnrollDeviceUserRequest,
  IngestPunchesResult,
  RawPunchView,
  UpdateAttendanceDeviceRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "leave" as const;
const DEVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "attendance-device" };
/** A second punch by the same person within this window is a double tap, not a new event. */
export const DOUBLE_TAP_SECONDS = 60;
const MAX_BATCH = 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function hashDeviceKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDevice(row: any, enrolledCount = 0): AttendanceDeviceView {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    vendor: row.vendor,
    serialNumber: row.serial_number,
    locationId: row.location_id,
    timezone: row.timezone,
    isActive: row.is_active,
    hasApiKey: Boolean(row.api_key_hash),
    apiKeyPrefix: row.api_key_prefix,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    enrolledCount,
  };
}

/**
 * Gap Register TLM-05 - biometric / card / mobile devices, enrolments and raw punch ingestion.
 *
 * A device authenticates with a per-device key (only its SHA-256 hash is stored; the plaintext
 * is shown once at creation / rotation) and posts batches of punches. Each punch is first
 * stored in `raw_punches` under an idempotency key (the device's own event id when it sends
 * one, otherwise a hash of device-user + time + direction), so re-sending a batch - which
 * devices do after a network drop - never creates a second record. A stored punch is then
 * resolved through the device enrolment to an employee and turned into an `attendance_records`
 * clock-in / clock-out, or marked unmatched / duplicate / rejected with the reason. Enrolling
 * a device user afterwards re-processes that user's unmatched punches in time order.
 */
@Injectable()
export class AttendanceDevicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------ HR: devices

  async listDevices(claims: RequestClaims): Promise<AttendanceDeviceView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT d.*, (SELECT count(*)::int FROM device_enrollments e WHERE e.device_id = d.id AND e.status = 'active') AS enrolled
           FROM attendance_devices d ORDER BY d.name`
      );
      return r.rows.map((row) => toDevice(row, row.enrolled));
    });
  }

  async createDevice(claims: RequestClaims, input: CreateAttendanceDeviceRequest): Promise<AttendanceDeviceWithKey> {
    await this.requireManage(claims);
    const key = this.newKey();
    return this.db.withClaims(claims, async (client) => {
      const dup = await client.query("SELECT 1 FROM attendance_devices WHERE company_id = $1 AND name = $2", [claims.company_id, input.name]);
      if ((dup.rowCount ?? 0) > 0) throw new ConflictException(`A device named "${input.name}" already exists`);
      try {
        const r = await client.query(
          `INSERT INTO attendance_devices (company_id, name, device_type, vendor, serial_number, location_id, timezone, api_key_hash, api_key_prefix)
           VALUES ($1,$2,COALESCE($3,'biometric'),$4,$5,$6,COALESCE($7,'Asia/Karachi'),$8,$9) RETURNING *`,
          [claims.company_id, input.name, input.deviceType ?? null, input.vendor ?? null, input.serialNumber ?? null, input.locationId ?? null, input.timezone ?? null, hashDeviceKey(key), key.slice(0, 11)]
        );
        await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "attendance_device.create", target: r.rows[0].id, metadata: { name: input.name } });
        return { ...toDevice(r.rows[0]), apiKey: key };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException("A device with that serial number already exists");
        throw err;
      }
    });
  }

  async updateDevice(claims: RequestClaims, id: string, patch: UpdateAttendanceDeviceRequest): Promise<AttendanceDeviceView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cols: Array<[string, unknown]> = [
        ["name", patch.name], ["device_type", patch.deviceType], ["vendor", patch.vendor], ["serial_number", patch.serialNumber],
        ["location_id", patch.locationId], ["timezone", patch.timezone], ["is_active", patch.isActive],
      ];
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const [column, value] of cols) {
        if (value !== undefined) {
          vals.push(value);
          sets.push(`${column} = $${vals.length}`);
        }
      }
      if (sets.length === 0) {
        const cur = await client.query("SELECT * FROM attendance_devices WHERE id = $1", [id]);
        if (cur.rowCount === 0) throw new NotFoundException("Device not found");
        return toDevice(cur.rows[0]);
      }
      const r = await client.query(`UPDATE attendance_devices SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
      if (r.rowCount === 0) throw new NotFoundException("Device not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "attendance_device.update", target: id, metadata: { fields: Object.keys(patch) } });
      return toDevice(r.rows[0]);
    });
  }

  async rotateKey(claims: RequestClaims, id: string): Promise<AttendanceDeviceWithKey> {
    await this.requireManage(claims);
    const key = this.newKey();
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE attendance_devices SET api_key_hash = $2, api_key_prefix = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, hashDeviceKey(key), key.slice(0, 11)]
      );
      if (r.rowCount === 0) throw new NotFoundException("Device not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "attendance_device.rotate_key", target: id });
      return { ...toDevice(r.rows[0]), apiKey: key };
    });
  }

  // ------------------------------------------------------------ HR: enrolments

  async listEnrollments(claims: RequestClaims, deviceId: string): Promise<DeviceEnrollmentView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT en.*, e.first_name, e.last_name FROM device_enrollments en JOIN employees e ON e.id = en.employee_id
          WHERE en.device_id = $1 ORDER BY en.status, e.first_name, e.last_name`,
        [deviceId]
      );
      return r.rows.map((row) => ({
        id: row.id, deviceId: row.device_id, employeeId: row.employee_id, employeeName: `${row.first_name} ${row.last_name}`,
        deviceUserId: row.device_user_id, status: row.status, enrolledAt: row.enrolled_at.toISOString(),
      }));
    });
  }

  async enroll(claims: RequestClaims, deviceId: string, input: EnrollDeviceUserRequest): Promise<{ enrollment: DeviceEnrollmentView; reprocessed: number }> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const device = await client.query("SELECT company_id FROM attendance_devices WHERE id = $1", [deviceId]);
      if (device.rowCount === 0) throw new NotFoundException("Device not found");
      const emp = await client.query("SELECT first_name, last_name FROM employees WHERE id = $1", [input.employeeId]);
      if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
      const deviceUserId = input.deviceUserId.trim();
      if (!deviceUserId) throw new BadRequestException("The device user id is required");
      const taken = await client.query("SELECT employee_id, status FROM device_enrollments WHERE device_id = $1 AND device_user_id = $2", [deviceId, deviceUserId]);
      if (taken.rows[0]?.status === "active" && taken.rows[0].employee_id !== input.employeeId) {
        throw new ConflictException("That device user id is already enrolled for another employee");
      }
      const dupEmp = await client.query("SELECT 1 FROM device_enrollments WHERE device_id = $1 AND employee_id = $2 AND status = 'active' AND device_user_id <> $3", [deviceId, input.employeeId, deviceUserId]);
      if ((dupEmp.rowCount ?? 0) > 0) throw new ConflictException("This employee is already enrolled on that device under a different id");
      const r = await client.query(
        `INSERT INTO device_enrollments (company_id, device_id, employee_id, device_user_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (device_id, device_user_id) DO UPDATE SET employee_id = EXCLUDED.employee_id, status = 'active', revoked_at = NULL, enrolled_at = now()
         RETURNING *`,
        [device.rows[0].company_id, deviceId, input.employeeId, deviceUserId]
      );
      await this.audit.record(client, claims, {
        companyId: device.rows[0].company_id, action: "device_enrollment.create", target: r.rows[0].id, metadata: { deviceId, employeeId: input.employeeId },
      });
      const reprocessed = await this.reprocessUnmatched(client, deviceId, deviceUserId);
      return {
        enrollment: {
          id: r.rows[0].id, deviceId, employeeId: input.employeeId, employeeName: `${emp.rows[0].first_name} ${emp.rows[0].last_name}`,
          deviceUserId, status: "active", enrolledAt: r.rows[0].enrolled_at.toISOString(),
        },
        reprocessed,
      };
    });
  }

  async revokeEnrollment(claims: RequestClaims, deviceId: string, enrollmentId: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE device_enrollments SET status = 'revoked', revoked_at = now() WHERE id = $1 AND device_id = $2 AND status = 'active' RETURNING id`,
        [enrollmentId, deviceId]
      );
      if (r.rowCount === 0) throw new NotFoundException("Active enrolment not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "device_enrollment.revoke", target: enrollmentId });
    });
  }

  async listPunches(claims: RequestClaims, filter: { deviceId?: string; status?: string; limit?: number }): Promise<RawPunchView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM raw_punches WHERE ($1::uuid IS NULL OR device_id = $1) AND ($2::text IS NULL OR status = $2)
          ORDER BY punched_at DESC LIMIT $3`,
        [filter.deviceId ?? null, filter.status ?? null, Math.min(filter.limit ?? 200, 1000)]
      );
      return r.rows.map((row) => ({
        id: row.id, deviceId: row.device_id, deviceUserId: row.device_user_id, employeeId: row.employee_id, punchedAt: row.punched_at.toISOString(),
        direction: row.direction, status: row.status, attendanceRecordId: row.attendance_record_id, error: row.error, receivedAt: row.received_at.toISOString(),
      }));
    });
  }

  // ------------------------------------------------------------ device: ingestion

  /** Resolves a device by id + presented key (constant-time compare is unnecessary for a hash lookup, but the key never leaves the hash). */
  async authenticate(deviceId: string, presentedKey: string): Promise<{ companyId: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(deviceId) || !presentedKey) return null;
    return this.db.withClaims(DEVICE_CLAIMS, async (client) => {
      const r = await client.query(
        "SELECT company_id FROM attendance_devices WHERE id = $1 AND is_active AND api_key_hash = $2",
        [deviceId, hashDeviceKey(presentedKey)]
      );
      return r.rows[0] ? { companyId: r.rows[0].company_id as string } : null;
    });
  }

  async ingest(companyId: string, deviceId: string, punches: DevicePunchInput[]): Promise<IngestPunchesResult> {
    if (!Array.isArray(punches) || punches.length === 0) throw new BadRequestException("No punches supplied");
    if (punches.length > MAX_BATCH) throw new BadRequestException(`A batch is limited to ${MAX_BATCH} punches`);
    const claims: RequestClaims = { ...DEVICE_CLAIMS, company_id: companyId };
    const result: IngestPunchesResult = { received: punches.length, processed: 0, duplicates: 0, unmatched: 0, rejected: 0 };
    const sorted = [...punches].sort((a, b) => a.punchedAt.localeCompare(b.punchedAt));
    await this.db.withClaims(claims, async (client) => {
      await client.query("UPDATE attendance_devices SET last_seen_at = now() WHERE id = $1", [deviceId]);
      for (const p of sorted) {
        const at = new Date(p.punchedAt);
        if (Number.isNaN(at.getTime()) || !p.deviceUserId?.toString().trim()) {
          result.rejected++;
          continue;
        }
        const deviceUserId = String(p.deviceUserId).trim();
        const direction = p.direction === "in" || p.direction === "out" ? p.direction : "unknown";
        const key = p.externalId?.trim() || createHash("sha256").update(`${deviceUserId}|${at.toISOString()}|${direction}`).digest("hex");
        const ins = await client.query(
          `INSERT INTO raw_punches (company_id, device_id, device_user_id, punched_at, direction, idempotency_key, raw_payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (device_id, idempotency_key) DO NOTHING RETURNING id`,
          [companyId, deviceId, deviceUserId, at, direction, key, JSON.stringify(p)]
        );
        if (ins.rowCount === 0) {
          result.duplicates++;
          continue;
        }
        const outcome = await this.processPunch(client, ins.rows[0].id);
        if (outcome === "processed") result.processed++;
        else if (outcome === "duplicate") result.duplicates++;
        else if (outcome === "unmatched") result.unmatched++;
        else result.rejected++;
      }
    });
    return result;
  }

  /** Processes one stored punch: resolve the employee, then open / close an attendance record. */
  async processPunch(client: PoolClient, punchId: string): Promise<"processed" | "duplicate" | "unmatched" | "rejected"> {
    const punch = (await client.query("SELECT * FROM raw_punches WHERE id = $1 FOR UPDATE", [punchId])).rows[0];
    const finish = async (status: string, error: string | null, employeeId: string | null, recordId: string | null = null) => {
      await client.query(
        `UPDATE raw_punches SET status = $2, error = $3, employee_id = $4, attendance_record_id = $5, processed_at = now() WHERE id = $1`,
        [punchId, status, error, employeeId, recordId]
      );
      return status as "processed" | "duplicate" | "unmatched" | "rejected";
    };

    const enrollment = await client.query(
      `SELECT en.employee_id, e.employee_number, e.termination_date, e.company_id
         FROM device_enrollments en JOIN employees e ON e.id = en.employee_id
        WHERE en.device_id = $1 AND en.device_user_id = $2 AND en.status = 'active'`,
      [punch.device_id, punch.device_user_id]
    );
    if (enrollment.rowCount === 0) return finish("unmatched", `No active enrolment for device user "${punch.device_user_id}"`, null);
    const emp = enrollment.rows[0];
    const at: Date = punch.punched_at;
    if (at.getTime() > Date.now() + FUTURE_SKEW_MS) return finish("rejected", "Punch time is in the future", emp.employee_id);
    if (emp.termination_date && at.toISOString().slice(0, 10) > new Date(emp.termination_date).toISOString().slice(0, 10)) {
      return finish("rejected", "Employee left before this punch", emp.employee_id);
    }

    // double tap
    const near = await client.query(
      `SELECT id FROM attendance_records WHERE employee_id = $1
         AND (abs(extract(epoch FROM (clock_in_at - $2::timestamptz))) < $3 OR (clock_out_at IS NOT NULL AND abs(extract(epoch FROM (clock_out_at - $2::timestamptz))) < $3))
        LIMIT 1`,
      [emp.employee_id, at, DOUBLE_TAP_SECONDS]
    );
    if ((near.rowCount ?? 0) > 0) return finish("duplicate", "Within the double-tap window of an existing punch", emp.employee_id, near.rows[0].id);

    const openRow = (await client.query("SELECT * FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL ORDER BY clock_in_at DESC LIMIT 1", [emp.employee_id])).rows[0];
    // LIVE-13: a clock-in left open since before the staleness window is a forgotten clock-out; today's punch starts a new
    // shift and the old record waits for an attendance correction (its hours are never invented).
    const open = openRow && at.getTime() - new Date(openRow.clock_in_at).getTime() < STALE_OPEN_CLOCK_IN_HOURS * 3600000 ? openRow : undefined;
    const direction: "in" | "out" = punch.direction === "unknown" ? (open ? "out" : "in") : punch.direction;

    if (direction === "in") {
      if (open) return finish("duplicate", "Already clocked in", emp.employee_id, open.id);
      const device = (await client.query("SELECT timezone FROM attendance_devices WHERE id = $1", [punch.device_id])).rows[0];
      const workDate = localParts(at, device?.timezone ?? "Asia/Karachi").date;
      const rec = await client.query(
        `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, device_id, work_date)
         VALUES ($1,$2,$3,'biometric',$4,$5,$6) RETURNING id`,
        [emp.company_id, emp.employee_id, emp.employee_number, at, punch.device_id, workDate]
      );
      return finish("processed", null, emp.employee_id, rec.rows[0].id);
    }
    if (!open) return finish("rejected", "Clock-out with no open clock-in", emp.employee_id);
    if (at < open.clock_in_at) return finish("rejected", "Clock-out is earlier than the open clock-in", emp.employee_id);
    await client.query("UPDATE attendance_records SET clock_out_at = $2 WHERE id = $1", [open.id, at]);
    return finish("processed", null, emp.employee_id, open.id);
  }

  /** After an enrolment, unmatched punches of that device user are processed in time order. */
  private async reprocessUnmatched(client: PoolClient, deviceId: string, deviceUserId: string): Promise<number> {
    const pending = await client.query(
      `SELECT id FROM raw_punches WHERE device_id = $1 AND device_user_id = $2 AND status = 'unmatched' ORDER BY punched_at`,
      [deviceId, deviceUserId]
    );
    let processed = 0;
    for (const row of pending.rows) {
      if ((await this.processPunch(client, row.id)) === "processed") processed++;
    }
    return processed;
  }

  private newKey(): string {
    return `dk_${randomBytes(24).toString("hex")}`;
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "attendance.record.all"))) throw new ForbiddenException("Not permitted to manage attendance devices");
  }
}
