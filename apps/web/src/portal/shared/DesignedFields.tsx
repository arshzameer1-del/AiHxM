import { useId, type ReactNode } from "react";
import type { FormCustomFieldInfo, FormLayout } from "@aihxm/shared-types";
import { visibleKeys } from "./formLayoutRules";

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function CustomInput({ info, value, onChange, required, disabled }: { info: FormCustomFieldInfo; value: unknown; onChange: (v: unknown) => void; required: boolean; disabled: boolean }) {
  const common = { required, disabled };
  switch (info.fieldType) {
    case "boolean":
      return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="h-4 w-4 rounded border-black/20" />;
    case "number":
      return <input {...common} type="number" value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} className={inputClass} />;
    case "date":
      return <input {...common} type="date" value={value ? String(value) : ""} onChange={(e) => onChange(e.target.value || null)} className={inputClass} />;
    case "select":
      return (
        <select {...common} value={value ? String(value) : ""} onChange={(e) => onChange(e.target.value || null)} className={inputClass}>
          <option value="">Select…</option>
          {(info.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    default:
      return <input {...common} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
  }
}

/**
 * Draws a form's fields. With no layout it is the plain two-column grid the form always had. With a layout it draws the company's
 * sections in order, leaves out fields that are removed or whose show condition fails, locks read-only fields, and adds the company's
 * own custom fields. The form itself keeps drawing its built-in fields (`nodes`), so their wording and limits still come from Form settings.
 */
export function DesignedFields({
  layout, defaultOrder, nodes, customFields, values, onCustomChange, requiredKeys,
}: {
  layout: FormLayout | null;
  defaultOrder: string[];
  nodes: Record<string, ReactNode>;
  customFields: FormCustomFieldInfo[];
  /** Current value of every field (built-in by key, custom by key), used for show conditions. */
  values: Record<string, unknown>;
  onCustomChange: (key: string, value: unknown) => void;
  requiredKeys: Set<string>;
}) {
  const uid = useId();
  if (!layout) return <div className="grid grid-cols-2 gap-4">{defaultOrder.map((k) => <div key={k} className="contents">{nodes[k]}</div>)}</div>;
  const visible = visibleKeys(layout, values);
  const infoByKey = new Map(customFields.map((c) => [c.key, c]));
  return (
    <div className="space-y-6" data-testid="designed-form">
      {layout.sections.map((sec) => {
        const shown = sec.fields.filter((f) => visible.has(f.key) && (f.custom ? infoByKey.has(f.key) : Boolean(nodes[f.key])));
        if (shown.length === 0) return null;
        const headingId = `${uid}-${sec.key}`;
        return (
          <section key={sec.key} aria-labelledby={sec.title ? headingId : undefined} data-testid={`form-section-${sec.key}`}>
            {sec.title && <h3 id={headingId} className="text-sm font-semibold mb-1">{sec.title}</h3>}
            {sec.description && <p className="text-xs text-label-tertiary mb-3">{sec.description}</p>}
            <div className="grid grid-cols-2 gap-4">
              {shown.map((f) => {
                if (f.custom) {
                  const info = infoByKey.get(f.key)!;
                  const required = info.isRequired || requiredKeys.has(f.key);
                  return (
                    <div key={f.key}>
                      <label className="block">
                        <span className="block text-sm font-medium mb-1">{info.label}{required ? <span aria-hidden="true"> *</span> : null}</span>
                        <CustomInput info={info} value={values[f.key]} onChange={(v) => onCustomChange(f.key, v)} required={required} disabled={f.readOnly === true} />
                      </label>
                    </div>
                  );
                }
                return f.readOnly ? <fieldset key={f.key} disabled className="contents">{nodes[f.key]}</fieldset> : <div key={f.key} className="contents">{nodes[f.key]}</div>;
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
