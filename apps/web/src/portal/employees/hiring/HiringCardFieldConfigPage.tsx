import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CardFieldDefinitionView, CardFieldsConfigView, CustomFieldDefinition, CustomFieldType } from "@aihxm/shared-types";
import { api, ApiError } from "../../../api/client";

/**
 * Hiring Card Field Configuration (2026-09-27) — kumail's own request,
 * looking at `HiringCardDesignerPage.tsx`'s card-level toggles: "from
 * configuration like we have tile configuration there should be
 * configuration available for their fields under their respective tile —
 * field enable/disable, add custom field option — custom field once added
 * will be visible in respective tile." This is that per-card screen, one
 * level deeper than the card designer's own enable/required/reorder —
 * reached from a "Configure fields" link on each of that page's rows.
 *
 * Two sections, matching `CardFieldConfigService.listCardFields()`'s own
 * `{ builtIn, custom }` shape: this card's BUILT-IN fields (enable/
 * disable + required, the exact same up/down-free toggle pattern
 * `HiringCardDesignerPage.tsx` already uses for whole cards) and its
 * CUSTOM fields (add/deactivate). A custom field added here shows up in
 * the live Hiring Wizard's own rendering of this card immediately — no
 * separate publish step — and is also mirrored onto the Employee Detail
 * page per kumail's own "Wizard + Employee profile" scope choice.
 */

const CUSTOM_FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / No" },
  { value: "date", label: "Date" },
  { value: "select", label: "Choice list" },
];

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This card, or the Employee module, isn't available.";
    if (err.status === 403) return "You don't have permission to configure hiring card fields.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

/**
 * "then 2" Phase 3 (2026-10-02, gap-table item #3) — the field-level
 * depth beyond enable/disable/required: a default value, validation
 * rules, and a conditional-display condition, each enforced server-side
 * by `CardFieldConfigService.applyFieldConfigRules()` (see that method's
 * own doc comment). Edited as a small structured form, not raw JSON —
 * unlike a Business Policy's `rules` (which genuinely differ in shape
 * per policy type), every field here shares the exact same shape, so a
 * dedicated form reads better than a JSON textarea would.
 */
