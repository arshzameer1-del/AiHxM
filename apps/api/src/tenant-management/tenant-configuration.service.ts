import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type {
  TenantConfigurationSetting,
  TenantConfigurationValueType,
  TenantConfigurationVersion,
} from "@aihxm/shared-types";

type DefaultRow = {
  category: string;
  setting_key: string;
  label: string;
  description: string | null;
  value_type: TenantConfigurationValueType;
  default_value: unknown;
};

type OverrideRow = {
  category: string;
  setting_key: string;
  value: unknown;
  updated_at: Date;
  updated_by: string;
};

function validateValue(valueType: TenantConfigurationValueType, value: unknown): void {
  if (valueType === "boolean" && typeof value !== "boolean") {
    throw new BadRequestException(`Expected a boolean value for this setting, got ${typeof value}`);
  }
  if (valueType === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    throw new BadRequestException(`Expected an integer value for this setting, got ${JSON.stringify(value)}`);
  }
  if (valueType === "text" && typeof value !== "string") {
    throw new BadRequestException(`Expected a text value for this setting, got ${typeof value}`);
  }
}

/**
 * TM-018/019/020 — Tenant Configuration: a generic, versioned override
 * system distinct from `configuration-center` (0032), which only INDEXES
 * existing per-module screens. Here, `tenant_configuration_defaults` is
 * the product default; a row in `tenant_configuration` is one tenant's
 * override; "effective value" (what a screen should actually use) is
 * COALESCE(override, default). Every write is versioned into
 * `tenant_configuration_versions`, which Rollback restores from.
 */
