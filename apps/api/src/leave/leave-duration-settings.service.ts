import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { LeaveDurationSettingsView, LeaveRuleHistoryEntry, SetLeaveDurationSettingsRequest } from "@aihxm/shared-types";
import { parseClock } from "./leave-time";

const MODULE_KEY = "leave" as const;

const timeOut = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 5));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToSettings(row: any): LeaveDurationSettingsView {
  return {
    id: row.id,
    leaveType: row.leave_type,
    leavePolicyId: row.leave_policy_id ?? null,
    selectionMethod: row.selection_method,
    earliestStartTime: timeOut(row.earliest_start_time),
    latestEndTime: timeOut(row.latest_end_time),
    fixedStartTime: timeOut(row.fixed_start_time),
    fixedEndTime: timeOut(row.fixed_end_time),
    minDurationMinutes: num(row.min_duration_minutes),
    maxDurationMinutes: num(row.max_duration_minutes),
    incrementMinutes: num(row.increment_minutes),
    breakTreatment: row.break_treatment,
    validateAgainstSchedule: row.validate_against_schedule,
    allowOvernight: row.allow_overnight,
    sameDayPolicy: row.same_day_policy,
    minNoticeMinutes: num(row.min_notice_minutes),
    backdateDaysAllowed: num(row.backdate_days_allowed),
    dailyLimitMinutes: num(row.daily_limit_minutes),
    monthlyLimitMinutes: num(row.monthly_limit_minutes),
    frequencyMaxRequests: num(row.frequency_max_requests),
    frequencyPeriod: row.frequency_period ?? null,
    dayEquivalentMinutes: num(row.day_equivalent_minutes),
    workflowTemplateKey: row.workflow_template_key ?? null,
    isActive: row.is_active,
    version: row.version,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : (row.updated_at ?? null),
  };
}

/** What a leave type with nothing configured behaves like: no window, no limits, breaks excluded, checked against the shift. */
export function emptySettings(leaveType: string, leavePolicyId: string | null = null): LeaveDurationSettingsView {
  return {
    id: null, leaveType, leavePolicyId, selectionMethod: "employee_selected", earliestStartTime: null, latestEndTime: null,
    fixedStartTime: null, fixedEndTime: null, minDurationMinutes: null, maxDurationMinutes: null, incrementMinutes: null,
    breakTreatment: "exclude_all", validateAgainstSchedule: true, allowOvernight: false, sameDayPolicy: "unrestricted",
    minNoticeMinutes: null, backdateDaysAllowed: null, dailyLimitMinutes: null, monthlyLimitMinutes: null, frequencyMaxRequests: null,
    frequencyPeriod: null, dayEquivalentMinutes: null, workflowTemplateKey: null, isActive: true, version: 0, updatedAt: null,
  };
}

const COLUMNS: Array<[keyof SetLeaveDurationSettingsRequest, string]> = [
  ["selectionMethod", "selection_method"],
  ["earliestStartTime", "earliest_start_time"],
  ["latestEndTime", "latest_end_time"],
  ["fixedStartTime", "fixed_start_time"],
  ["fixedEndTime", "fixed_end_time"],
  ["minDurationMinutes", "min_duration_minutes"],
  ["maxDurationMinutes", "max_duration_minutes"],
  ["incrementMinutes", "increment_minutes"],
  ["breakTreatment", "break_treatment"],
  ["validateAgainstSchedule", "validate_against_schedule"],
  ["allowOvernight", "allow_overnight"],
  ["sameDayPolicy", "same_day_policy"],
  ["minNoticeMinutes", "min_notice_minutes"],
  ["backdateDaysAllowed", "backdate_days_allowed"],
  ["dailyLimitMinutes", "daily_limit_minutes"],
  ["monthlyLimitMinutes", "monthly_limit_minutes"],
  ["frequencyMaxRequests", "frequency_max_requests"],
  ["frequencyPeriod", "frequency_period"],
  ["dayEquivalentMinutes", "day_equivalent_minutes"],
  ["workflowTemplateKey", "workflow_template_key"],
  ["isActive", "is_active"],
];

/**
 * BACKLOG58 - the timing rules of a leave type (window, durations, increments, notice, limits, approval route),
 * kept in `leave_duration_settings`. A row without a policy is the leave type's own setting; a row for a policy
 * replaces it wholesale for employees whose leave policy that is. Every change bumps `version`, is written to the
 * append-only `leave_rule_history` with a full snapshot, and is audited. Requests store the settings they were
 * accepted under, so editing a setting never rewrites an old request.
 */
