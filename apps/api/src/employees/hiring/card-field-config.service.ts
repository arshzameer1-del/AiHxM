import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { RbacService } from "../../rbac/rbac.service";
import { AuditService } from "../../audit/audit.service";
import { CustomFieldsService } from "../../custom-fields/custom-fields.service";
import { CARD_FIELD_CATALOG } from "./card-field-catalog";
import { CARD_FIELD_METADATA } from "./card-field-metadata";
import type {
  AddCardCustomFieldRequest,
  CardFieldDefinitionView,
  CardFieldsConfigView,
  CustomFieldDefinition,
  UpdateCardFieldConfigRequest,
} from "@aihxm/shared-types";

/**
 * "then 2" Phase 3 (2026-10-02) — the cards whose `hire_process_card_data.data`
 * is a flat object keyed directly by `CARD_FIELD_CATALOG` field keys
 * (`{ firstName: "...", ... }`), as opposed to a "list" card whose data
 * is `{ <itemsKey>: [...] }` with the catalog describing one array
 * item's shape. `applyFieldConfigRules()` only ever runs its defaults/
 * validation/required checks for a card in this set — see that method's
 * own doc comment.
 */
const FLAT_DATA_CARDS = new Set([
  "personal_identity",
  "employment",
  "organization_assignment",
  "reporting_relationships",
  "working_time",
  "compensation",
  "payment_bank",
  "time_leave_setup",
  "benefits",
  "emergency_safety",
]);

const MODULE_KEY = "employee" as const;
// Same single gate the rest of Hiring Card Configuration already uses
// (`HiringProcessService`'s own `MANAGE_PERMISSION`) — this is an
// extension of that same admin surface, not a separately-permissioned
// feature.
const MANAGE_PERMISSION = "employee.manage.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToFieldView(row: any): CardFieldDefinitionView {
  const seed = CARD_FIELD_CATALOG.find((f) => f.cardKey === row.card_key && f.fieldKey === row.field_key);
  return {
    cardKey: row.card_key,
    fieldKey: row.field_key,
    label: seed?.label ?? row.field_key,
    isEnabled: row.is_enabled,
    isRequired: row.is_required,
    sortOrder: row.sort_order,
    defaultValue: row.default_value ?? null,
    validationRules: row.validation_rules ?? null,
    conditionalOn: row.conditional_on ?? null,
    fieldType: row.field_type ?? null,
    helpText: row.help_text ?? null,
    placeholder: row.placeholder ?? null,
    optionValues: row.option_values ?? null,
    referenceCatalogType: row.reference_catalog_type ?? null,
    referenceObject: row.reference_object ?? null,
    sensitivityClass: row.sensitivity_class ?? null,
    visibilityRule: row.visibility_rule ?? null,
    editabilityRule: row.editability_rule ?? null,
    dataScopeRule: row.data_scope_rule ?? null,
    workflowRule: row.workflow_rule ?? null,
    auditPolicy: row.audit_policy ?? "changes",
    isEffectiveDated: row.is_effective_dated ?? false,
    labelI18n: row.label_i18n ?? {},
    helpI18n: row.help_i18n ?? {},
  };
}

/** Columns of CFG-12 metadata a PATCH may set, with how each value is stored. Whitelist - never built from user input. */
const FIELD_META_COLUMNS: Record<string, { column: string; kind: "text" | "jsonb" | "bool" | "enum"; allowed?: readonly string[] }> = {
  fieldType: { column: "field_type", kind: "enum", allowed: ["text", "textarea", "number", "date", "boolean", "select", "catalog", "reference", "file", "email", "phone"] },
  label: { column: "label", kind: "text" },
  helpText: { column: "help_text", kind: "text" },
  placeholder: { column: "placeholder", kind: "text" },
  optionValues: { column: "option_values", kind: "jsonb" },
  referenceCatalogType: { column: "reference_catalog_type", kind: "text" },
  referenceObject: { column: "reference_object", kind: "text" },
  sensitivityClass: { column: "sensitivity_class", kind: "enum", allowed: ["normal", "confidential", "restricted", "highly_restricted"] },
  visibilityRule: { column: "visibility_rule", kind: "jsonb" },
  editabilityRule: { column: "editability_rule", kind: "jsonb" },
  dataScopeRule: { column: "data_scope_rule", kind: "jsonb" },
  workflowRule: { column: "workflow_rule", kind: "jsonb" },
  auditPolicy: { column: "audit_policy", kind: "enum", allowed: ["none", "changes", "reads_and_changes"] },
  isEffectiveDated: { column: "is_effective_dated", kind: "bool" },
  labelI18n: { column: "label_i18n", kind: "jsonb" },
  helpI18n: { column: "help_i18n", kind: "jsonb" },
};
const RULE_SLOTS = ["visibilityRule", "editabilityRule", "dataScopeRule", "workflowRule"] as const;

