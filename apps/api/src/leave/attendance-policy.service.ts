import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  AttendanceClockPolicyView, AttendanceGeofenceView, AttendancePolicyView, GeofenceMode, GeofenceResult, LocationExceptionView, LocationFlag,
  SaveAttendanceGeofenceRequest, SelfieMode, UpdateAttendancePolicyRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import { RbacService } from "../rbac/rbac.service";

const MAX_SELFIE_BYTES = 60 * 1024; // the JSON body limit is 100 kB, so a selfie travels as a small 320 px thumbnail
const GEOFENCE_MODES: GeofenceMode[] = ["off", "flag", "block"];
const SELFIE_MODES: SelfieMode[] = ["off", "optional", "required"];

export type LocationInput = { gpsLat?: number; gpsLng?: number; gpsAccuracyM?: number; mockLocation?: boolean; selfie?: string };
export type LocationAssessment = { geofenceResult: GeofenceResult; geofenceId: string | null; flags: LocationFlag[]; selfie: Buffer | null };

/** Great-circle distance in metres. */
export function distanceMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Where a punch happened and who made it. Three independent checks, each off until the company turns it on: the punch must
 * be near an allowed place (geofence), may need a selfie, and the position is screened with simple rules (poor accuracy,
 * impossible travel since the last punch, perfect accuracy, a mock-location report from the app). The screening is a
 * signal for a person to look at, never proof: a poor signal flags an honest person and a careful spoofer may pass.
 */
