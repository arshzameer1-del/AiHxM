import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CreateLeaveTypeRequest, LeaveTypeView, UpdateLeaveTypeRequest } from "@aihxm/shared-types";

const MODULE_KEY = "leave" as const;
const CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;
/** Duration modes under which a type may also be taken as a half day. */
const HALF_DAY_MODES = new Set(["half_day", "flexible_partial"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToLeaveType(row: any): LeaveTypeView {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    isPaid: row.is_paid,
    tracksBalance: row.tracks_balance,
    accrualMethod: row.accrual_method,
    carryForwardAllowed: row.carry_forward_allowed,
    carryForwardCapDays: num(row.carry_forward_cap_days),
    carryForwardExpiryMonths: row.carry_forward_expiry_months ?? null,
    encashable: row.encashable,
    documentRequired: row.document_required,
    documentRequiredAfterDays: Number(row.document_required_after_days),
    genderRestriction: row.gender_restriction,
    minServiceMonths: row.min_service_months,
    halfDayAllowed: row.half_day_allowed,
    maxConsecutiveDays: num(row.max_consecutive_days),
    durationMode: row.duration_mode,
    balanceUnit: row.balance_unit,
    isSystem: row.is_system,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

/** Column map for create / update (camelCase DTO -> snake_case column). */
const COLUMNS: Array<[keyof CreateLeaveTypeRequest, string]> = [
  ["name", "name"],
  ["description", "description"],
  ["isPaid", "is_paid"],
  ["tracksBalance", "tracks_balance"],
  ["accrualMethod", "accrual_method"],
  ["carryForwardAllowed", "carry_forward_allowed"],
  ["carryForwardCapDays", "carry_forward_cap_days"],
  ["carryForwardExpiryMonths", "carry_forward_expiry_months"],
  ["encashable", "encashable"],
  ["documentRequired", "document_required"],
  ["documentRequiredAfterDays", "document_required_after_days"],
  ["genderRestriction", "gender_restriction"],
  ["minServiceMonths", "min_service_months"],
  ["halfDayAllowed", "half_day_allowed"],
  ["maxConsecutiveDays", "max_consecutive_days"],
  ["durationMode", "duration_mode"],
  ["balanceUnit", "balance_unit"],
  ["isActive", "is_active"],
  ["sortOrder", "sort_order"],
];

/**
 * Gap Register TLM-01 - the tenant's leave type catalogue.
 *
 * Every tenant has annual / casual / sick / unpaid (system rows, cannot be deleted or
 * re-coded); the Pakistan-typical maternity, paternity, Hajj, bereavement, compensatory
 * and short leave types exist INACTIVE with NO entitlement figures until HR enables them
 * and sets days on a leave policy. Tenants may define their own types.
 *
 * Reading the catalogue needs only the leave module (employees need it to fill the request
 * form); changing it needs `leave_policy.manage`.
 */
@Injectable()
export class LeaveTypesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, opts?: { includeInactive?: boolean }): Promise<LeaveTypeView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaults(client, claims.company_id!);
      const r = await client.query(
        `SELECT * FROM leave_types WHERE company_id = $1 AND ($2::boolean OR is_active) ORDER BY sort_order, name`,
        [claims.company_id, opts?.includeInactive === true]
      );
      return r.rows.map(rowToLeaveType);
    });
  }

  async create(claims: RequestClaims, input: CreateLeaveTypeRequest): Promise<LeaveTypeView> {
    await this.requireManage(claims);
    const code = input.code.trim().toLowerCase();
    if (!CODE_RE.test(code)) {
      throw new BadRequestException("Leave type code must be 2-40 characters: lowercase letters, digits and underscores, starting with a letter");
    }
    this.validate(input);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaults(client, claims.company_id!);
      const dup = await client.query("SELECT 1 FROM leave_types WHERE company_id = $1 AND code = $2", [claims.company_id, code]);
      if ((dup.rowCount ?? 0) > 0) throw new ConflictException(`A leave type with code "${code}" already exists`);
      const cols: string[] = ["company_id", "code"];
      const vals: unknown[] = [claims.company_id, code];
      const createInput: CreateLeaveTypeRequest = { ...input };
      if (createInput.durationMode && createInput.halfDayAllowed === undefined) createInput.halfDayAllowed = HALF_DAY_MODES.has(createInput.durationMode);
      for (const [key, column] of COLUMNS) {
        if ((createInput as Record<string, unknown>)[key] !== undefined) {
          cols.push(column);
          vals.push((createInput as Record<string, unknown>)[key]);
        }
      }
      const r = await client.query(
        `INSERT INTO leave_types (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        vals
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "leave_type.create",
        target: r.rows[0].id,
        metadata: { code },
      });
      return rowToLeaveType(r.rows[0]);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateLeaveTypeRequest): Promise<LeaveTypeView> {
    await this.requireManage(claims);
    this.validate(patch);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM leave_types WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Leave type not found");
      const row = current.rows[0];
      if (row.is_system && patch.isActive === false) {
        throw new BadRequestException("The built-in leave types cannot be deactivated");
      }
      if (row.is_system && patch.tracksBalance !== undefined && patch.tracksBalance !== row.tracks_balance) {
        throw new BadRequestException("Whether a built-in leave type keeps a balance cannot be changed");
      }
      if (patch.balanceUnit !== undefined && patch.balanceUnit !== row.balance_unit) {
        // The ledger and the policy entitlements hold figures in the current unit; re-labelling them would silently change what they mean.
        const used = await client.query("SELECT 1 FROM leave_ledger WHERE company_id = $1 AND leave_type = $2 LIMIT 1", [row.company_id, row.code]);
        if ((used.rowCount ?? 0) > 0) {
          throw new BadRequestException(`${row.name} already has balance history in ${row.balance_unit}, so its balance unit can no longer be changed`);
        }
      }
      const effectivePatch: UpdateLeaveTypeRequest = { ...patch };
      if (effectivePatch.durationMode && effectivePatch.halfDayAllowed === undefined) effectivePatch.halfDayAllowed = HALF_DAY_MODES.has(effectivePatch.durationMode);
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const [key, column] of COLUMNS) {
        if ((effectivePatch as Record<string, unknown>)[key] !== undefined) {
          vals.push((effectivePatch as Record<string, unknown>)[key]);
          sets.push(`${column} = $${vals.length}`);
        }
      }
      if (sets.length === 0) return rowToLeaveType(row);
      const r = await client.query(`UPDATE leave_types SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "leave_type.update",
        target: id,
        metadata: { code: row.code, fields: Object.keys(patch) },
      });
      return rowToLeaveType(r.rows[0]);
    });
  }

  // --- helpers used by the request / ledger services ----------------------

  /** Idempotent; covers tenants created before the company trigger existed. */
  async ensureDefaults(client: PoolClient, companyId: string): Promise<void> {
    await client.query("SELECT app.seed_leave_types($1)", [companyId]);
  }

  async getByCode(client: PoolClient, companyId: string, code: string): Promise<LeaveTypeView | null> {
    let r = await client.query("SELECT * FROM leave_types WHERE company_id = $1 AND code = $2", [companyId, code]);
    if (r.rowCount === 0) {
      await this.ensureDefaults(client, companyId);
      r = await client.query("SELECT * FROM leave_types WHERE company_id = $1 AND code = $2", [companyId, code]);
    }
    return r.rowCount === 0 ? null : rowToLeaveType(r.rows[0]);
  }

  async listActive(client: PoolClient, companyId: string): Promise<LeaveTypeView[]> {
    await this.ensureDefaults(client, companyId);
    const r = await client.query("SELECT * FROM leave_types WHERE company_id = $1 AND is_active ORDER BY sort_order, name", [companyId]);
    return r.rows.map(rowToLeaveType);
  }

  private validate(input: Partial<CreateLeaveTypeRequest>): void {
    if (input.carryForwardAllowed === false && input.carryForwardCapDays != null) {
      throw new BadRequestException("A carry-forward cap needs carry-forward to be allowed");
    }
    if (input.documentRequired === false && (input.documentRequiredAfterDays ?? 0) > 0) {
      throw new BadRequestException("documentRequiredAfterDays only applies when a document is required");
    }
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "leave_policy.manage"))) {
      throw new ForbiddenException("Not permitted to manage leave types");
    }
  }
}