@Injectable()
export class TenantConfigurationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async getEffective(claims: RequestClaims, companyId: string): Promise<TenantConfigurationSetting[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const defaults = await client.query<DefaultRow>(
        "SELECT * FROM tenant_configuration_defaults ORDER BY category, setting_key"
      );
      const overrides = await client.query<OverrideRow>(
        "SELECT * FROM tenant_configuration WHERE company_id = $1",
        [companyId]
      );
      const overrideByKey = new Map(overrides.rows.map((o) => [`${o.category}::${o.setting_key}`, o]));

      return defaults.rows.map((d) => {
        const override = overrideByKey.get(`${d.category}::${d.setting_key}`);
        return {
          category: d.category as TenantConfigurationSetting["category"],
          settingKey: d.setting_key,
          label: d.label,
          description: d.description,
          valueType: d.value_type,
          defaultValue: d.default_value,
          overrideValue: override ? override.value : null,
          effectiveValue: override ? override.value : d.default_value,
          isOverridden: Boolean(override),
          updatedAt: override ? override.updated_at.toISOString() : null,
          updatedBy: override ? override.updated_by : null,
        };
      });
    });
  }

  /** TM-019 — create/replace this tenant's override for one setting. */
  async setOverride(
    claims: RequestClaims,
    companyId: string,
    category: string,
    settingKey: string,
    value: unknown
  ): Promise<TenantConfigurationSetting> {
    return this.db.withClaims(claims, async (client) => {
      const defRow = await client.query<DefaultRow>(
        "SELECT * FROM tenant_configuration_defaults WHERE category = $1 AND setting_key = $2",
        [category, settingKey]
      );
      if (defRow.rowCount === 0) {
        throw new NotFoundException("Unknown configuration setting");
      }
      validateValue(defRow.rows[0].value_type, value);
      return this.setOverrideInternal(client, claims, companyId, category, settingKey, value, "tenant_configuration.overridden");
    });
  }

  /** Removes this tenant's override, reverting the setting to the product default. */
  async resetToDefault(claims: RequestClaims, companyId: string, category: string, settingKey: string): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      const existing = await client.query<OverrideRow>(
        "SELECT * FROM tenant_configuration WHERE company_id = $1 AND category = $2 AND setting_key = $3",
        [companyId, category, settingKey]
      );
      if (existing.rowCount === 0) {
        return;
      }
      const defRow = await client.query<DefaultRow>(
        "SELECT default_value FROM tenant_configuration_defaults WHERE category = $1 AND setting_key = $2",
        [category, settingKey]
      );
      await client.query(
        "DELETE FROM tenant_configuration WHERE company_id = $1 AND category = $2 AND setting_key = $3",
        [companyId, category, settingKey]
      );
      await client.query(
        `INSERT INTO tenant_configuration_versions (company_id, category, setting_key, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
        [
          companyId,
          category,
          settingKey,
          JSON.stringify(existing.rows[0].value),
          defRow.rows[0] ? JSON.stringify(defRow.rows[0].default_value) : "null",
          claims.sub,
        ]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_configuration.reset_to_default",
        target: `${category}.${settingKey}`,
        metadata: {},
      });
    });
  }

  /** TM-020 — full change history for one setting, most recent first. */
  async getHistory(
    claims: RequestClaims,
    companyId: string,
    category: string,
    settingKey: string
  ): Promise<TenantConfigurationVersion[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM tenant_configuration_versions
         WHERE company_id = $1 AND category = $2 AND setting_key = $3
         ORDER BY changed_at DESC`,
        [companyId, category, settingKey]
      );
      return result.rows.map((row) => ({
        id: row.id,
        companyId: row.company_id,
        category: row.category,
        settingKey: row.setting_key,
        oldValue: row.old_value,
        newValue: row.new_value,
        changedBy: row.changed_by,
        changedAt: row.changed_at.toISOString(),
      }));
    });
  }

  /**
   * TM-020 — Rollback: restore the tenant's override to what it was at
   * the moment `versionId` was recorded (i.e. that version's `new_value`
   * becomes current again). This itself is written as a new version entry
   * — a rollback is a change like any other, not a history edit — so the
   * full timeline (including "we rolled back to X") stays intact.
   */
  async rollback(claims: RequestClaims, companyId: string, versionId: string): Promise<TenantConfigurationSetting> {
    return this.db.withClaims(claims, async (client) => {
      const versionRow = await client.query(
        "SELECT * FROM tenant_configuration_versions WHERE id = $1 AND company_id = $2",
        [versionId, companyId]
      );
      if (versionRow.rowCount === 0) {
        throw new NotFoundException("Configuration version not found");
      }
      const version = versionRow.rows[0];
      return this.setOverrideInternal(
        client,
        claims,
        companyId,
        version.category,
        version.setting_key,
        version.new_value,
        "tenant_configuration.rolled_back"
      );
    });
  }

  // Shared by setOverride()/rollback() so both paths go through the same
  // version + audit sequence, differing only in the audit action name.
  private async setOverrideInternal(
    client: PoolClient,
    claims: RequestClaims,
    companyId: string,
    category: string,
    settingKey: string,
    value: unknown,
    auditAction: string
  ): Promise<TenantConfigurationSetting> {
    const defRow = await client.query<DefaultRow>(
      "SELECT * FROM tenant_configuration_defaults WHERE category = $1 AND setting_key = $2",
      [category, settingKey]
    );
    if (defRow.rowCount === 0) {
      throw new NotFoundException("Unknown configuration setting");
    }
    const def = defRow.rows[0];

    const existing = await client.query<OverrideRow>(
      "SELECT * FROM tenant_configuration WHERE company_id = $1 AND category = $2 AND setting_key = $3",
      [companyId, category, settingKey]
    );
    const oldValue = existing.rowCount && existing.rowCount > 0 ? existing.rows[0].value : null;

    const upserted = await client.query<OverrideRow>(
      `INSERT INTO tenant_configuration (company_id, category, setting_key, value, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (company_id, category, setting_key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [companyId, category, settingKey, JSON.stringify(value), claims.sub]
    );

    await client.query(
      `INSERT INTO tenant_configuration_versions (company_id, category, setting_key, old_value, new_value, changed_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [companyId, category, settingKey, oldValue === null ? null : JSON.stringify(oldValue), JSON.stringify(value), claims.sub]
    );

    await this.audit.record(client, claims, {
      companyId,
      action: auditAction,
      target: `${category}.${settingKey}`,
      metadata: { newValue: value },
    });

    const row = upserted.rows[0];
    return {
      category: def.category as TenantConfigurationSetting["category"],
      settingKey: def.setting_key,
      label: def.label,
      description: def.description,
      valueType: def.value_type,
      defaultValue: def.default_value,
      overrideValue: row.value,
      effectiveValue: row.value,
      isOverridden: true,
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by,
    };
  }
}