@Injectable()
export class AttendancePolicyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  // ------------------------------------------------------------------ settings and places (HR)

  async getPolicy(claims: RequestClaims): Promise<AttendancePolicyView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.loadPolicy(client, claims.company_id as string));
  }

  async updatePolicy(claims: RequestClaims, input: UpdateAttendancePolicyRequest): Promise<AttendancePolicyView> {
    await this.requireManage(claims);
    if (input.geofenceMode && !GEOFENCE_MODES.includes(input.geofenceMode)) throw new BadRequestException("Choose off, flag or block for location checks");
    if (input.selfieMode && !SELFIE_MODES.includes(input.selfieMode)) throw new BadRequestException("Choose off, optional or required for selfies");
    if (input.maxGpsAccuracyM !== undefined && input.maxGpsAccuracyM !== null && (!Number.isInteger(input.maxGpsAccuracyM) || input.maxGpsAccuracyM < 5 || input.maxGpsAccuracyM > 5000)) {
      throw new BadRequestException("The accuracy limit must be between 5 and 5000 metres, or empty");
    }
    if (input.maxTravelSpeedKmh !== undefined && (!Number.isInteger(input.maxTravelSpeedKmh) || input.maxTravelSpeedKmh < 20 || input.maxTravelSpeedKmh > 1200)) {
      throw new BadRequestException("The travel speed limit must be between 20 and 1200 km/h");
    }
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const next = { ...(await this.loadPolicy(client, companyId)), ...input };
      if (next.geofenceMode !== "off" && !next.geofences.some((g) => g.isActive)) {
        throw new BadRequestException("Add at least one allowed location before switching location checks on");
      }
      await client.query(
        `INSERT INTO attendance_policy_settings (company_id, geofence_mode, selfie_mode, block_suspect_location, max_gps_accuracy_m, max_travel_speed_kmh, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (company_id) DO UPDATE SET geofence_mode = EXCLUDED.geofence_mode, selfie_mode = EXCLUDED.selfie_mode, block_suspect_location = EXCLUDED.block_suspect_location,
           max_gps_accuracy_m = EXCLUDED.max_gps_accuracy_m, max_travel_speed_kmh = EXCLUDED.max_travel_speed_kmh, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, next.geofenceMode, next.selfieMode, next.blockSuspectLocation, next.maxGpsAccuracyM, next.maxTravelSpeedKmh, claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "attendance_policy.update", target: companyId, metadata: { geofenceMode: next.geofenceMode, selfieMode: next.selfieMode } });
      return this.loadPolicy(client, companyId);
    });
  }

  async saveGeofence(claims: RequestClaims, id: string | null, input: SaveAttendanceGeofenceRequest): Promise<AttendanceGeofenceView> {
    await this.requireManage(claims);
    const name = (input.name ?? "").trim();
    if (!name || name.length > 120) throw new BadRequestException("Give the place a name of up to 120 characters");
    if (!(input.latitude >= -90 && input.latitude <= 90) || !(input.longitude >= -180 && input.longitude <= 180)) throw new BadRequestException("Enter a valid latitude and longitude");
    if (!Number.isInteger(input.radiusM) || input.radiusM < 20 || input.radiusM > 50000) throw new BadRequestException("The radius must be a whole number of metres from 20 to 50,000");
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const clash = await client.query("SELECT 1 FROM attendance_geofences WHERE company_id = $1 AND name = $2 AND ($3::uuid IS NULL OR id <> $3)", [companyId, name, id]);
      if (clash.rowCount) throw new BadRequestException("A place with that name already exists");
      let row;
      if (id) {
        const r = await client.query(
          `UPDATE attendance_geofences SET name = $2, latitude = $3, longitude = $4, radius_m = $5, is_active = COALESCE($6, is_active) WHERE id = $1 RETURNING *`,
          [id, name, input.latitude, input.longitude, input.radiusM, input.isActive ?? null]
        );
        if (!r.rowCount) throw new NotFoundException("Place not found");
        row = r.rows[0];
      } else {
        const r = await client.query(
          `INSERT INTO attendance_geofences (company_id, name, latitude, longitude, radius_m, is_active) VALUES ($1,$2,$3,$4,$5,COALESCE($6,true)) RETURNING *`,
          [companyId, name, input.latitude, input.longitude, input.radiusM, input.isActive ?? null]
        );
        row = r.rows[0];
      }
      await this.audit.record(client, claims, { companyId, action: id ? "attendance_geofence.update" : "attendance_geofence.create", target: row.id, metadata: { name } });
      return this.geofenceView(row);
    });
  }

  async deleteGeofence(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const policy = await this.loadPolicy(client, claims.company_id as string);
      const remaining = policy.geofences.filter((g) => g.isActive && g.id !== id);
      if (policy.geofenceMode !== "off" && remaining.length === 0) throw new BadRequestException("Switch location checks off before removing the last allowed place");
      const r = await client.query("DELETE FROM attendance_geofences WHERE id = $1", [id]);
      if (!r.rowCount) throw new NotFoundException("Place not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "attendance_geofence.delete", target: id });
    });
  }

  // ------------------------------------------------------------------ what the clock-in screen needs

  async getClockPolicy(claims: RequestClaims): Promise<AttendanceClockPolicyView> {
    if (!(await this.entitlements.isModuleEnabled(claims, "leave"))) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const p = await this.loadPolicy(client, claims.company_id as string);
      return { geofenceMode: p.geofenceMode, selfieMode: p.selfieMode, hasGeofences: p.geofences.some((g) => g.isActive) };
    });
  }

  // ------------------------------------------------------------------ the check itself

  /** Runs every enabled check for a clock-in. Throws (a clear message for the employee) when the company blocks it; otherwise returns what to store. */
  async assess(client: PoolClient, companyId: string, employeeId: string, input: LocationInput, now: Date = new Date()): Promise<LocationAssessment> {
    const policy = await this.loadPolicy(client, companyId);
    const hasPosition = typeof input.gpsLat === "number" && typeof input.gpsLng === "number";
    const flags: LocationFlag[] = [];
    let geofenceResult: GeofenceResult = "not_applicable";
    let geofenceId: string | null = null;

    const fences = policy.geofences.filter((g) => g.isActive);
    if (policy.geofenceMode !== "off" && fences.length > 0) {
      if (!hasPosition) {
        if (policy.geofenceMode === "block") throw new BadRequestException("Allow location access to clock in. Your company only accepts clock-ins from its own locations.");
        geofenceResult = "unknown";
      } else {
        const ranked = fences.map((g) => ({ g, d: distanceMetres(input.gpsLat as number, input.gpsLng as number, g.latitude, g.longitude) })).sort((a, b) => a.d - b.d);
        const hit = ranked.find((x) => x.d <= x.g.radiusM);
        if (hit) {
          geofenceResult = "inside";
          geofenceId = hit.g.id;
        } else {
          geofenceResult = "outside";
          if (policy.geofenceMode === "block") {
            throw new BadRequestException(`You are about ${Math.round(ranked[0].d)} m from ${ranked[0].g.name}. Clock in from one of your company's locations, or ask HR.`);
          }
        }
      }
    }

    if (hasPosition) {
      const acc = input.gpsAccuracyM;
      if (typeof acc === "number" && policy.maxGpsAccuracyM !== null && acc > policy.maxGpsAccuracyM) flags.push("low_accuracy");
      if (typeof acc === "number" && acc >= 0 && acc <= 1) flags.push("perfect_accuracy");
      const prev = await client.query(
        `SELECT gps_lat, gps_lng, clock_in_at FROM attendance_records WHERE employee_id = $1 AND gps_lat IS NOT NULL AND clock_in_at > $2::timestamptz - interval '24 hours' AND clock_in_at <= $2::timestamptz ORDER BY clock_in_at DESC LIMIT 1`,
        [employeeId, now.toISOString()]
      );
      if (prev.rowCount) {
        const metres = distanceMetres(Number(prev.rows[0].gps_lat), Number(prev.rows[0].gps_lng), input.gpsLat as number, input.gpsLng as number);
        const hours = Math.max((now.getTime() - new Date(prev.rows[0].clock_in_at).getTime()) / 3_600_000, 1 / 60);
        if (metres > 2000 && metres / 1000 / hours > policy.maxTravelSpeedKmh) flags.push("impossible_travel");
      }
    }
    if (input.mockLocation === true) flags.push("reported_mock_location");
    if (flags.length > 0 && policy.blockSuspectLocation) {
      throw new BadRequestException("Your location could not be trusted for this clock-in. Move to an open area, turn off any location-changing app and try again, or ask HR.");
    }

    let selfie: Buffer | null = null;
    if (input.selfie) selfie = this.decodeSelfie(input.selfie);
    if (policy.selfieMode === "required" && !selfie) throw new BadRequestException("A selfie is required to clock in. Take one and try again.");
    return { geofenceResult, geofenceId, flags, selfie: policy.selfieMode === "off" ? null : selfie };
  }

  async storeSelfie(companyId: string, employeeId: string, buffer: Buffer): Promise<string> {
    return (await this.fileStorage.save(companyId, `selfie-${employeeId}`, "selfie.jpg", buffer)).storagePath;
  }

  // ------------------------------------------------------------------ HR review

  async listExceptions(claims: RequestClaims, from: string, to: string): Promise<LocationExceptionView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, "leave"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "attendance.record.all"))) throw new ForbiddenException("Not permitted to review attendance");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new BadRequestException("Choose a valid date range");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT a.id, a.employee_id, a.employee_number, a.work_date, a.clock_in_at, a.geofence_result, a.location_flags, a.gps_lat, a.gps_lng, a.gps_accuracy_m,
                (a.selfie_path IS NOT NULL) AS has_selfie, g.name AS geofence_name,
                trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name
           FROM attendance_records a JOIN employees e ON e.id = a.employee_id LEFT JOIN attendance_geofences g ON g.id = a.geofence_id
          WHERE a.work_date BETWEEN $1::date AND $2::date AND (a.geofence_result IN ('outside', 'unknown') OR cardinality(a.location_flags) > 0)
          ORDER BY a.clock_in_at DESC LIMIT 500`,
        [from, to]
      );
      return r.rows.map((x) => ({
        recordId: x.id, employeeId: x.employee_id, employeeNumber: x.employee_number, employeeName: x.employee_name, workDate: new Date(x.work_date).toISOString().slice(0, 10),
        clockInAt: new Date(x.clock_in_at).toISOString(), geofenceResult: x.geofence_result, geofenceName: x.geofence_name ?? null, flags: x.location_flags,
        gpsLat: x.gps_lat === null ? null : Number(x.gps_lat), gpsLng: x.gps_lng === null ? null : Number(x.gps_lng), gpsAccuracyM: x.gps_accuracy_m === null ? null : Number(x.gps_accuracy_m), hasSelfie: x.has_selfie,
      }));
    });
  }

  /** A selfie is personal data: only the person themselves or someone allowed to see everyone's attendance may open it. */
  async readSelfie(claims: RequestClaims, recordId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!(await this.entitlements.isModuleEnabled(claims, "leave"))) throw new NotFoundException();
    const row = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT a.selfie_path, a.selfie_mime, e.user_account_id FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE a.id = $1`,
        [recordId]
      );
      if (!r.rowCount || !r.rows[0].selfie_path) throw new NotFoundException("No selfie for this clock-in");
      const own = r.rows[0].user_account_id === claims.sub;
      if (!own && !(await this.rbac.can(claims, "attendance.record.all"))) throw new ForbiddenException("Not permitted to see this selfie");
      return r.rows[0];
    });
    return { buffer: await this.fileStorage.read(row.selfie_path), mimeType: row.selfie_mime ?? "image/jpeg" };
  }

  // ------------------------------------------------------------------ internals

  private decodeSelfie(dataUrl: string): Buffer {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new BadRequestException("The selfie must be a JPEG photo");
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > MAX_SELFIE_BYTES) throw new BadRequestException("The selfie is too large (limit 60 KB). Take it again.");
    if (!(buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new BadRequestException("The selfie must be a JPEG photo");
    return buf;
  }

  private geofenceView(x: Record<string, unknown>): AttendanceGeofenceView {
    return { id: x.id as string, name: x.name as string, latitude: Number(x.latitude), longitude: Number(x.longitude), radiusM: x.radius_m as number, isActive: x.is_active as boolean };
  }

  private async loadPolicy(client: PoolClient, companyId: string): Promise<AttendancePolicyView> {
    const s = await client.query("SELECT * FROM attendance_policy_settings WHERE company_id = $1", [companyId]);
    const g = await client.query("SELECT * FROM attendance_geofences WHERE company_id = $1 ORDER BY name", [companyId]);
    const row = s.rows[0];
    return {
      geofenceMode: row?.geofence_mode ?? "off", selfieMode: row?.selfie_mode ?? "off", blockSuspectLocation: row?.block_suspect_location ?? false,
      maxGpsAccuracyM: row?.max_gps_accuracy_m ?? null, maxTravelSpeedKmh: row?.max_travel_speed_kmh ?? 250, geofences: g.rows.map((x) => this.geofenceView(x)),
    };
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "leave"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "attendance_policy.manage"))) throw new ForbiddenException("Not permitted to manage attendance rules");
  }
}