function FieldRulesForm({ field, onCancel, onSaved }: { field: CardFieldDefinitionView; onCancel: () => void; onSaved: () => void }) {
  const { cardKey } = useParams<{ cardKey: string }>();
  const [defaultValue, setDefaultValue] = useState(field.defaultValue ?? "");
  const [pattern, setPattern] = useState(field.validationRules?.pattern ?? "");
  const [minLength, setMinLength] = useState(field.validationRules?.minLength?.toString() ?? "");
  const [maxLength, setMaxLength] = useState(field.validationRules?.maxLength?.toString() ?? "");
  const [min, setMin] = useState(field.validationRules?.min?.toString() ?? "");
  const [max, setMax] = useState(field.validationRules?.max?.toString() ?? "");
  const [conditionField, setConditionField] = useState(field.conditionalOn?.fieldKey ?? "");
  const [conditionOp, setConditionOp] = useState<"equals" | "notEquals">(field.conditionalOn?.operator ?? "equals");
  const [conditionValue, setConditionValue] = useState(field.conditionalOn?.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!cardKey) return;
    setError(null);
    const rules: Record<string, number | string> = {};
    if (pattern.trim()) rules.pattern = pattern.trim();
    if (minLength.trim()) rules.minLength = Number(minLength);
    if (maxLength.trim()) rules.maxLength = Number(maxLength);
    if (min.trim()) rules.min = Number(min);
    if (max.trim()) rules.max = Number(max);
    setSaving(true);
    try {
      await api.updateCardFieldConfig(cardKey, field.fieldKey, {
        defaultValue: defaultValue.trim() || null,
        validationRules: Object.keys(rules).length > 0 ? (rules as never) : null,
        conditionalOn: conditionField.trim() ? { fieldKey: conditionField.trim(), operator: conditionOp, value: conditionValue } : null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save these rules.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3 mt-2">
      <div>
        <label className="block text-xs font-medium mb-1">Default value</label>
        <input
          value={defaultValue}
          onChange={(e) => setDefaultValue(e.target.value)}
          placeholder="Applied when this field is left blank"
          className={inputClass}
        />
      </div>
      <div>
        <div className="text-xs font-medium mb-1">Validation</div>
        <div className="grid grid-cols-2 gap-2">
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="Pattern (regex, optional)" className={inputClass} />
          <div className="grid grid-cols-2 gap-2">
            <input value={minLength} onChange={(e) => setMinLength(e.target.value)} placeholder="Min length" className={inputClass} />
            <input value={maxLength} onChange={(e) => setMaxLength(e.target.value)} placeholder="Max length" className={inputClass} />
          </div>
          <input value={min} onChange={(e) => setMin(e.target.value)} placeholder="Min value" className={inputClass} />
          <input value={max} onChange={(e) => setMax(e.target.value)} placeholder="Max value" className={inputClass} />
        </div>
      </div>
      <div>
        <div className="text-xs font-medium mb-1">Only required when another field on this card matches</div>
        <div className="grid grid-cols-3 gap-2">
          <input value={conditionField} onChange={(e) => setConditionField(e.target.value)} placeholder="Field key" className={inputClass} />
          <select value={conditionOp} onChange={(e) => setConditionOp(e.target.value as "equals" | "notEquals")} className={inputClass}>
            <option value="equals">equals</option>
            <option value="notEquals">does not equal</option>
          </select>
          <input value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} placeholder="Value" className={inputClass} />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Saving…" : "Save rules"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddCustomFieldForm({ cardKey, onCancel, onAdded }: { cardKey: string; onCancel: () => void; onAdded: () => void }) {
  const [fieldKey, setFieldKey] = useState("");
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState<CustomFieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const options = optionsText
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    if (fieldType === "select" && options.length === 0) {
      setError("A choice list needs at least one option (comma-separated).");
      return;
    }
    setSaving(true);
    try {
      await api.addCardCustomField(cardKey, {
        fieldKey: fieldKey.trim(),
        label: label.trim(),
        fieldType,
        options: fieldType === "select" ? options : undefined,
        isRequired,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this custom field.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3 mb-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Field key</label>
          <input
            required
            value={fieldKey}
            onChange={(e) => setFieldKey(e.target.value)}
            placeholder="e.g. bloodGroup"
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Label</label>
          <input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Blood group" className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Type</label>
          <select value={fieldType} onChange={(e) => setFieldType(e.target.value as CustomFieldType)} className={inputClass}>
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {fieldType === "select" && (
          <div>
            <label className="block text-xs font-medium mb-1">Options (comma-separated)</label>
            <input
              required
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder="e.g. A+, A-, B+, B-, O+, O-"
              className={inputClass}
            />
          </div>
        )}
        <label className="flex items-center gap-1.5 text-xs col-span-2">
          <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} className="rounded border-black/20" />
          Required in the Hiring Wizard
        </label>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Adding…" : "Add custom field"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function HiringCardFieldConfigPage() {
  const { cardKey } = useParams<{ cardKey: string }>();
  const [view, setView] = useState<CardFieldsConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingRulesKey, setEditingRulesKey] = useState<string | null>(null);

  function load() {
    if (!cardKey) return;
    api
      .listCardFields(cardKey)
      .then((v) => setView(v))
      .catch((err) => setLoadError(describeError(err)));
  }

  useEffect(() => {
    setView(null);
    setLoadError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);

  async function toggleBuiltIn(field: CardFieldDefinitionView, patch: { isEnabled?: boolean; isRequired?: boolean }) {
    if (!cardKey) return;
    setRowError(null);
    setBusyKey(field.fieldKey);
    try {
      await api.updateCardFieldConfig(cardKey, field.fieldKey, patch);
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not update this field.");
    } finally {
      setBusyKey(null);
    }
  }

  async function deactivateCustom(field: CustomFieldDefinition) {
    if (!cardKey) return;
    if (!window.confirm(`Remove "${field.label}" from this card? It will stop appearing in the Hiring Wizard, but values already entered for hired employees are kept.`)) return;
    setRowError(null);
    setBusyKey(field.fieldKey);
    try {
      await api.deactivateCardCustomField(cardKey, field.fieldKey);
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not remove this field.");
    } finally {
      setBusyKey(null);
    }
  }

  if (loadError) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{loadError}</div>;
  if (!view) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const builtIn = [...view.builtIn].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="max-w-2xl">
      <Link to="/app/configuration-center/hiring" className="text-xs font-medium text-label-tertiary hover:text-accent">
        ← Back to Hiring Wizard Cards
      </Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2 mb-1">Configure fields</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Enable or disable this card's built-in fields, mark any of them required, and add custom fields of your own.
        A custom field added here shows up in the Hiring Wizard immediately, and also on the employee's own profile
        once they're hired.
      </p>

      {rowError && <div className="mb-4 rounded-lg bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{rowError}</div>}

      <section className="bg-card rounded-card p-5 shadow-sm mb-6">
        <h2 className="font-semibold text-base mb-1">Built-in fields</h2>
        {builtIn.length === 0 && <p className="text-sm text-label-tertiary">This card has no configurable built-in fields.</p>}
        {builtIn.length > 0 && (
          <div className="divide-y divide-black/5">
            {builtIn.map((field) => (
              <div key={field.fieldKey} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`text-sm ${field.isEnabled ? "" : "text-label-tertiary"}`}>{field.label}</div>
                    {(field.defaultValue || field.validationRules || field.conditionalOn) && (
                      <div className="text-xs text-label-tertiary mt-0.5 flex gap-2 flex-wrap">
                        {field.defaultValue && <span>Default: {field.defaultValue}</span>}
                        {field.validationRules && <span>Validated</span>}
                        {field.conditionalOn && <span>Conditional on {field.conditionalOn.fieldKey}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <button
                      onClick={() => setEditingRulesKey(editingRulesKey === field.fieldKey ? null : field.fieldKey)}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      {editingRulesKey === field.fieldKey ? "Close" : "Rules"}
                    </button>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={field.isRequired}
                        disabled={busyKey === field.fieldKey || !field.isEnabled}
                        onChange={() => toggleBuiltIn(field, { isRequired: !field.isRequired })}
                        className="rounded border-black/20"
                      />
                      Required
                    </label>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={field.isEnabled}
                        disabled={busyKey === field.fieldKey}
                        onChange={() => toggleBuiltIn(field, { isEnabled: !field.isEnabled })}
                        className="rounded border-black/20"
                      />
                      Enabled
                    </label>
                  </div>
                </div>
                {editingRulesKey === field.fieldKey && (
                  <FieldRulesForm field={field} onCancel={() => setEditingRulesKey(null)} onSaved={() => { setEditingRulesKey(null); load(); }} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-semibold text-base">Custom fields</h2>
          {!adding && (
            <button onClick={() => setAdding(true)} className="text-xs font-semibold text-accent hover:underline shrink-0">
              + Add custom field
            </button>
          )}
        </div>
        <p className="text-xs text-label-tertiary mt-0.5 mb-3">
          Fields specific to your company that aren't part of the standard hiring form.
        </p>

        {adding && cardKey && (
          <AddCustomFieldForm cardKey={cardKey} onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />
        )}

        {view.custom.length === 0 && !adding && <div className="text-sm text-label-tertiary">No custom fields added yet.</div>}

        {view.custom.length > 0 && (
          <div className="divide-y divide-black/5">
            {view.custom.map((field) => (
              <div key={field.fieldKey} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm flex items-center gap-2">
                    <span>{field.label}</span>
                    <span className="text-xs text-label-tertiary font-mono">{field.fieldType}</span>
                    {field.isRequired && <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">Required</span>}
                  </div>
                </div>
                <button
                  onClick={() => deactivateCustom(field)}
                  disabled={busyKey === field.fieldKey}
                  className="text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50 shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
