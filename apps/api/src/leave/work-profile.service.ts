import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CompanyWorkTimeDefaultView, EmployeeWorkProfileView, TimeRecordingProfile } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EffectiveDatingEngine, toIsoDate } from "../effective-dating/effective-dating.engine";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { SetCompanyWorkTimeDefaultDto, SetWorkProfileDto } from "./dto/work-profile.dto";
import { BUILT_IN_STANDARD_MONTHLY_HOURS, writeCompanyWorkTimeDefault } from "./work-time-defaults";

const LEAVE_MODULE_KEY = "leave" as const;
/** weeks per month used when only weekly hours are given (52 / 12). */
const WEEKS_PER_MONTH = 52 / 12;

type ProfileRow = {
  id: string;
  employee_id: string;
  employment_percentage: string;
  weekly_hours: string | null;
  monthly_hours: string | null;
  is_part_time: boolean;
  time_recording_profile: TimeRecordingProfile;
  notes: string | null;
  effective_from: unknown;
  effective_to: unknown;
};

function rowToView(row: ProfileRow): EmployeeWorkProfileView {
  const weekly = row.weekly_hours === null ? null : Number(row.weekly_hours);
  const monthly = row.monthly_hours === null ? null : Number(row.monthly_hours);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employmentPercentage: Number(row.employment_percentage),
    weeklyHours: weekly,
    monthlyHours: monthly,
    effectiveMonthlyHours: monthly ?? (weekly === null ? null : Math.round(weekly * WEEKS_PER_MONTH * 100) / 100),
    isPartTime: row.is_part_time,
    timeRecordingProfile: row.time_recording_profile,
    notes: row.notes,
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: row.effective_to ? toIsoDate(row.effective_to) : null,
  };
}

/**
 * TLM-08 - planned working time per employee, effective-dated. No row means "full time, clock
 * recording, tenant-wide hours": nothing changes for an employee nobody has configured. Other
 * modules read it through the client-taking helpers below (overtime pricing, attendance
 * evaluation) so the rule "which hours apply to this person on this day" lives in one place.
 */
