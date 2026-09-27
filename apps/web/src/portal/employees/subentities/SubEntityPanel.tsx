import { FormEvent, useEffect, useState } from "react";
import { ApiError } from "../../../api/client";

/**
 * Core Employee Enterprise Phases 6-9's frontend catch-up (2026-09-27) —
 * eight sub-entity families (Contacts, Addresses, Important Dates,
 * Payment Accounts, Cost Allocations, Family Members, Education,
 * Qualifications, Assets) all share the EXACT same backend shape: list by
 * employeeId, create, update (a narrower field set than create — some
 * fields like `contactType`/`addressType` are immutable after creation,
 * per each DTO's own `Update = Partial<Omit<Create, ...>>` definition),
 * and a one-way "close" action (`end` or, for Assets, `return`) instead
 * of a hard delete.
 *
 * Rather than hand-writing nine near-identical list+form components (this
 * codebase's usual per-feature-component style, per
 * `EmployeeGroupsPanel.tsx`/`OrgUnitDetailPage.tsx`), this ONE generic
 * panel is a deliberate departure from that convention — the 8 entities
 * are too structurally identical for nine copies to be anything but
 * copy-paste drift risk (a field-list typo in the 7th one would be easy
 * to miss). `subEntityConfigs.tsx` supplies each entity's own field
 * list, summary renderer and API functions; this file supplies the one
 * shared list/create/edit/close behavior, following the same "list +
 * inline reveal-a-form + edit-in-place + `window.confirm` close" pattern
 * `EmployeeGroupsPanel.tsx` already established elsewhere in this app.
 */

export type SubEntityFieldType = "text" | "select" | "date" | "number" | "checkbox" | "textarea";

export type SubEntityFieldSpec = {
  key: string;
  label: string;
  type: SubEntityFieldType;
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  /** Checkbox fields only — the value a brand-new row starts with. */
  defaultChecked?: boolean;
};

export type SubEntityRow = {
  id: string;
  status: string;
};

export type SubEntityPanelConfig<TView extends SubEntityRow> = {
  title: string;
  addLabel: string;
  emptyLabel: string;
  createFields: SubEntityFieldSpec[];
  updateFields: SubEntityFieldSpec[];
  renderSummary: (item: TView) => { primary: string; secondary?: string };
  /** "active"/"assigned" — the status value that still shows the close action. */
  openStatus: string;
  closedStatusLabel: string;
  closeActionLabel: string;
  closeConfirm?: (item: TView) => string;
  list: (employeeId: string) => Promise<TView[]>;
  create: (employeeId: string, values: Record<string, unknown>) => Promise<TView>;
  update: (id: string, values: Record<string, unknown>) => Promise<TView>;
  close: (id: string) => Promise<TView>;
};

function toFormValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function buildInitialValues(fields: SubEntityFieldSpec[], source?: SubEntityRow): Record<string, unknown> {
  const raw = source as unknown as Record<string, unknown> | undefined;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "checkbox") {
      values[field.key] = raw ? Boolean(raw[field.key]) : Boolean(field.defaultChecked);
    } else {
      values[field.key] = raw ? toFormValue(raw[field.key]) : "";
    }
  }
  return values;
}

/** Empty optional strings become `undefined` (omitted), matching every other create/edit form in this app (`field || undefined`); required fields are sent as-is. */
function cleanValues(fields: SubEntityFieldSpec[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.type === "checkbox") {
      out[field.key] = Boolean(raw);
    } else if (field.type === "number") {
      out[field.key] = raw === "" || raw === undefined ? undefined : Number(raw);
    } else if (typeof raw === "string") {
      out[field.key] = raw.trim() === "" ? (field.required ? "" : undefined) : raw;
    } else {
      out[field.key] = raw;
    }
  }
  return out;
}

