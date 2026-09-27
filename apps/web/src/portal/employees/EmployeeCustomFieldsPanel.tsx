import { useEffect, useState } from "react";
import type { CustomFieldDefinition } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * Hiring Card Field Configuration (2026-09-27) — kumail's own "Wizard +
 * Employee profile" scope choice: a custom field added to a hiring card
 * (`HiringCardFieldConfigPage.tsx`) is mirrored onto `objectKey: "employee"`
 * (`CardFieldConfigService.addCustomField()`'s own doc comment) so it's
 * still visible and editable here, on the employee's own profile, long
 * after they're hired. Renders nothing at all when this tenant has never
 * defined an `employee`-scoped custom field — most companies won't have
 * any, and an empty "Custom fields" section would just be noise on every
 * single employee's page.
 */
const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function CustomFieldValueInput({
  definition,
  value,
  onChange,
}: {
  definition: CustomFieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (definition.fieldType) {
    case "boolean":
      return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-black/20" />;
    case "number":
      return (
        <input
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className={inputClass}
        />
      );
    case "date":
      return <input type="date" value={value ? String(value) : ""} onChange={(e) => onChange(e.target.value || null)} className={inputClass} />;
    case "select":
      return (
        <select value={value ? String(value) : ""} onChange={(e) => onChange(e.target.value || null)} className={inputClass}>
          <option value="">Select…</option>
          {(definition.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "text":
    default:
      return <input value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
  }
}

function formatValue(definition: CustomFieldDefinition, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (definition.fieldType === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function EmployeeCustomFieldsPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([api.listCustomFieldDefinitions("employee"), api.getCustomFieldValues("employee", employeeId)])
      .then(([defs, vals]) => {
        setDefinitions(defs);
        setValues(vals);
      })
      .catch(() => {
        // A custom-fields read failure shouldn't take down the rest of the
        // Employee Detail page — just show nothing here, same posture the
        // Hiring Wizard's own field-config fetch failures already take.
        setDefinitions([]);
      });
  }

  useEffect(() => {
    load();
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  if (definitions === null || definitions.length === 0) return null;

  function beginEdit() {
    setDraft({ ...values });
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      for (const def of definitions ?? []) {
        if (draft[def.fieldKey] !== values[def.fieldKey]) {
          await api.setCustomFieldValue({ objectKey: "employee", recordId: employeeId, fieldKey: def.fieldKey, value: draft[def.fieldKey] ?? null });
        }
      }
      setValues(draft);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save these custom fields.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Custom fields</h2>
        {canManage && !editing && (
          <button onClick={beginEdit} className="text-xs font-semibold text-accent hover:underline">
            Edit
          </button>
        )}
      </div>

      {error && <div className="text-danger text-xs mb-2">{error}</div>}

      {editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {definitions.map((def) => (
              <div key={def.fieldKey}>
                <label className="block text-xs font-medium mb-1">{def.label}</label>
                <CustomFieldValueInput
                  definition={def}
                  value={draft[def.fieldKey]}
                  onChange={(v) => setDraft((d) => ({ ...d, [def.fieldKey]: v }))}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-3 pt-2">
            <button onClick={handleSave} disabled={saving} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving} className="text-sm font-medium text-label-tertiary hover:text-label-primary">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {definitions.map((def) => (
            <div key={def.fieldKey}>
              <dt className="text-xs text-label-tertiary">{def.label}</dt>
              <dd>{formatValue(def, values[def.fieldKey])}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