@Injectable()
export class WorkProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  // ---- cross-module reads (caller has authorised) ---------------------------------------

  async getAsOf(client: PoolClient, employeeId: string, date: string): Promise<EmployeeWorkProfileView | null> {
    const r = await client.query<ProfileRow>(
      `SELECT * FROM employee_work_profiles
        WHERE employee_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC LIMIT 1`,
      [employeeId, date]
    );
    return r.rows[0] ? rowToView(r.rows[0]) : null;
  }

  /** The monthly hours divisor this employee's profile fixes, or null to use the tenant-wide figure. */
  async monthlyHoursAsOf(client: PoolClient, employeeId: string, date: string): Promise<number | null> {
    return (await this.getAsOf(client, employeeId, date))?.effectiveMonthlyHours ?? null;
  }

  // ---- API ----------------------------------------------------------------------------

  private async loadEmployee(client: PoolClient, employeeId: string) {
    const r = await client.query(
      "SELECT id, company_id, user_account_id, manager_id FROM employees WHERE id = $1",
      [employeeId]
    );
    if (r.rowCount === 0) throw new NotFoundException("Employee not found");
    return r.rows[0] as { id: string; company_id: string; user_account_id: string | null; manager_id: string | null };
  }

  private async requireModule(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) throw new NotFoundException();
  }

  async current(claims: RequestClaims, employeeId: string, asOf?: string): Promise<EmployeeWorkProfileView | null> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.loadEmployee(client, employeeId);
      const canAll = (await this.rbac.can(claims, "employee.view.all")) || (await this.rbac.can(claims, "employee.manage.all"));
      const canSelf = emp.user_account_id === claims.sub && (await this.rbac.can(claims, "employee.view.self", { ownerId: emp.user_account_id }));
      let canTeam = false;
      if (!canAll && !canSelf && emp.manager_id) {
        const m = await client.query("SELECT user_account_id FROM employees WHERE id = $1", [emp.manager_id]);
        canTeam = await this.rbac.can(claims, "employee.view.team", { teamOwnerId: m.rows[0]?.user_account_id ?? null });
      }
      if (!canAll && !canSelf && !canTeam) throw new ForbiddenException("Not permitted to view this employee's work profile");
      return this.getAsOf(client, employeeId, asOf ?? toIsoDate(new Date()));
    });
  }

  async history(claims: RequestClaims, employeeId: string): Promise<EmployeeWorkProfileView[]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "employee.view.all")) && !(await this.rbac.can(claims, "employee.manage.all"))) {
      throw new ForbiddenException("Not permitted to view work profile history");
    }
    return this.db.withClaims(claims, async (client) => {
      await this.loadEmployee(client, employeeId);
      const rows = await this.effectiveDating.getHistory<ProfileRow>(client, { table: "employee_work_profiles", scope: { employee_id: employeeId } });
      return rows.map(rowToView).reverse();
    });
  }

  async set(claims: RequestClaims, employeeId: string, dto: SetWorkProfileDto): Promise<EmployeeWorkProfileView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "employee.manage.all"))) throw new ForbiddenException("Not permitted to change work profiles");
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.loadEmployee(client, employeeId);
      const effectiveFrom = dto.effectiveFrom ?? toIsoDate(new Date());
      const base = await this.getAsOf(client, employeeId, effectiveFrom);
      const open = await this.effectiveDating.getCurrentRow<ProfileRow>(client, { table: "employee_work_profiles", scope: { employee_id: employeeId } });
      if (open && toIsoDate(open.effective_from) > effectiveFrom) {
        throw new BadRequestException("A work profile change cannot start before the profile now in force began; edit from its start date instead");
      }
      const percentage = dto.employmentPercentage ?? base?.employmentPercentage ?? 100;
      const weekly = dto.weeklyHours !== undefined ? dto.weeklyHours : base?.weeklyHours ?? null;
      const monthly = dto.monthlyHours !== undefined ? dto.monthlyHours : base?.monthlyHours ?? null;
      const partTime = dto.isPartTime ?? (dto.employmentPercentage !== undefined ? percentage < 100 : base?.isPartTime ?? percentage < 100);
      if (weekly !== null && monthly !== null && Math.abs(monthly - weekly * WEEKS_PER_MONTH) > Math.max(8, monthly * 0.1)) {
        throw new BadRequestException("Weekly and monthly hours disagree by more than 10%; give one, or make them consistent");
      }
      const { row } = await this.effectiveDating.applyVersionedRow<ProfileRow>(client, {
        table: "employee_work_profiles",
        scope: { employee_id: employeeId },
        extraInsertColumns: { company_id: emp.company_id },
        effectiveFrom,
        data: {
          employment_percentage: percentage,
          weekly_hours: weekly,
          monthly_hours: monthly,
          is_part_time: partTime,
          time_recording_profile: dto.timeRecordingProfile ?? base?.timeRecordingProfile ?? "clock",
          notes: dto.notes !== undefined ? dto.notes : base?.notes ?? null,
        },
      });
      await this.audit.record(client, claims, {
        companyId: emp.company_id,
        action: "work_profile.set",
        target: employeeId,
        metadata: { effectiveFrom, employmentPercentage: percentage, weeklyHours: weekly, monthlyHours: monthly },
      });
      return rowToView(row);
    });
  }

  // ---- PAY-24: tenant-wide default --------------------------------------------------------

  /** The default in force on `asOf` (today by default). Needs employee or payroll visibility; the figure is not sensitive but is HR configuration. */
  async companyDefault(claims: RequestClaims, asOf?: string): Promise<CompanyWorkTimeDefaultView> {
    await this.requireModule(claims);
    const allowed =
      (await this.rbac.can(claims, "employee.view.all")) ||
      (await this.rbac.can(claims, "employee.manage.all")) ||
      (await this.rbac.can(claims, "payroll.calculate.all"));
    if (!allowed) throw new ForbiddenException("Not permitted to view working-time defaults");
    const date = asOf ?? toIsoDate(new Date());
    return this.db.withClaims(claims, async (client) => {
      const d = await client.query<{ standard_monthly_hours: string; standard_weekly_hours: string | null; effective_from: unknown; effective_to: unknown }>(
        `SELECT * FROM company_work_time_defaults
          WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
          ORDER BY effective_from DESC LIMIT 1`,
        [claims.company_id, date]
      );
      if (d.rows[0]) {
        const r = d.rows[0];
        return {
          standardMonthlyHours: Number(r.standard_monthly_hours),
          standardWeeklyHours: r.standard_weekly_hours === null ? null : Number(r.standard_weekly_hours),
          effectiveFrom: toIsoDate(r.effective_from),
          effectiveTo: r.effective_to ? toIsoDate(r.effective_to) : null,
          source: "work_time_defaults" as const,
        };
      }
      const s = await client.query<{ standard_monthly_hours: string; effective_from: unknown; effective_to: unknown }>(
        `SELECT standard_monthly_hours, effective_from, effective_to FROM payroll_settings
          WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
          ORDER BY effective_from DESC LIMIT 1`,
        [claims.company_id, date]
      );
      if (s.rows[0]) {
        return {
          standardMonthlyHours: Number(s.rows[0].standard_monthly_hours),
          standardWeeklyHours: null,
          effectiveFrom: toIsoDate(s.rows[0].effective_from),
          effectiveTo: s.rows[0].effective_to ? toIsoDate(s.rows[0].effective_to) : null,
          source: "payroll_settings" as const,
        };
      }
      return { standardMonthlyHours: BUILT_IN_STANDARD_MONTHLY_HOURS, standardWeeklyHours: null, effectiveFrom: date, effectiveTo: null, source: "built_in" as const };
    });
  }

  async setCompanyDefault(claims: RequestClaims, dto: SetCompanyWorkTimeDefaultDto): Promise<CompanyWorkTimeDefaultView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "employee.manage.all")) && !(await this.rbac.can(claims, "payroll.calculate.all"))) {
      throw new ForbiddenException("Not permitted to change working-time defaults");
    }
    if (dto.standardMonthlyHours < 100 || dto.standardMonthlyHours > 300) throw new BadRequestException("standardMonthlyHours must be between 100 and 300");
    await this.db.withClaims(claims, async (client) => {
      await writeCompanyWorkTimeDefault(
        client,
        this.effectiveDating,
        claims.company_id!,
        { standardMonthlyHours: dto.standardMonthlyHours, standardWeeklyHours: dto.standardWeeklyHours },
        dto.effectiveFrom
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "work_time_defaults.set",
        metadata: { standardMonthlyHours: dto.standardMonthlyHours, effectiveFrom: dto.effectiveFrom ?? null },
      });
    });
    return this.companyDefault(claims, dto.effectiveFrom);
  }
}