/** Exported for reuse by the Hiring Wizard's own repeatable-list card editors (`hiring/cardForms.tsx`) — same field-spec-driven input, one shared implementation. */
export function FieldInput({
  field,
  values,
  onChange,
}: {
  field: SubEntityFieldSpec;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const inputClass =
    "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(values[field.key])}
          onChange={(e) => onChange(field.key, e.target.checked)}
          className="rounded border-black/20"
        />
        {field.label}
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        <label className="block text-xs font-medium mb-1">{field.label}</label>
        <select
          required={field.required}
          value={toFormValue(values[field.key])}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={`${inputClass} capitalize`}
        >
          <option value="">{field.required ? "Select…" : "—"}</option>
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div>
        <label className="block text-xs font-medium mb-1">{field.label}</label>
        <textarea
          required={field.required}
          value={toFormValue(values[field.key])}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
          rows={2}
          className={inputClass}
        />
      </div>
    );
  }

  return (
    <div>
      <label className="block text-xs font-medium mb-1">{field.label}</label>
      <input
        type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
        required={field.required}
        value={toFormValue(values[field.key])}
        onChange={(e) => onChange(field.key, e.target.value)}
        placeholder={field.placeholder}
        className={inputClass}
      />
    </div>
  );
}

function SubEntityForm<TView extends SubEntityRow>({
  fields,
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  fields: SubEntityFieldSpec[];
  initial?: TView;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => buildInitialValues(fields, initial));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(cleanValues(fields, values));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {fields.map((field) => (
          <div key={field.key} className={field.type === "textarea" ? "col-span-2" : undefined}>
            <FieldInput field={field} values={values} onChange={(key, v) => setValues((prev) => ({ ...prev, [key]: v }))} />
          </div>
        ))}
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Saving…" : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SubEntityPanel<TView extends SubEntityRow>({
  employeeId,
  canManage,
  config,
}: {
  employeeId: string;
  canManage: boolean;
  config: SubEntityPanelConfig<TView>;
}) {
  const [items, setItems] = useState<TView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  function load() {
    config
      .list(employeeId)
      .then(setItems)
      .catch(() => setLoadError(`Could not load ${config.title.toLowerCase()}.`));
  }

  useEffect(() => {
    setItems(null);
    setLoadError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  async function handleClose(item: TView) {
    if (config.closeConfirm && !window.confirm(config.closeConfirm(item))) return;
    setRowError(null);
    try {
      await config.close(item.id);
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not do that.");
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">{config.title}</h2>
        {canManage && !adding && (
          <button onClick={() => setAdding(true)} className="text-xs font-semibold text-accent hover:underline">
            {config.addLabel}
          </button>
        )}
      </div>

      {loadError && <div className="text-danger text-xs mb-2">{loadError}</div>}
      {rowError && <div className="text-danger text-xs mb-2">{rowError}</div>}

      {adding && (
        <div className="mb-3">
          <SubEntityForm
            fields={config.createFields}
            submitLabel="Add"
            onCancel={() => setAdding(false)}
            onSubmit={async (values) => {
              await config.create(employeeId, values);
              setAdding(false);
              load();
            }}
          />
        </div>
      )}

      {items === null && <div className="text-sm text-label-tertiary">Loading…</div>}
      {items && items.length === 0 && !adding && <div className="text-sm text-label-tertiary">{config.emptyLabel}</div>}

      {items && items.length > 0 && (
        <div className="divide-y divide-black/5">
          {items.map((item) => {
            const summary = config.renderSummary(item);
            const isOpen = item.status === config.openStatus;
            return (
              <div key={item.id} className="py-2.5">
                {editingId === item.id ? (
                  <SubEntityForm
                    fields={config.updateFields}
                    initial={item}
                    submitLabel="Save"
                    onCancel={() => setEditingId(null)}
                    onSubmit={async (values) => {
                      await config.update(item.id, values);
                      setEditingId(null);
                      load();
                    }}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm flex items-center gap-2">
                        <span>{summary.primary}</span>
                        {!isOpen && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">
                            {config.closedStatusLabel}
                          </span>
                        )}
                      </div>
                      {summary.secondary && <div className="text-xs text-label-tertiary mt-0.5">{summary.secondary}</div>}
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-3 shrink-0">
                        {isOpen && (
                          <button onClick={() => setEditingId(item.id)} className="text-xs font-medium text-accent hover:underline">
                            Edit
                          </button>
                        )}
                        {isOpen && (
                          <button
                            onClick={() => handleClose(item)}
                            className="text-xs font-medium text-label-tertiary hover:text-danger"
                          >
                            {config.closeActionLabel}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
