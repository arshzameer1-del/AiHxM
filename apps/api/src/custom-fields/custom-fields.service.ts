import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import type { CustomFieldDefinition, CustomFieldType } from "@boostfactor/shared-types";

const MANAGE_PERMISSION = "custom_field.manage.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDefinition(row: any): CustomFieldDefinition {
  return {
    id: row.id,
    companyId: row.company_id,
    objectKey: row.object_key,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    options: row.options ?? undefined,
    isRequired: row.is_required,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

function validateValueAgainstType(fieldType: CustomFieldType, value: unknown, options: string[] | undefined) {
  if (value === null || value === undefined) return;
  switch (fieldType) {
    case "text":
      if (typeof value !== "string") throw new BadRequestException("Expected a text value");
      break;
    case "number":
      if (typeof value !== "number") throw new BadRequestException("Expected a numeric value");
      break;
    case "boolean":
      if (typeof value !== "boolean") throw new BadRequestException("Expected a boolean value");
      break;
    case "date":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new BadRequestException("Expected an ISO date string");
      }
      break;
    case "select":
      if (typeof value !== "string" || !(options ?? []).includes(value)) {
        throw new BadRequestException(`Expected one of: ${(options ?? []).join(", ")}`);
      }
      break;
  }
}

/**
 * Plan doc Section 6's "Enhancements" WRICEF pillar: tenant-defined
 * custom fields on any object, entirely data-driven (a JSONB value column
 * — see 0009_wricef_fields_notifications_forms.sql's header comment for
 * why this is JSONB rather than a wide EAV table with per-type columns).
 * Deliberately decoupled from any specific object's own table, the same
 * way WorkflowService is — this service only ever knows
 * (companyId, objectKey, recordId), never how to query the object itself.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService
  ) {}

  async defineField(
    claims: RequestClaims,
    dto: { objectKey: string; fieldKey: string; label: string; fieldType: CustomFieldType; options?: string[]; isRequired?: boolean }
  ): Promise<CustomFieldDefinition> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage custom fields");
    }
    if (dto.fieldType === "select" && (!dto.options || dto.options.length === 0)) {
      throw new BadRequestException("A select field needs at least one option");
    }

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO custom_field_definitions (company_id, object_key, field_key, label, field_type, options, is_required)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (company_id, object_key, field_key)
         DO UPDATE SET label = EXCLUDED.label, field_type = EXCLUDED.field_type,
                        options = EXCLUDED.options, is_required = EXCLUDED.is_required
         RETURNING *`,
        [
          claims.company_id,
          dto.objectKey,
          dto.fieldKey,
          dto.label,
          dto.fieldType,
          dto.options ? JSON.stringify(dto.options) : null,
          dto.isRequired ?? false,
        ]
      );
      return toDefinition(result.rows[0]);
    });
  }

  async listDefinitions(claims: RequestClaims, objectKey: string): Promise<CustomFieldDefinition[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM custom_field_definitions WHERE company_id = $1 AND object_key = $2 ORDER BY created_at ASC`,
        [claims.company_id, objectKey]
      );
      return result.rows.map(toDefinition);
    });
  }

  /**
   * Validates `value` against the field's own definition (type, and
   * membership in `options` for a select) before writing — the one piece
   * of business logic this "purely data-driven" engine still owns, so a
   * bad value can't silently corrupt what every later reader of this
   * field assumes about its shape.
   */
  async setValue(
    claims: RequestClaims,
    dto: { objectKey: string; recordId: string; fieldKey: string; value: unknown }
  ): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException();

    await this.db.withClaims(claims, async (client) => {
      const definitionResult = await client.query<{ field_type: CustomFieldType; options: string[] | null; is_required: boolean }>(
        `SELECT field_type, options, is_required FROM custom_field_definitions
         WHERE company_id = $1 AND object_key = $2 AND field_key = $3`,
        [claims.company_id, dto.objectKey, dto.fieldKey]
      );
      if (definitionResult.rowCount === 0) {
        throw new BadRequestException(`No custom field '${dto.fieldKey}' defined for ${dto.objectKey}`);
      }
      const definition = definitionResult.rows[0];
      if (definition.is_required && (dto.value === null || dto.value === undefined)) {
        throw new BadRequestException(`${dto.fieldKey} is required`);
      }
      validateValueAgainstType(definition.field_type, dto.value, definition.options ?? undefined);

      await client.query(
        `INSERT INTO custom_field_values (company_id, object_key, record_id, field_key, value)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (company_id, object_key, record_id, field_key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [claims.company_id, dto.objectKey, dto.recordId, dto.fieldKey, JSON.stringify(dto.value ?? null)]
      );
    });
  }

  /**
   * Total custom field definitions across every object key for this
   * tenant — unlike `listDefinitions`, not scoped to one `objectKey`,
   * because Configuration Center wants a single "how many custom fields
   * exist" number, not a per-object breakdown. Same open-read posture as
   * `listDefinitions` (definitions describe form shape, not sensitive
   * data, so no permission gate here either).
   */
  async countAllDefinitions(claims: RequestClaims): Promise<number> {
    if (!claims.company_id) return 0;
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM custom_field_definitions WHERE company_id = $1`,
        [claims.company_id]
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  /** Every custom field value set on one record, keyed by fieldKey — the shape a module merges into its own record view. */
  async getValues(claims: RequestClaims, objectKey: string, recordId: string): Promise<Record<string, unknown>> {
    if (!claims.company_id) return {};
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ field_key: string; value: unknown }>(
        `SELECT field_key, value FROM custom_field_values WHERE company_id = $1 AND object_key = $2 AND record_id = $3`,
        [claims.company_id, objectKey, recordId]
      );
      const values: Record<string, unknown> = {};
      for (const row of result.rows) {
        values[row.field_key] = row.value;
      }
      return values;
    });
  }
}
