import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { FormCustomFieldInfo, FormDesignerView, FormLayout, FormLayoutHistoryView, FormLayoutView } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { formByKey, type CatalogForm } from "./form-catalog";
import { FormSettingsService } from "./form-settings.service";
import { conditionHolds, describeCondition, validateLayout, visibleKeys } from "./form-layout.rules";

const MANAGE = "employee.manage.all";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultLayout = (form: CatalogForm): FormLayout => ({ sections: [{ key: "main", title: "", fields: form.fields.map((f) => ({ key: f.key })) }] });

function suggested(form: CatalogForm): FormLayout | null {
  if (!form.suggestedSections) return null;
  return {
    sections: form.suggestedSections.map((s, i) => ({
      key: `section_${i + 1}`,
      title: s.title,
      fields: s.fields.filter((k) => form.fields.some((f) => f.key === k)).map((key) => ({ key })),
    })),
  };
}

/**
 * Form designer: a company arranges a form into sections, chooses which fields sit where, adds its own custom fields, and sets when a
 * field shows, becomes required or is read-only. The arrangement is edited as a draft and only a publish makes it live. A form with
 * no published layout is left exactly as it was. The server holds the same rules the screen shows (see `enforce`).
 */
@Injectable()
export class FormLayoutService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly settings: FormSettingsService
  ) {}

  private async requireManage(claims: RequestClaims) {
    if (!claims.company_id) throw new ForbiddenException("A company login is needed");
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to design forms");
  }

  private form(formKey: string): CatalogForm {
    const f = formByKey(formKey);
    if (!f) throw new NotFoundException("Unknown form");
    return f;
  }

  private requireDesignable(form: CatalogForm) {
    if (!form.designable) throw new BadRequestException(`The layout of "${form.title}" cannot be designed yet; its fields can still be renamed, hidden or made required.`);
  }

  private async customFields(claims: RequestClaims, form: CatalogForm): Promise<FormCustomFieldInfo[]> {
    if (!form.customObjectKey) return [];
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        "SELECT field_key, label, field_type, options, is_required FROM custom_field_definitions WHERE company_id = $1 AND object_key = $2 AND is_active = true ORDER BY created_at",
        [claims.company_id, form.customObjectKey]
      );
      return r.rows.map((x) => ({ key: x.field_key, label: x.label, fieldType: x.field_type, ...(x.options ? { options: x.options } : {}), isRequired: x.is_required }));
    });
  }

  private async row(claims: RequestClaims, formKey: string) {
    return this.db.withClaims(claims, async (c) => (await c.query("SELECT * FROM form_layouts WHERE company_id = $1 AND form_key = $2", [claims.company_id, formKey])).rows[0]);
  }

  /** What a screen needs to draw the form. Any signed-in company user may read it. */
  async view(claims: RequestClaims, formKey: string): Promise<FormLayoutView> {
    const form = this.form(formKey);
    if (!claims.company_id) throw new ForbiddenException("A company login is needed");
    const row = await this.row(claims, formKey);
    return { formKey, layout: (row?.published as FormLayout | null) ?? null, version: row?.version ?? 0, customFields: await this.customFields(claims, form) };
  }

  async designer(claims: RequestClaims, formKey: string): Promise<FormDesignerView> {
    await this.requireManage(claims);
    const form = this.form(formKey);
    const row = await this.row(claims, formKey);
    const def = defaultLayout(form);
    return {
      formKey,
      title: form.title,
      layout: ((row?.draft ?? row?.published) as FormLayout | undefined) ?? suggested(form) ?? def,
      hasDraft: Boolean(row?.draft),
      livePublished: Boolean(row?.published),
      version: row?.version ?? 0,
      publishedAt: row?.published_at ? row.published_at.toISOString() : null,
      defaultLayout: def,
      suggestedLayout: suggested(form),
      settings: await this.settings.form(claims, formKey),
      customFields: await this.customFields(claims, form),
      customObjectKey: form.customObjectKey ?? null,
      designable: form.designable === true,
    };
  }

  async saveDraft(claims: RequestClaims, formKey: string, layout: unknown): Promise<FormDesignerView> {
    await this.requireManage(claims);
    const form = this.form(formKey);
    this.requireDesignable(form);
    const customKeys = new Set((await this.customFields(claims, form)).map((c) => c.key));
    const clean = validateLayout(layout, form, customKeys);
    const actor = UUID_RE.test(claims.sub ?? "") ? claims.sub : null;
    await this.db.withClaims(claims, async (c) => {
      await c.query(
        `INSERT INTO form_layouts (company_id, form_key, draft, updated_by) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (company_id, form_key) DO UPDATE SET draft = $3::jsonb, updated_at = now(), updated_by = $4`,
        [claims.company_id, formKey, JSON.stringify(clean), actor]
      );
    });
    return this.designer(claims, formKey);
  }

  async discardDraft(claims: RequestClaims, formKey: string): Promise<FormDesignerView> {
    await this.requireManage(claims);
    this.form(formKey);
    await this.db.withClaims(claims, (c) => c.query("UPDATE form_layouts SET draft = NULL, updated_at = now() WHERE company_id = $1 AND form_key = $2", [claims.company_id, formKey]));
    return this.designer(claims, formKey);
  }

  /** Makes the draft live. Re-checked against today's custom fields, so a field removed since the draft was saved cannot go live. */
  async publish(claims: RequestClaims, formKey: string): Promise<FormDesignerView> {
    await this.requireManage(claims);
    const form = this.form(formKey);
    const row = await this.row(claims, formKey);
    if (!row?.draft) throw new BadRequestException("There is no draft to publish. Save your changes first.");
    const customKeys = new Set((await this.customFields(claims, form)).map((c) => c.key));
    const clean = validateLayout(row.draft, form, customKeys);
    const actor = UUID_RE.test(claims.sub ?? "") ? claims.sub : null;
    await this.db.withClaims(claims, async (c) => {
      const next = (row.version ?? 0) + 1;
      await c.query(
        "UPDATE form_layouts SET published = $3::jsonb, draft = NULL, version = $4, published_at = now(), published_by = $5, updated_at = now(), updated_by = $5 WHERE company_id = $1 AND form_key = $2",
        [claims.company_id, formKey, JSON.stringify(clean), next, actor]
      );
      await c.query("INSERT INTO form_layout_history (company_id, form_key, action, version, layout, changed_by) VALUES ($1,$2,'publish',$3,$4::jsonb,$5)", [claims.company_id, formKey, next, JSON.stringify(clean), actor]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "form_layout.publish", target: formKey, metadata: { version: next, sections: clean.sections.length } });
    });
    return this.designer(claims, formKey);
  }

  /** Back to the form's own default. The live layout and any draft are dropped; the reset is kept in history. */
  async reset(claims: RequestClaims, formKey: string): Promise<FormDesignerView> {
    await this.requireManage(claims);
    this.form(formKey);
    const row = await this.row(claims, formKey);
    const actor = UUID_RE.test(claims.sub ?? "") ? claims.sub : null;
    if (row) {
      await this.db.withClaims(claims, async (c) => {
        const next = (row.version ?? 0) + 1;
        await c.query("UPDATE form_layouts SET published = NULL, draft = NULL, version = $3, updated_at = now(), updated_by = $4 WHERE company_id = $1 AND form_key = $2", [claims.company_id, formKey, next, actor]);
        await c.query("INSERT INTO form_layout_history (company_id, form_key, action, version, layout, changed_by) VALUES ($1,$2,'reset',$3,NULL,$4)", [claims.company_id, formKey, next, actor]);
        await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "form_layout.reset", target: formKey, metadata: { version: next } });
      });
    }
    return this.designer(claims, formKey);
  }

  async history(claims: RequestClaims, formKey: string): Promise<FormLayoutHistoryView[]> {
    await this.requireManage(claims);
    this.form(formKey);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query("SELECT id, form_key, action, version, changed_by, changed_at FROM form_layout_history WHERE company_id = $1 AND form_key = $2 ORDER BY changed_at DESC, id LIMIT 50", [claims.company_id, formKey]);
      return r.rows.map((x) => ({ id: x.id, formKey: x.form_key, action: x.action, version: x.version, changedAt: x.changed_at.toISOString(), changedBy: x.changed_by }));
    });
  }

  /** Loads an earlier published layout back into the draft (it is not live until published again). */
  async restoreToDraft(claims: RequestClaims, formKey: string, historyId: string): Promise<FormDesignerView> {
    await this.requireManage(claims);
    this.form(formKey);
    const h = await this.db.withClaims(claims, async (c) => (await c.query("SELECT layout FROM form_layout_history WHERE id = $1 AND company_id = $2 AND form_key = $3", [historyId, claims.company_id, formKey])).rows[0]);
    if (!h) throw new NotFoundException("That version was not found");
    if (!h.layout) throw new BadRequestException("That entry was a reset to default; there is no layout to load");
    return this.saveDraft(claims, formKey, h.layout);
  }

  /**
   * The server side of the layout, for a form that sends a record. `current` is the saved record (field key -> value) or empty for a new one.
   * Refuses: changing a read-only field; leaving empty a field that the layout makes required while it shows. A field whose show condition
   * fails is treated as not on the form (its required rule does not apply). Nothing happens for a form with no published layout.
   */
  async enforce(claims: RequestClaims, formKey: string, payload: Record<string, unknown>, current: Record<string, unknown> = {}, opts: { clear?: string[] } = {}): Promise<void> {
    if (!claims.company_id) return;
    const form = formByKey(formKey);
    if (!form) return;
    const row = await this.row(claims, formKey);
    const layout = row?.published as FormLayout | undefined;
    if (!layout) return;
    const clear = new Set(opts.clear ?? []);
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(payload)) if (v !== undefined) merged[k] = v;
    for (const k of clear) merged[k] = null;
    const customMerged = { ...(payload.customFields as Record<string, unknown> | undefined) };
    const customLabels = new Map((await this.customFields(claims, form)).map((c) => [c.key, c.label]));
    const labelOf = (k: string) => form.fields.find((f) => f.key === k)?.label ?? customLabels.get(k) ?? k;
    const visible = visibleKeys(layout, { ...merged, ...customMerged });
    const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    for (const sec of layout.sections) {
      for (const f of sec.fields) {
        const name = labelOf(f.key);
        const touched = f.custom ? customMerged[f.key] !== undefined : payload[f.key] !== undefined || clear.has(f.key);
        if (f.readOnly && touched) {
          const before = f.custom ? undefined : current[f.key];
          const after = f.custom ? customMerged[f.key] : clear.has(f.key) ? null : payload[f.key];
          if (String(before ?? "") !== String(after ?? "")) throw new BadRequestException({ message: `${name} is read-only on this form`, field: f.key });
        }
        if (f.requiredWhen && visible.has(f.key) && conditionHolds(f.requiredWhen, { ...merged, ...customMerged })) {
          const value = f.custom ? (customMerged[f.key] !== undefined ? customMerged[f.key] : (current.customFields as Record<string, unknown> | undefined)?.[f.key]) : merged[f.key];
          if (empty(value)) throw new BadRequestException({ message: `${name} is required when ${describeCondition(f.requiredWhen, labelOf)}`, field: f.key });
        }
      }
    }
  }

  async countPublished(claims: RequestClaims): Promise<number> {
    if (!claims.company_id) return 0;
    return this.db.withClaims(claims, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM form_layouts WHERE company_id = $1 AND published IS NOT NULL", [claims.company_id])).rows[0].n));
  }
}