@Injectable()
export class LeaveDurationSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  /** The setting that applies to an employee on a leave policy: the policy override if there is one, else the leave type's own, else "nothing configured". */
  async resolveEffective(client: PoolClient, companyId: string, leaveType: string, policyId: string | null): Promise<LeaveDurationSettingsView> {
    const r = await client.query(
      `SELECT * FROM leave_duration_settings
        WHERE company_id = $1 AND leave_type = $2 AND is_active AND (leave_policy_id IS NULL OR leave_policy_id = $3::uuid)
        ORDER BY (leave_policy_id IS NOT NULL) DESC LIMIT 1`,
      [companyId, leaveType, policyId]
    );
    return r.rowCount ? rowToSettings(r.rows[0]) : emptySettings(leaveType, policyId);
  }

  async list(claims: RequestClaims, leaveType: string): Promise<LeaveDurationSettingsView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM leave_duration_settings WHERE company_id = $1 AND leave_type = $2 ORDER BY (leave_policy_id IS NOT NULL), created_at`,
        [claims.company_id, leaveType]
      );
      return r.rows.map(rowToSettings);
    });
  }

  async set(claims: RequestClaims, leaveType: string, policyId: string | null, patch: SetLeaveDurationSettingsRequest): Promise<LeaveDurationSettingsView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const type = await client.query("SELECT code FROM leave_types WHERE company_id = $1 AND code = $2", [claims.company_id, leaveType]);
      if (type.rowCount === 0) throw new NotFoundException("Leave type not found");
      if (policyId) {
        const policy = await client.query("SELECT 1 FROM leave_policies WHERE id = $1 AND company_id = $2", [policyId, claims.company_id]);
        if (policy.rowCount === 0) throw new NotFoundException("Leave policy not found");
      }
      const existing = await client.query(
        `SELECT * FROM leave_duration_settings WHERE company_id = $1 AND leave_type = $2 AND leave_policy_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
        [claims.company_id, leaveType, policyId]
      );
      const before = existing.rowCount ? rowToSettings(existing.rows[0]) : emptySettings(leaveType, policyId);
      const merged: LeaveDurationSettingsView = { ...before };
      for (const [key] of COLUMNS) {
        if ((patch as Record<string, unknown>)[key] !== undefined) (merged as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
      }
      this.validate(merged);
      if (policyId === null && merged.workflowTemplateKey) await this.assertTemplate(client, claims.company_id!, merged.workflowTemplateKey);

      const values = COLUMNS.map(([key]) => (merged as Record<string, unknown>)[key] ?? null);
      let row;
      if (existing.rowCount) {
        const sets = COLUMNS.map(([, column], i) => `${column} = $${i + 2}`);
        const r = await client.query(
          `UPDATE leave_duration_settings SET ${sets.join(", ")}, version = version + 1, updated_at = now(), updated_by_user_account_id = $${COLUMNS.length + 2}
            WHERE id = $1 RETURNING *`,
          [existing.rows[0].id, ...values, claims.sub]
        );
        row = r.rows[0];
      } else {
        const cols = ["company_id", "leave_type", "leave_policy_id", ...COLUMNS.map(([, c]) => c), "updated_by_user_account_id"];
        const r = await client.query(
          `INSERT INTO leave_duration_settings (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
          [claims.company_id, leaveType, policyId, ...values, claims.sub]
        );
        row = r.rows[0];
      }
      const view = rowToSettings(row);
      await this.recordHistory(client, claims, view.id!, view.version, existing.rowCount ? "update" : "create", view);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "leave_duration_settings.save",
        target: view.id!,
        metadata: { leaveType, leavePolicyId: policyId, version: view.version, fields: Object.keys(patch) },
      });
      return view;
    });
  }

  /** Removes a policy's override so the leave type's own setting applies again. */
  async removeOverride(claims: RequestClaims, leaveType: string, policyId: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `DELETE FROM leave_duration_settings WHERE company_id = $1 AND leave_type = $2 AND leave_policy_id = $3 RETURNING *`,
        [claims.company_id, leaveType, policyId]
      );
      if (r.rowCount === 0) throw new NotFoundException("No override for this policy");
      const view = rowToSettings(r.rows[0]);
      await this.recordHistory(client, claims, view.id!, view.version + 1, "delete", view);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "leave_duration_settings.delete",
        target: view.id!,
        metadata: { leaveType, leavePolicyId: policyId },
      });
    });
  }

  async history(claims: RequestClaims, leaveType: string): Promise<LeaveRuleHistoryEntry[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT h.* FROM leave_rule_history h
          WHERE h.company_id = $1 AND h.entity_type = 'settings' AND h.snapshot ->> 'leaveType' = $2
          ORDER BY h.changed_at DESC, h.version DESC LIMIT 200`,
        [claims.company_id, leaveType]
      );
      return r.rows.map(rowToHistory);
    });
  }

  private validate(s: LeaveDurationSettingsView): void {
    const t = (label: string, v: string | null) => {
      if (v !== null && parseClock(v) === null) throw new BadRequestException(`${label} must be a time like 09:00`);
    };
    t("Earliest start", s.earliestStartTime);
    t("Latest end", s.latestEndTime);
    t("Fixed window start", s.fixedStartTime);
    t("Fixed window end", s.fixedEndTime);
    if (s.selectionMethod === "fixed_window") {
      if (!s.fixedStartTime || !s.fixedEndTime) throw new BadRequestException("A fixed window needs both a start and an end time");
      if (!s.allowOvernight && (parseClock(s.fixedEndTime) as number) <= (parseClock(s.fixedStartTime) as number)) {
        throw new BadRequestException("The fixed window must end after it starts");
      }
    }
    if (s.earliestStartTime && s.latestEndTime && !s.allowOvernight && (parseClock(s.latestEndTime) as number) <= (parseClock(s.earliestStartTime) as number)) {
      throw new BadRequestException("The latest end time must be after the earliest start time");
    }
    const positive = (label: string, v: number | null) => {
      if (v !== null && (!Number.isInteger(v) || v <= 0)) throw new BadRequestException(`${label} must be a whole number of minutes above zero`);
    };
    positive("Minimum duration", s.minDurationMinutes);
    positive("Maximum duration", s.maxDurationMinutes);
    positive("Request increment", s.incrementMinutes);
    positive("Daily limit", s.dailyLimitMinutes);
    positive("Monthly limit", s.monthlyLimitMinutes);
    positive("Day equivalent", s.dayEquivalentMinutes);
    if (s.minDurationMinutes !== null && s.maxDurationMinutes !== null && s.minDurationMinutes > s.maxDurationMinutes) {
      throw new BadRequestException("The minimum duration cannot be longer than the maximum");
    }
    if (s.incrementMinutes !== null) {
      if (s.minDurationMinutes !== null && s.minDurationMinutes % s.incrementMinutes !== 0) throw new BadRequestException("The minimum duration must be a multiple of the request increment");
      if (s.maxDurationMinutes !== null && s.maxDurationMinutes % s.incrementMinutes !== 0) throw new BadRequestException("The maximum duration must be a multiple of the request increment");
    }
    if (s.minNoticeMinutes !== null && (!Number.isInteger(s.minNoticeMinutes) || s.minNoticeMinutes < 0)) throw new BadRequestException("Advance notice must be zero or more minutes");
    if (s.backdateDaysAllowed !== null && (!Number.isInteger(s.backdateDaysAllowed) || s.backdateDaysAllowed < 0)) throw new BadRequestException("Backdating must be zero or more days");
    if (s.frequencyMaxRequests !== null && (!Number.isInteger(s.frequencyMaxRequests) || s.frequencyMaxRequests <= 0)) throw new BadRequestException("The frequency limit must be a whole number above zero");
    if (s.frequencyMaxRequests !== null && !s.frequencyPeriod) throw new BadRequestException("A frequency limit needs the period it applies to");
  }

  private async assertTemplate(client: PoolClient, companyId: string, key: string): Promise<void> {
    const t = await client.query("SELECT object_key, is_active FROM workflow_templates WHERE company_id = $1 AND key = $2", [companyId, key]);
    if (t.rowCount === 0) throw new BadRequestException("That approval workflow does not exist");
    if (t.rows[0].object_key !== "leave_request") throw new BadRequestException("Pick an approval workflow that is set up for leave requests");
    if (!t.rows[0].is_active) throw new BadRequestException("That approval workflow is switched off");
  }

  async recordHistory(client: PoolClient, claims: RequestClaims, entityId: string, version: number, action: "create" | "update" | "delete", snapshot: unknown): Promise<void> {
    await client.query(
      `INSERT INTO leave_rule_history (company_id, entity_type, entity_id, version, action, snapshot, changed_by_user_account_id)
       VALUES ($1, 'settings', $2, $3, $4, $5::jsonb, $6)`,
      [claims.company_id, entityId, version, action, JSON.stringify(snapshot), claims.sub]
    );
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "leave_policy.manage"))) throw new ForbiddenException("Not permitted to manage leave rules");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToHistory(row: any): LeaveRuleHistoryEntry {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    version: row.version,
    action: row.action,
    snapshot: row.snapshot,
    changedByUserAccountId: row.changed_by_user_account_id ?? null,
    changedAt: row.changed_at?.toISOString ? row.changed_at.toISOString() : row.changed_at,
  };
}
