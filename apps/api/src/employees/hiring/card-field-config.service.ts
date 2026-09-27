import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { RbacService } from "../../rbac/rbac.service";
import { AuditService } from "../../audit/audit.service";
import { CustomFieldsService } from "../../custom-fields/custom-fields.service";
import { CARD_FIELD_CATALOG } from "./card-field-catalog";
import type {
  AddCardCustomFieldRequest,
  CardFieldDefinitionView,
  CardFieldsConfigView,
  CustomFieldDefinition,
  UpdateCardFieldConfigRequest,
} from "@aihxm/shared-types";

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
  };
}

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
  private async ensureDefaultFieldDefinitions(client: PoolClient, companyId: string): Promise<void> {
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

  /** This card's built-in fields (enable/required/order) plus whatever custom fields have been added to it — everything one card's field-configuration screen, and the live Hiring Wizard, need to render that card. */
  async listCardFields(claims: RequestClaims, cardKey: string): Promise<CardFieldsConfigView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.ensureDefaultFieldDefinitions(client, claims.company_id!);
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
      const result = await client.query(
        `UPDATE core_employee_card_field_definitions SET
           is_enabled = COALESCE($4, is_enabled),
           is_required = COALESCE($5, is_required),
           updated_at = now()
         WHERE company_id = $1 AND card_key = $2 AND field_key = $3
         RETURNING *`,
        [claims.company_id, cardKey, fieldKey, patch.isEnabled ?? null, patch.isRequired ?? null]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException(`Unknown field "${fieldKey}" on card "${cardKey}"`);
      }
      await this.db.withClaims(claims, async (c) => {
        await this.audit.record(c, claims, {
          companyId: claims.company_id ?? null,
          action: "core_employee_card_field.updated",
          target: `${cardKey}.${fieldKey}`,
          metadata: patch,
        });
      });
      return rowToFieldView(result.rows[0]);
    });
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