/** `objectKey` custom field definitions/values are scoped under for a given hiring card — shared with `HiringProcessService.complete()`'s own copy-to-employee step, which must use the exact same convention. */
export function hiringCardObjectKey(cardKey: string): string {
  return `hiring_card:${cardKey}`;
}

/**
 * Hiring Card Field Configuration (2026-09-27) — kumail's own request,
 * looking at the Hiring Card Designer's card-level toggles: field-level
 * enable/disable/required for each card's built-in fields, plus an "add
 * custom field" action per card. See `card-field-catalog.ts`'s own header
 * comment for the built-in side, and `0091_hiring_card_field_configuration.sql`
 * for why "add custom field" reuses the existing WRICEF `CustomFieldsService`
 * rather than forking a second field-definition engine.
 *
 * Lives in the `hiring/` folder, not its own module, for the same reason
 * `HiringProcessService` does — this IS the hiring configuration surface,
 * not a parallel one.
 */
@Injectable()
export class CardFieldConfigService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly customFields: CustomFieldsService
  ) {}

  private async requireAccess(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage hiring card field configuration");
    }
  }

  /**
   * Seeds this company's built-in field rows on first real read — the
   * same "if any row already exists, assume already seeded" shape
   * `HiringProcessService.ensureCardDefinitions()` and
   * `HrReferenceCatalogService.ensureDefaultCatalogItems()` both already
   * use, and for the identical reason: a company created after this
   * migration ran would otherwise start with zero field rows, which would
   * make every built-in field look "unconfigured" rather than enabled by
   * default.
   */
  async ensureDefaultFieldDefinitions(client: PoolClient, companyId: string): Promise<void> {
    const existing = await client.query("SELECT 1 FROM core_employee_card_field_definitions WHERE company_id = $1 LIMIT 1", [companyId]);
    if ((existing.rowCount ?? 0) > 0) return;
    for (const field of CARD_FIELD_CATALOG) {
      await client.query(
        `INSERT INTO core_employee_card_field_definitions (company_id, card_key, field_key, is_required, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, card_key, field_key) DO NOTHING`,
        [companyId, field.cardKey, field.fieldKey, field.defaultRequired, field.sortOrder]
      );
    }
  }

  /**
   * CFG-12: fills label / field type / sensitivity / option or reference links
   * for built-in fields that have none yet, from card-field-metadata.ts. Only
   * NULL columns are written, so anything an admin set is never overwritten.
   */
  async syncFieldMetadata(client: PoolClient, companyId: string): Promise<void> {
    const rows = CARD_FIELD_CATALOG.map((f) => {
      const meta = CARD_FIELD_METADATA[`${f.cardKey}.${f.fieldKey}`];
      return {
        card_key: f.cardKey,
        field_key: f.fieldKey,
        label: f.label,
        field_type: meta?.fieldType ?? null,
        sensitivity_class: meta?.sensitivity ?? null,
        reference_catalog_type: meta?.referenceCatalogType ?? null,
        reference_object: meta?.referenceObject ?? null,
        option_values: meta?.optionValues ? JSON.stringify(meta.optionValues) : null,
      };
    });
    await client.query(
      `UPDATE core_employee_card_field_definitions d SET
         label = COALESCE(d.label, v.label),
         field_type = COALESCE(d.field_type, v.field_type),
         sensitivity_class = COALESCE(d.sensitivity_class, v.sensitivity_class),
         reference_catalog_type = COALESCE(d.reference_catalog_type, v.reference_catalog_type),
         reference_object = COALESCE(d.reference_object, v.reference_object),
         option_values = COALESCE(d.option_values, v.option_values::jsonb)
       FROM jsonb_to_recordset($2::jsonb) AS v(card_key text, field_key text, label text, field_type text, sensitivity_class text,
                                               reference_catalog_type text, reference_object text, option_values text)
       WHERE d.company_id = $1 AND d.card_key = v.card_key AND d.field_key = v.field_key
         AND (d.label IS NULL OR (d.field_type IS NULL AND v.field_type IS NOT NULL) OR (d.sensitivity_class IS NULL AND v.sensitivity_class IS NOT NULL))`,
      [companyId, JSON.stringify(rows)]
    );
  }

  /** Validates a rule slot: inline condition, or a {ref} to an active rule_definitions row of this company. */
  private async assertRuleSlot(client: PoolClient, companyId: string, slotName: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${slotName} must be an object or null`);
    const v = value as Record<string, unknown>;
    if ("ref" in v) {
      if (typeof v.ref !== "string") throw new BadRequestException(`${slotName}.ref must be a rule key`);
      const found = await client.query("SELECT 1 FROM rule_definitions WHERE company_id = $1 AND rule_key = $2 AND is_active", [companyId, v.ref]);
      if ((found.rowCount ?? 0) === 0) throw new BadRequestException(`${slotName} references unknown or inactive rule "${v.ref}"`);
      return;
    }
    if (typeof v.fieldKey !== "string" || !["equals", "notEquals"].includes(String(v.operator)) || typeof v.value !== "string") {
      throw new BadRequestException(`${slotName} must be {fieldKey, operator: equals|notEquals, value} or {ref}`);
    }
  }

  /** This card's built-in fields (enable/required/order) plus whatever custom fields have been added to it — everything one card's field-configuration screen, and the live Hiring Wizard, need to render that card. */
  async listCardFields(claims: RequestClaims, cardKey: string): Promise<CardFieldsConfigView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultFieldDefinitions(client, claims.company_id!);
      await this.syncFieldMetadata(client, claims.company_id!);
      const result = await client.query(
        "SELECT * FROM core_employee_card_field_definitions WHERE company_id = $1 AND card_key = $2 ORDER BY sort_order, field_key",
        [claims.company_id, cardKey]
      );
      const builtIn = result.rows.map(rowToFieldView);
      const custom = await this.customFields.listDefinitions(claims, hiringCardObjectKey(cardKey));
      return { cardKey, builtIn, custom };
    });
  }

  async updateFieldConfig(
    claims: RequestClaims,
    cardKey: string,
    fieldKey: string,
    patch: UpdateCardFieldConfigRequest
  ): Promise<CardFieldDefinitionView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultFieldDefinitions(client, claims.company_id!);
      // `default_value`/`validation_rules`/`conditional_on` use a
      // 3-valued "leave unchanged / set / clear" convention, the same
      // one `HrBusinessPolicyService.update()`'s own `rules` patch uses:
      // `undefined` (key omitted from the request) leaves the column
      // alone via `COALESCE`; an explicit `null` clears it (COALESCE
      // can't distinguish "clear" from "leave alone" on its own, so those
      // two columns are written directly whenever the key is PRESENT in
      // `patch`, not merged through COALESCE).
      const hasValidationRules = Object.prototype.hasOwnProperty.call(patch, "validationRules");
      const hasConditionalOn = Object.prototype.hasOwnProperty.call(patch, "conditionalOn");
      const hasDefaultValue = Object.prototype.hasOwnProperty.call(patch, "defaultValue");
      const result = await client.query(
        `UPDATE core_employee_card_field_definitions SET
           is_enabled = COALESCE($4, is_enabled),
           is_required = COALESCE($5, is_required),
           default_value = CASE WHEN $6 THEN $7 ELSE default_value END,
           validation_rules = CASE WHEN $8 THEN $9::jsonb ELSE validation_rules END,
           conditional_on = CASE WHEN $10 THEN $11::jsonb ELSE conditional_on END,
           updated_at = now()
         WHERE company_id = $1 AND card_key = $2 AND field_key = $3
         RETURNING *`,
        [
          claims.company_id,
          cardKey,
          fieldKey,
          patch.isEnabled ?? null,
          patch.isRequired ?? null,
          hasDefaultValue,
          patch.defaultValue ?? null,
          hasValidationRules,
          patch.validationRules != null ? JSON.stringify(patch.validationRules) : null,
          hasConditionalOn,
          patch.conditionalOn != null ? JSON.stringify(patch.conditionalOn) : null,
        ]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException(`Unknown field "${fieldKey}" on card "${cardKey}"`);
      }
      let row = result.rows[0];

      // CFG-12 metadata (each key present in the patch is written; null clears)
      const sets: string[] = [];
      const params: unknown[] = [claims.company_id, cardKey, fieldKey];
      for (const [key, spec] of Object.entries(FIELD_META_COLUMNS)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const value = (patch as Record<string, unknown>)[key];
        if (spec.kind === "enum" && value !== null && !spec.allowed!.includes(String(value))) {
          throw new BadRequestException(`${key} must be one of ${spec.allowed!.join(", ")}`);
        }
        if ((RULE_SLOTS as readonly string[]).includes(key)) await this.assertRuleSlot(client, claims.company_id!, key, value);
        if ((key === "labelI18n" || key === "helpI18n") && (value === null || typeof value !== "object" || Array.isArray(value))) {
          throw new BadRequestException(`${key} must be an object of locale -> text`);
        }
        if (key === "optionValues" && value !== null && (!Array.isArray(value) || value.some((o) => typeof o !== "string"))) {
          throw new BadRequestException("optionValues must be a list of strings");
        }
        if (spec.kind === "bool" && typeof value !== "boolean") throw new BadRequestException(`${key} must be true or false`);
        params.push(spec.kind === "jsonb" ? (value === null ? null : JSON.stringify(value)) : value);
        sets.push(`${spec.column} = $${params.length}${spec.kind === "jsonb" ? "::jsonb" : ""}`);
      }
      if (sets.length > 0) {
        try {
          const meta = await client.query(
            `UPDATE core_employee_card_field_definitions SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND card_key = $2 AND field_key = $3 RETURNING *`,
            params
          );
          row = meta.rows[0];
        } catch (err) {
          if ((err as { code?: string }).code === "23514") {
            throw new BadRequestException("A select field needs optionValues, a catalog field a referenceCatalogType and a reference field a referenceObject");
          }
          throw err;
        }
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "core_employee_card_field.updated",
        target: `${cardKey}.${fieldKey}`,
        metadata: patch,
      });
      return rowToFieldView(row);
    });
  }

  /**
   * "then 2" Phase 3 (2026-10-02) — the real enforcement half of
   * defaults/validation/conditional-display, called by
   * `HiringProcessService.saveCard()` on its own already-open
   * transaction, BEFORE that method persists `input.data`. Returns the
   * data object to actually store (defaults merged in for any field the
   * caller omitted entirely), and throws `BadRequestException` naming
   * the offending field if a present value fails its configured
   * validation rule, or if a field that's both enabled, required, and
   * NOT hidden by an unmet `conditionalOn` condition is still missing
   * after defaults were applied.
   *
   * Deliberately does nothing for DISABLED fields (a disabled field's
   * value, if somehow still present in `data`, is left exactly as
   * submitted — this method only ever adds defaults and rejects bad
   * values, never silently drops data) and for fields with no
   * configuration row at all (a brand-new custom field or a field this
   * company's `ensureDefaultFieldDefinitions()` hasn't seeded yet is
   * treated as unconfigured, i.e. always allowed).
   *
   * Deliberately ALSO does nothing for a card whose `cardKey` isn't in
   * `FLAT_DATA_CARDS` below. `CARD_FIELD_CATALOG`'s own entries for a
   * "list" card (Contact, Addresses, Important Dates, Cost Allocation,
   * Family/Dependents, Education, Qualifications/Skills, Assets,
   * Documents) describe the shape of ONE ITEM in that card's array —
   * e.g. `family_dependents`' `relationship` field — not a key that
   * ever appears at the top level of that card's own `data` object
   * (which is `{ members: [...] }`, not `{ relationship: ... }`).
   * Enforcing "relationship is required" by checking
   * `data.relationship` would therefore reject every real submission to
   * that card, which is exactly the regression caught while verifying
   * this phase (`hiring-process.service.spec.ts`'s Phase 7/8/9 fixtures)
   * — per-ITEM defaults/validation/required for a list card is real,
   * separately-scoped follow-up work (it needs to walk each array
   * element against the field catalog, not a single top-level lookup),
   * not built speculatively here.
   */
  async applyFieldConfigRules(
    client: PoolClient,
    companyId: string,
    cardKey: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!FLAT_DATA_CARDS.has(cardKey)) return data;
    await this.ensureDefaultFieldDefinitions(client, companyId);
    const result = await client.query(
      "SELECT * FROM core_employee_card_field_definitions WHERE company_id = $1 AND card_key = $2 AND is_enabled = true",
      [companyId, cardKey]
    );
    const next: Record<string, unknown> = { ...data };

    // Pass 1 — defaults, so pass 2's validation/required/conditional
    // checks all see the final, post-default value a field will
    // actually be stored with.
    for (const row of result.rows) {
      const fieldKey = row.field_key as string;
      const isMissing = next[fieldKey] === undefined || next[fieldKey] === null || next[fieldKey] === "";
      if (isMissing && row.default_value !== null && row.default_value !== undefined) {
        next[fieldKey] = row.default_value;
      }
    }

    // Pass 2 — validation rules and required/conditional-display.
    for (const row of result.rows) {
      const fieldKey = row.field_key as string;
      const label = CARD_FIELD_CATALOG.find((f) => f.cardKey === cardKey && f.fieldKey === fieldKey)?.label ?? fieldKey;
      const value = next[fieldKey];
      const isPresent = value !== undefined && value !== null && value !== "";

      if (isPresent && row.validation_rules) {
        const rules = row.validation_rules as { pattern?: string; minLength?: number; maxLength?: number; min?: number; max?: number };
        const text = String(value);
        if (rules.pattern && !new RegExp(rules.pattern).test(text)) {
          throw new BadRequestException(`"${label}" doesn't match the required format for this company.`);
        }
        if (rules.minLength !== undefined && text.length < rules.minLength) {
          throw new BadRequestException(`"${label}" must be at least ${rules.minLength} characters.`);
        }
        if (rules.maxLength !== undefined && text.length > rules.maxLength) {
          throw new BadRequestException(`"${label}" must be at most ${rules.maxLength} characters.`);
        }
        const numeric = typeof value === "number" ? value : Number(value);
        if (rules.min !== undefined && !Number.isNaN(numeric) && numeric < rules.min) {
          throw new BadRequestException(`"${label}" must be at least ${rules.min}.`);
        }
        if (rules.max !== undefined && !Number.isNaN(numeric) && numeric > rules.max) {
          throw new BadRequestException(`"${label}" must be at most ${rules.max}.`);
        }
      }

      if (row.is_required && !isPresent) {
        const condition = row.conditional_on as { fieldKey: string; operator: "equals" | "notEquals"; value: string } | null;
        const conditionMet =
          !condition ||
          (condition.operator === "equals" ? String(next[condition.fieldKey] ?? "") === condition.value : String(next[condition.fieldKey] ?? "") !== condition.value);
        if (conditionMet) {
          throw new BadRequestException(`"${label}" is required.`);
        }
      }
    }

    return next;
  }

  /**
   * "Add custom field" — kumail's own words, "custom field once added
   * will be visible in respective tile." Defines the field TWICE: once
   * under this card's own `hiring_card:<cardKey>` scope (what the live
   * Hiring Wizard reads while filling this card), and once under
   * `employee` (what the Employee Detail page reads afterward) — kumail's
   * own second scoping choice was that a custom field added during hiring
   * should also show on the employee's profile, not just in the wizard.
   * The employee-scope mirror is never required (`isRequired: false`):
   * "required" only makes sense as a hiring-time capture rule, not as a
   * rule for editing an already-hired employee's profile.
   */
  async addCustomField(claims: RequestClaims, cardKey: string, dto: AddCardCustomFieldRequest): Promise<CustomFieldDefinition> {
    await this.requireAccess(claims);
    const cardScoped = await this.customFields.defineField(claims, {
      objectKey: hiringCardObjectKey(cardKey),
      fieldKey: dto.fieldKey,
      label: dto.label,
      fieldType: dto.fieldType,
      options: dto.options,
      isRequired: dto.isRequired,
    });
    await this.customFields.defineField(claims, {
      objectKey: "employee",
      fieldKey: dto.fieldKey,
      label: dto.label,
      fieldType: dto.fieldType,
      options: dto.options,
      isRequired: false,
    });
    return cardScoped;
  }

  /**
   * Deactivates the field on THIS card only — the `employee`-scope mirror
   * is deliberately left active, so an employee already hired with this
   * field's value stays visible on their profile even after the field is
   * removed from the hiring wizard going forward. A field key reused on a
   * different card would also share that mirror; this is an accepted
   * edge case, not a bug — see this file's own header comment.
   */
  async deactivateCustomField(claims: RequestClaims, cardKey: string, fieldKey: string): Promise<void> {
    await this.requireAccess(claims);
    await this.customFields.deactivateField(claims, hiringCardObjectKey(cardKey), fieldKey);
  }
}
