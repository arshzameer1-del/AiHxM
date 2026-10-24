import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  LeaveRuleHistoryEntry,
  LeaveValidationRuleParams,
  LeaveValidationRuleView,
  LeaveValidationType,
  LeaveValidationTypeInfo,
  SaveLeaveValidationRuleRequest,
} from "@aihxm/shared-types";
import { DEFAULT_OFF_TYPES, LOCKED_VALIDATION_TYPES, VALIDATION_CATALOG, VALIDATION_TYPES, catalogInfo } from "./leave-validation.catalog";
import { validateConditionTree } from "./leave-validation.engine";
import { rowToHistory } from "./leave-duration-settings.service";

const MODULE_KEY = "leave" as const;
const CODE_RE = /^[a-z][a-z0-9_]{1,59}$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;
const COMMON_PLACEHOLDERS = ["leaveType", "window"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToRule(row: any): LeaveValidationRuleView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    validationType: row.validation_type,
    leaveTypes: row.leave_types ?? [],
    policyIds: row.policy_ids ?? [],
    employeeGroupIds: row.employee_group_ids ?? [],
    severity: row.severity,
    message: row.message,
    messages: row.messages ?? {},
    adminExplanation: row.admin_explanation ?? null,
    priority: row.priority,
    effectiveFrom: row.effective_from ? (typeof row.effective_from === "string" ? row.effective_from.slice(0, 10) : row.effective_from.toISOString().slice(0, 10)) : null,
    effectiveTo: row.effective_to ? (typeof row.effective_to === "string" ? row.effective_to.slice(0, 10) : row.effective_to.toISOString().slice(0, 10)) : null,
    isActive: row.is_active,
    allowProceed: row.allow_proceed,
    conditions: row.conditions ?? null,
    params: row.params ?? {},
    isSystem: row.is_system,
    isLocked: LOCKED_VALIDATION_TYPES.has(row.validation_type),
    version: row.version,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

const NUMERIC_PARAMS: Array<keyof LeaveValidationRuleParams> = [
  "minNoticeMinutes", "maxMinutes", "minMinutes", "dailyLimitMinutes", "monthlyLimitMinutes", "maxRequests",
  "minReasonLength", "backdateDaysAllowed", "requiredAfterMinutes",
];

/**
 * BACKLOG58 - the configurable validation rules of the leave module (Leave Policies area).
 *
 * Every tenant gets one system rule per predefined validation (created on first use, `is_system`), which is what keeps
 * today's behaviour - they can be reworded, re-prioritised, scoped or (when not locked) lowered to a warning or switched
 * off, but not deleted. Administrators add further rules of the same twenty types to target a leave type, a policy or an
 * employee group, or to add a second tier (a warning at 24 hours' notice, a block at 1 hour). No rule can carry code,
 * SQL or an expression: only a validation type, parameters, and a declarative AND/OR condition tree over known fields.
 */
@Injectable()
export class LeaveValidationRulesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  catalog(): LeaveValidationTypeInfo[] {
    return VALIDATION_CATALOG;
  }

  /** Idempotent; creates the system rules a tenant does not have yet. */
  async ensureDefaults(client: PoolClient, companyId: string): Promise<void> {
    const have = await client.query("SELECT count(*)::int AS n FROM leave_validation_rules WHERE company_id = $1 AND is_system", [companyId]);
    if (have.rows[0].n >= VALIDATION_CATALOG.length) return;
    for (const info of VALIDATION_CATALOG) {
      await client.query(
        `INSERT INTO leave_validation_rules (company_id, code, name, description, validation_type, severity, message, priority, is_active, allow_proceed, is_system)
         VALUES ($1, $2, $3, $4, $5, 'block', $6, 1000, $7, false, true)
         ON CONFLICT (company_id, code) DO NOTHING`,
        [companyId, info.type, info.label, info.description, info.type, info.defaultMessage, !DEFAULT_OFF_TYPES.has(info.type)]
      );
    }
  }

  /** The rules the engine evaluates: every stored rule of the tenant (the engine itself filters on active / dates / scope). */
  async loadAll(client: PoolClient, companyId: string): Promise<LeaveValidationRuleView[]> {
    await this.ensureDefaults(client, companyId);
    const r = await client.query("SELECT * FROM leave_validation_rules WHERE company_id = $1 ORDER BY priority, code", [companyId]);
    return r.rows.map(rowToRule);
  }

  async list(claims: RequestClaims): Promise<LeaveValidationRuleView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.loadAll(client, claims.company_id!));
  }

  async get(claims: RequestClaims, id: string): Promise<LeaveValidationRuleView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM leave_validation_rules WHERE id = $1 AND company_id = $2", [id, claims.company_id]);
      if (r.rowCount === 0) throw new NotFoundException("Rule not found");
      return rowToRule(r.rows[0]);
    });
  }

  async create(claims: RequestClaims, input: SaveLeaveValidationRuleRequest): Promise<LeaveValidationRuleView> {
    await this.requireManage(claims);
    if (!input.code || !input.validationType || !input.name || !input.message) {
      throw new BadRequestException("A rule needs a code, a name, a validation type and a message");
    }
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaults(client, claims.company_id!);
      const draft = this.normalise(input, null);
      await this.validate(client, claims.company_id!, draft);
      const dup = await client.query("SELECT 1 FROM leave_validation_rules WHERE company_id = $1 AND code = $2", [claims.company_id, draft.code]);
      if ((dup.rowCount ?? 0) > 0) throw new ConflictException(`A rule with code "${draft.code}" already exists`);
      const r = await client.query(
        `INSERT INTO leave_validation_rules
           (company_id, code, name, description, validation_type, leave_types, policy_ids, employee_group_ids, severity, message, messages,
            admin_explanation, priority, effective_from, effective_to, is_active, allow_proceed, conditions, params, updated_by_user_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20) RETURNING *`,
        [
          claims.company_id, draft.code, draft.name, draft.description, draft.validationType, draft.leaveTypes, draft.policyIds, draft.employeeGroupIds,
          draft.severity, draft.message, JSON.stringify(draft.messages), draft.adminExplanation, draft.priority, draft.effectiveFrom, draft.effectiveTo,
          draft.isActive, draft.allowProceed, draft.conditions ? JSON.stringify(draft.conditions) : null, JSON.stringify(draft.params), claims.sub,
        ]
      );
      const view = rowToRule(r.rows[0]);
      await this.recordHistory(client, claims, view, "create");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "leave_validation_rule.create", target: view.id, metadata: { code: view.code, validationType: view.validationType, severity: view.severity } });
      return view;
    });
  }

  async update(claims: RequestClaims, id: string, patch: SaveLeaveValidationRuleRequest): Promise<LeaveValidationRuleView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM leave_validation_rules WHERE id = $1 AND company_id = $2 FOR UPDATE", [id, claims.company_id]);
      if (current.rowCount === 0) throw new NotFoundException("Rule not found");
      const before = rowToRule(current.rows[0]);
      if (before.isSystem && ((patch.code !== undefined && patch.code !== before.code) || (patch.validationType !== undefined && patch.validationType !== before.validationType))) {
        throw new BadRequestException("The code and validation type of a built-in rule cannot be changed - add a new rule instead");
      }
      const draft = this.normalise(patch, before);
      await this.validate(client, claims.company_id!, draft);
      if (draft.code !== before.code) {
        const dup = await client.query("SELECT 1 FROM leave_validation_rules WHERE company_id = $1 AND code = $2 AND id <> $3", [claims.company_id, draft.code, id]);
        if ((dup.rowCount ?? 0) > 0) throw new ConflictException(`A rule with code "${draft.code}" already exists`);
      }
      const r = await client.query(
        `UPDATE leave_validation_rules SET
            code = $2, name = $3, description = $4, validation_type = $5, leave_types = $6, policy_ids = $7, employee_group_ids = $8,
            severity = $9, message = $10, messages = $11::jsonb, admin_explanation = $12, priority = $13, effective_from = $14,
            effective_to = $15, is_active = $16, allow_proceed = $17, conditions = $18::jsonb, params = $19::jsonb,
            version = version + 1, updated_at = now(), updated_by_user_account_id = $20
          WHERE id = $1 RETURNING *`,
        [
          id, draft.code, draft.name, draft.description, draft.validationType, draft.leaveTypes, draft.policyIds, draft.employeeGroupIds,
          draft.severity, draft.message, JSON.stringify(draft.messages), draft.adminExplanation, draft.priority, draft.effectiveFrom, draft.effectiveTo,
          draft.isActive, draft.allowProceed, draft.conditions ? JSON.stringify(draft.conditions) : null, JSON.stringify(draft.params), claims.sub,
        ]
      );
      const view = rowToRule(r.rows[0]);
      await this.recordHistory(client, claims, view, "update");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: "leave_validation_rule.update", target: id,
        metadata: { code: view.code, version: view.version, fields: Object.keys(patch) },
      });
      return view;
    });
  }

  async remove(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM leave_validation_rules WHERE id = $1 AND company_id = $2 FOR UPDATE", [id, claims.company_id]);
      if (current.rowCount === 0) throw new NotFoundException("Rule not found");
      const rule = rowToRule(current.rows[0]);
      if (rule.isSystem) throw new BadRequestException("A built-in rule cannot be deleted - switch it off or change its severity instead");
      await client.query("DELETE FROM leave_validation_rules WHERE id = $1", [id]);
      await this.recordHistory(client, claims, { ...rule, version: rule.version + 1 }, "delete");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "leave_validation_rule.delete", target: id, metadata: { code: rule.code } });
    });
  }

  async history(claims: RequestClaims, id: string): Promise<LeaveRuleHistoryEntry[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM leave_rule_history WHERE company_id = $1 AND entity_type = 'rule' AND entity_id = $2 ORDER BY version DESC, changed_at DESC`,
        [claims.company_id, id]
      );
      return r.rows.map(rowToHistory);
    });
  }

  /** Builds the draft a request body describes, on top of the stored rule when editing; used by save and by the preview. */
  normalise(input: SaveLeaveValidationRuleRequest, base: LeaveValidationRuleView | null): LeaveValidationRuleView {
    const validationType = (input.validationType ?? base?.validationType) as LeaveValidationType;
    const locked = LOCKED_VALIDATION_TYPES.has(validationType);
    const severity = locked ? "block" : (input.severity ?? base?.severity ?? "block");
    return {
      id: base?.id ?? "",
      code: (input.code ?? base?.code ?? "").trim().toLowerCase(),
      name: (input.name ?? base?.name ?? "").trim(),
      description: input.description === undefined ? (base?.description ?? null) : (input.description?.trim() || null),
      validationType,
      leaveTypes: [...new Set(input.leaveTypes ?? base?.leaveTypes ?? [])],
      policyIds: [...new Set(input.policyIds ?? base?.policyIds ?? [])],
      employeeGroupIds: [...new Set(input.employeeGroupIds ?? base?.employeeGroupIds ?? [])],
      severity,
      message: (input.message ?? base?.message ?? "").trim(),
      messages: input.messages ?? base?.messages ?? {},
      adminExplanation: input.adminExplanation === undefined ? (base?.adminExplanation ?? null) : (input.adminExplanation?.trim() || null),
      priority: input.priority ?? base?.priority ?? 100,
      effectiveFrom: input.effectiveFrom === undefined ? (base?.effectiveFrom ?? null) : input.effectiveFrom,
      effectiveTo: input.effectiveTo === undefined ? (base?.effectiveTo ?? null) : input.effectiveTo,
      isActive: locked ? true : (input.isActive ?? base?.isActive ?? true),
      allowProceed: severity === "warning" ? (input.allowProceed ?? base?.allowProceed ?? true) : severity === "info",
      conditions: input.conditions === undefined ? (base?.conditions ?? null) : input.conditions,
      params: input.params ?? base?.params ?? {},
      isSystem: base?.isSystem ?? false,
      isLocked: locked,
      version: base?.version ?? 1,
      updatedAt: base?.updatedAt ?? "",
    };
  }

  /** Throws a 400 describing the first problem; used on save and for the preview of an unsaved draft. */
  async validate(client: PoolClient, companyId: string, rule: LeaveValidationRuleView): Promise<void> {
    if (!VALIDATION_TYPES.includes(rule.validationType)) throw new BadRequestException("Choose one of the predefined validation types");
    if (!CODE_RE.test(rule.code)) throw new BadRequestException("Rule code must be 2-60 characters: lowercase letters, digits and underscores, starting with a letter");
    if (!rule.name) throw new BadRequestException("A rule needs a name");
    if (!rule.message || rule.message.length > 500) throw new BadRequestException("The employee message is required and at most 500 characters");
    if (!Number.isInteger(rule.priority) || rule.priority < 1 || rule.priority > 100000) throw new BadRequestException("Priority must be a whole number between 1 and 100000 (lowest runs first)");
    if (rule.effectiveFrom && rule.effectiveTo && rule.effectiveTo < rule.effectiveFrom) throw new BadRequestException("The rule's end date is before its start date");

    const info = catalogInfo(rule.validationType);
    const allowed = new Set<string>([...info.placeholders, ...COMMON_PLACEHOLDERS]);
    const checkText = (text: string, label: string) => {
      for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        if (!allowed.has(m[1])) throw new BadRequestException(`${label} uses {{${m[1]}}}, which this validation does not provide. Available: ${[...allowed].map((p) => `{{${p}}}`).join(", ")}`);
      }
      if (/\{\{[^}]*$/.test(text) || /\{\{\s*\}\}/.test(text)) throw new BadRequestException(`${label} has an unfinished {{placeholder}}`);
    };
    checkText(rule.message, "The message");
    for (const [locale, text] of Object.entries(rule.messages)) {
      if (!LOCALE_RE.test(locale)) throw new BadRequestException(`"${locale}" is not a language code like ur or en-GB`);
      if (typeof text !== "string" || !text.trim() || text.length > 500) throw new BadRequestException(`The ${locale} message must be 1-500 characters`);
      checkText(text, `The ${locale} message`);
    }

    const condErr = validateConditionTree(rule.conditions);
    if (condErr) throw new BadRequestException(condErr);

    const allowedParams = new Set<string>(info.paramKeys as string[]);
    for (const key of Object.keys(rule.params)) {
      if (!allowedParams.has(key)) throw new BadRequestException(`"${key}" is not a setting of the "${info.label}" validation`);
    }
    for (const key of NUMERIC_PARAMS) {
      const v = (rule.params as Record<string, unknown>)[key];
      if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0)) throw new BadRequestException(`${key} must be a whole number, zero or more`);
    }
    if (rule.params.period !== undefined && !["day", "week", "month", "year"].includes(rule.params.period)) throw new BadRequestException("period must be day, week, month or year");
    if (rule.params.holidayMode !== undefined && !["no_chargeable_days", "any_in_range"].includes(rule.params.holidayMode)) throw new BadRequestException("holidayMode must be no_chargeable_days or any_in_range");
    if (rule.params.allowedEmploymentTypes !== undefined && !Array.isArray(rule.params.allowedEmploymentTypes)) throw new BadRequestException("allowedEmploymentTypes must be a list");

    if (rule.leaveTypes.length > 0) {
      const found = await client.query("SELECT code FROM leave_types WHERE company_id = $1 AND code = ANY($2::text[])", [companyId, rule.leaveTypes]);
      if (found.rowCount !== rule.leaveTypes.length) throw new BadRequestException("One of the leave types does not exist");
    }
    if (rule.policyIds.length > 0) {
      const found = await client.query("SELECT id FROM leave_policies WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, rule.policyIds]);
      if (found.rowCount !== rule.policyIds.length) throw new BadRequestException("One of the leave policies does not exist");
    }
    if (rule.employeeGroupIds.length > 0) {
      const found = await client.query("SELECT id FROM employee_groups WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, rule.employeeGroupIds]);
      if (found.rowCount !== rule.employeeGroupIds.length) throw new BadRequestException("One of the employee groups does not exist");
    }
  }

  private async recordHistory(client: PoolClient, claims: RequestClaims, rule: LeaveValidationRuleView, action: "create" | "update" | "delete"): Promise<void> {
    await client.query(
      `INSERT INTO leave_rule_history (company_id, entity_type, entity_id, version, action, snapshot, changed_by_user_account_id)
       VALUES ($1, 'rule', $2, $3, $4, $5::jsonb, $6)`,
      [claims.company_id, rule.id, rule.version, action, JSON.stringify(rule), claims.sub]
    );
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "leave_policy.manage"))) throw new ForbiddenException("Not permitted to manage leave rules");
  }
}
