import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { FormFieldSettingView, FormSettingHistoryView, FormSettingsView, UpdateFormFieldSettingRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { FORM_CATALOG, formByKey, type CatalogField, type CatalogForm } from "./form-catalog";

const MANAGE = "employee.manage.all";

type Row = { label: string | null; help_text: string | null; placeholder: string | null; is_hidden: boolean; is_required: boolean | null; max_length: number | null };
type Snapshot = { label: string | null; helpText: string | null; placeholder: string | null; hidden: boolean; required: boolean | null; maxLength: number | null };

const snap = (r: Row | undefined): Snapshot | null =>
  r ? { label: r.label, helpText: r.help_text, placeholder: r.placeholder, hidden: r.is_hidden, required: r.is_required, maxLength: r.max_length } : null;

function effective(field: CatalogField, row: Row | undefined): FormFieldSettingView {
  const hidden = field.canHide ? (row?.is_hidden ?? false) : false;
  const required = hidden ? false : field.canRequire ? (row?.is_required ?? field.defaultRequired) : field.defaultRequired;
  const maxLength = field.canSetMaxLength ? (row?.max_length ?? null) : null;
  return {
    fieldKey: field.key,
    defaultLabel: field.label,
    label: row?.label?.trim() || field.label,
    helpText: row?.help_text || null,
    placeholder: row?.placeholder || null,
    hidden,
    required,
    maxLength: field.hardMaxLength && maxLength ? Math.min(maxLength, field.hardMaxLength) : maxLength,
    canHide: field.canHide,
    canRequire: field.canRequire,
    canSetMaxLength: field.canSetMaxLength,
    customised: Boolean(row),
  };
}

/**
 * Form settings: one reusable engine that lets a company relabel a form field, add help text, make it required, hide it or limit its length.
 * The same settings are read by the screen (to draw the form) and by `enforce()` on the server (to refuse a request that breaks them), so
 * a setting can never be ignored by calling the API directly. What may be changed on each field is decided in `form-catalog.ts`.
 */
@Injectable()
export class FormSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  private async requireManage(claims: RequestClaims) {
    if (!claims.company_id) throw new ForbiddenException("A company login is needed");
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to change form settings");
  }

  private async rows(claims: RequestClaims, formKey?: string): Promise<Map<string, Row>> {
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `SELECT form_key, field_key, label, help_text, placeholder, is_hidden, is_required, max_length FROM form_field_settings
          WHERE company_id = $1 ${formKey ? "AND form_key = $2" : ""}`,
        formKey ? [claims.company_id, formKey] : [claims.company_id]
      );
      return new Map<string, Row>(r.rows.map((x) => [`${x.form_key}.${x.field_key}`, x as Row]));
    });
  }

  private view(form: CatalogForm, rows: Map<string, Row>): FormSettingsView {
    return { formKey: form.key, title: form.title, fields: form.fields.map((f) => effective(f, rows.get(`${form.key}.${f.key}`))) };
  }

  /** For the Configuration Center card: how many fields this company has changed (0 = every form still uses its defaults). */
  async countCustomised(claims: RequestClaims): Promise<number> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM form_field_settings WHERE company_id = $1", [claims.company_id]);
      return r.rows[0].n as number;
    });
  }

  /** Every screen asks for its own form's settings; any signed-in company user may read them. */
  async forms(claims: RequestClaims): Promise<FormSettingsView[]> {
    if (!claims.company_id) return [];
    const rows = await this.rows(claims);
    return FORM_CATALOG.map((f) => this.view(f, rows));
  }

  async form(claims: RequestClaims, formKey: string): Promise<FormSettingsView> {
    const form = formByKey(formKey);
    if (!form) throw new NotFoundException("Unknown form");
    if (!claims.company_id) throw new ForbiddenException("A company login is needed");
    return this.view(form, await this.rows(claims, formKey));
  }

  async update(claims: RequestClaims, formKey: string, fieldKey: string, input: UpdateFormFieldSettingRequest): Promise<FormSettingsView> {
    await this.requireManage(claims);
    const form = formByKey(formKey);
    const field = form?.fields.find((f) => f.key === fieldKey);
    if (!form || !field) throw new NotFoundException("Unknown form or field");

    const clean = (v: string | null | undefined, max: number, what: string) => {
      if (v === undefined) return undefined;
      const t = (v ?? "").trim();
      if (t.length > max) throw new BadRequestException(`${what} can be at most ${max} characters`);
      return t === "" ? null : t;
    };
    const label = clean(input.label, 80, "The label");
    const helpText = clean(input.helpText, 300, "The help text");
    const placeholder = clean(input.placeholder, 120, "The placeholder");
    if (input.hidden === true && !field.canHide) throw new BadRequestException(`"${field.label}" is always needed and cannot be hidden`);
    if (input.required !== undefined && input.required !== null && !field.canRequire) throw new BadRequestException(`"${field.label}" cannot be made optional or required`);
    if (input.maxLength !== undefined && input.maxLength !== null) {
      if (!field.canSetMaxLength) throw new BadRequestException(`A length limit cannot be set on "${field.label}"`);
      if (!Number.isInteger(input.maxLength) || input.maxLength < 1) throw new BadRequestException("The length limit must be a whole number of 1 or more");
      if (field.hardMaxLength && input.maxLength > field.hardMaxLength) throw new BadRequestException(`"${field.label}" can allow at most ${field.hardMaxLength} characters`);
    }

    await this.db.withClaims(claims, async (c) => {
      const cur = (await c.query("SELECT label, help_text, placeholder, is_hidden, is_required, max_length FROM form_field_settings WHERE company_id = $1 AND form_key = $2 AND field_key = $3", [claims.company_id, formKey, fieldKey])).rows[0] as Row | undefined;
      const next: Snapshot = {
        label: label !== undefined ? label : (cur?.label ?? null),
        helpText: helpText !== undefined ? helpText : (cur?.help_text ?? null),
        placeholder: placeholder !== undefined ? placeholder : (cur?.placeholder ?? null),
        hidden: input.hidden !== undefined ? input.hidden : (cur?.is_hidden ?? false),
        required: input.required !== undefined ? input.required : (cur?.is_required ?? null),
        maxLength: input.maxLength !== undefined ? input.maxLength : (cur?.max_length ?? null),
      };
      if (next.hidden && next.required === true) throw new BadRequestException("A hidden field cannot also be required");
      await this.write(c, claims, formKey, fieldKey, next, "change", snap(cur));
    });
    return this.form(claims, formKey);
  }

  async reset(claims: RequestClaims, formKey: string, fieldKey: string): Promise<FormSettingsView> {
    await this.requireManage(claims);
    const field = formByKey(formKey)?.fields.find((f) => f.key === fieldKey);
    if (!field) throw new NotFoundException("Unknown form or field");
    await this.db.withClaims(claims, async (c) => {
      const cur = (await c.query("SELECT label, help_text, placeholder, is_hidden, is_required, max_length FROM form_field_settings WHERE company_id = $1 AND form_key = $2 AND field_key = $3", [claims.company_id, formKey, fieldKey])).rows[0] as Row | undefined;
      if (!cur) return;
      await this.write(c, claims, formKey, fieldKey, null, "reset", snap(cur));
    });
    return this.form(claims, formKey);
  }

  async history(claims: RequestClaims, formKey?: string): Promise<FormSettingHistoryView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `SELECT id, form_key, field_key, action, before, after, changed_by, changed_at FROM form_field_setting_history
          WHERE company_id = $1 ${formKey ? "AND form_key = $2" : ""} ORDER BY changed_at DESC, id LIMIT 100`,
        formKey ? [claims.company_id, formKey] : [claims.company_id]
      );
      return r.rows.map((x) => ({ id: x.id, formKey: x.form_key, fieldKey: x.field_key, action: x.action, before: x.before, after: x.after, changedAt: x.changed_at.toISOString(), changedBy: x.changed_by }));
    });
  }

  /** Puts a field back to how it was before the chosen change. The restore itself is recorded, so it can be undone too. */
  async restore(claims: RequestClaims, historyId: string): Promise<FormSettingsView> {
    await this.requireManage(claims);
    const entry = await this.db.withClaims(claims, async (c) => (await c.query("SELECT form_key, field_key, before FROM form_field_setting_history WHERE id = $1 AND company_id = $2", [historyId, claims.company_id])).rows[0]);
    if (!entry) throw new NotFoundException("That change was not found");
    const field = formByKey(entry.form_key)?.fields.find((f) => f.key === entry.field_key);
    if (!field) throw new NotFoundException("That field no longer exists");
    await this.db.withClaims(claims, async (c) => {
      const cur = (await c.query("SELECT label, help_text, placeholder, is_hidden, is_required, max_length FROM form_field_settings WHERE company_id = $1 AND form_key = $2 AND field_key = $3", [claims.company_id, entry.form_key, entry.field_key])).rows[0] as Row | undefined;
      await this.write(c, claims, entry.form_key, entry.field_key, (entry.before as Snapshot | null) ?? null, "restore", snap(cur));
    });
    return this.form(claims, entry.form_key);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async write(c: any, claims: RequestClaims, formKey: string, fieldKey: string, next: Snapshot | null, action: "change" | "reset" | "restore", before: Snapshot | null) {
    if (next === null) {
      await c.query("DELETE FROM form_field_settings WHERE company_id = $1 AND form_key = $2 AND field_key = $3", [claims.company_id, formKey, fieldKey]);
    } else {
      await c.query(
        `INSERT INTO form_field_settings (company_id, form_key, field_key, label, help_text, placeholder, is_hidden, is_required, max_length, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (company_id, form_key, field_key) DO UPDATE SET label = $4, help_text = $5, placeholder = $6, is_hidden = $7, is_required = $8, max_length = $9, updated_by = $10, updated_at = now()`,
        [claims.company_id, formKey, fieldKey, next.label, next.helpText, next.placeholder, next.hidden, next.required, next.maxLength, claims.sub]
      );
    }
    await c.query("INSERT INTO form_field_setting_history (company_id, form_key, field_key, action, before, after, changed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [claims.company_id, formKey, fieldKey, action, before, next, claims.sub]);
    await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: `form_settings.${action}`, target: `${formKey}.${fieldKey}`, before: before as Record<string, unknown> | null, after: next as Record<string, unknown> | null, metadata: {} });
  }

  /**
   * Refuses a request that breaks the company's settings for this form: a required field left empty, or text longer than the limit.
   * A hidden field is not asked for. Called by the server before the request is acted on, so an API caller is held to the same rules as the screen.
   */
  async enforce(claims: RequestClaims, formKey: string, payload: Record<string, unknown>, opts: { clear?: readonly string[] } = {}): Promise<void> {
    const form = formByKey(formKey);
    if (!form || !claims.company_id) return;
    const settings = this.view(form, await this.rows(claims, formKey));
    const problems: string[] = [];
    for (const f of settings.fields) {
      const v = payload[f.fieldKey];
      const text = typeof v === "string" ? v.trim() : v;
      const blank = text === undefined || text === null || text === "";
      // A form that edits a saved record sends only what changed: a field it does not mention stays as it was, so only an
      // explicit blank or an explicit clear of a required field is refused.
      const mentioned = !form.partial || f.fieldKey in payload || (opts.clear ?? []).includes(f.fieldKey);
      if (f.canRequire && f.required && !f.hidden && mentioned && (blank || (opts.clear ?? []).includes(f.fieldKey))) problems.push(`${f.label} is required`);
      if (!blank && f.maxLength && typeof v === "string" && v.length > f.maxLength) problems.push(`${f.label} can be at most ${f.maxLength} characters`);
    }
    if (problems.length) throw new BadRequestException(problems.join("; "));
  }
}
