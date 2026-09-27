import { FormEvent, useEffect, useState } from "react";
import type { HrReferenceCatalogItemView, HrReferenceCatalogTypeSummary } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * HR Administration reference-catalog workspace (Core Employee
 * Configuration/HR-Admin v2, 2026-09-27 — "first 1 then 2": this is item
 * 1, the reference-data workspace kumail asked to build before deeper
 * field-level Configuration Center depth). Deliberately its own top-level
 * nav entry, not a tab inside Configuration Center or Admin Center — the
 * v2 spec's own Section 7/19 draw a hard line between Configuration
 * Center (fields/controls/rules), HR Administration (the reference/lookup
 * data those fields validate against and the lifecycle reason catalogs),
 * and day-to-day record maintenance, and kumail's own "most of the things
 * are maintenance... configuration means fields controls" correction
 * earlier this same day is exactly why that line matters here too.
 *
 * One generic screen drives all 20 registered catalog types
 * (`employment_type` + 19 `lifecycle_reason:*`) — the same "one engine,
 * not N bespoke screens" call `SubEntityPanel.tsx` made for the 8
 * sub-entity families, and the backend's own `HR_CATALOG_REGISTRY` already
 * made for the API side. The registry drives the type list; this page
 * never hardcodes a catalog type's name or count.
 */

type GroupedTypes = { groupLabel: string; types: HrReferenceCatalogTypeSummary[] }[];

function groupTypes(types: HrReferenceCatalogTypeSummary[]): GroupedTypes {
  const groups: GroupedTypes = [];
  for (const type of types) {
    let group = groups.find((g) => g.groupLabel === type.groupLabel);
    if (!group) {
      group = { groupLabel: type.groupLabel, types: [] };
      groups.push(group);
    }
    group.types.push(type);
  }
  return groups;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view HR Administration reference data.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function AddItemForm({ catalogType, onCancel, onAdded }: { catalogType: string; onCancel: () => void; onAdded: () => void }) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.createHrCatalogItem({ catalogType, code: code.trim(), label: label.trim(), description: description.trim() || undefined });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this item.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3 mb-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Code</label>
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. cross_training"
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Label</label>
          <input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Cross-training" className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Description (optional)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Adding…" : "Add"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function EditItemForm({ item, onCancel, onSaved }: { item: HrReferenceCatalogItemView; onCancel: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(item.label);
  const [description, setDescription] = useState(item.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.updateHrCatalogItem(item.id, { label: label.trim(), description: description.trim() || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this item.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Label</label>
          <input required value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Description (optional)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One catalog type's item list — add/edit/deactivate/reactivate/reorder.
 * Reorder follows `HiringCardDesignerPage.tsx`'s own up/down-arrow
 * convention (that page's own comment explains why: a same-row PATCH per
 * moved pair, not a drag-and-drop library this codebase doesn't otherwise
 * use anywhere).
 */
function CatalogItemsPanel({ type }: { type: HrReferenceCatalogTypeSummary }) {
  const [items, setItems] = useState<HrReferenceCatalogItemView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api
      .listHrCatalogItems(type.catalogType, showInactive)
      .then((rows) => setItems([...rows].sort((a, b) => a.sortOrder - b.sortOrder)))
      .catch((err) => setLoadError(describeError(err)));
  }

  useEffect(() => {
    setItems(null);
    setLoadError(null);
    setAdding(false);
    setEditingId(null);
    setRowError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type.catalogType, showInactive]);

  async function toggleActive(item: HrReferenceCatalogItemView) {
    setRowError(null);
    setBusyId(item.id);
    try {
      await api.updateHrCatalogItem(item.id, { isActive: !item.isActive });
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not update this item.");
    } finally {
      setBusyId(null);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    if (!items) return;
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    setRowError(null);
    setBusyId(next[index].id);
    try {
      const reordered = await api.reorderHrCatalogItems(type.catalogType, next.map((i) => i.id));
      const byId = new Map(reordered.map((r) => [r.id, r]));
      setItems((current) => (current ? current.map((i) => byId.get(i.id) ?? i).sort((a, b) => a.sortOrder - b.sortOrder) : current));
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not reorder these items.");
      load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="font-semibold text-base">{type.label}</h2>
          <p className="text-xs text-label-tertiary mt-0.5">{type.description}</p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-xs font-semibold text-accent hover:underline shrink-0">
            + Add item
          </button>
        )}
      </div>

      <label className="flex items-center gap-1.5 text-xs text-label-tertiary mt-3 mb-3">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded border-black/20" />
        Show deactivated items
      </label>

      {loadError && <div className="text-danger text-xs mb-2">{loadError}</div>}
      {rowError && <div className="text-danger text-xs mb-2">{rowError}</div>}

      {adding && <AddItemForm catalogType={type.catalogType} onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}

      {items === null && <div className="text-sm text-label-tertiary">Loading…</div>}
      {items && items.length === 0 && !adding && <div className="text-sm text-label-tertiary">No items yet.</div>}

      {items && items.length > 0 && (
        <div className="divide-y divide-black/5">
          {items.map((item, i) =>
            editingId === item.id ? (
              <div key={item.id} className="py-2.5">
                <EditItemForm item={item} onCancel={() => setEditingId(null)} onSaved={() => { setEditingId(null); load(); }} />
              </div>
            ) : (
              <div key={item.id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className={`text-sm flex items-center gap-2 ${item.isActive ? "" : "text-label-tertiary"}`}>
                    <span>{item.label}</span>
                    <span className="text-xs text-label-tertiary font-mono">{item.code}</span>
                    {!item.isActive && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">Deactivated</span>
                    )}
                  </div>
                  {item.description && <div className="text-xs text-label-tertiary mt-0.5">{item.description}</div>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => setEditingId(item.id)} className="text-xs font-medium text-accent hover:underline">
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive(item)}
                    disabled={busyId === item.id}
                    className="text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
                  >
                    {item.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                  <div className="flex flex-col">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={busyId !== null || i === 0}
                      className="text-xs text-label-tertiary hover:text-accent disabled:opacity-30"
                      aria-label={`Move ${item.label} up`}
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={busyId !== null || i === items.length - 1}
                      className="text-xs text-label-tertiary hover:text-accent disabled:opacity-30"
                      aria-label={`Move ${item.label} down`}
                    >
                      ▼
                    </button>
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}

export function HrAdministrationPage() {
  const [types, setTypes] = useState<HrReferenceCatalogTypeSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api
      .listHrCatalogTypes()
      .then((rows) => {
        setTypes(rows);
        setSelected((current) => current ?? rows[0]?.catalogType ?? null);
      })
      .catch((err) => setLoadError(describeError(err)));
  }, []);

  if (loadError) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{loadError}</div>;
  if (!types) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const groups = groupTypes(types);
  const selectedType = types.find((t) => t.catalogType === selected) ?? types[0] ?? null;

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">HR Administration</h1>
      <p className="text-label-tertiary text-sm mb-6">
        The reference and lookup data your Configuration Center fields and lifecycle actions validate against —
        employment types and the reason catalogs behind transfers, promotions, terminations and every other
        employee lifecycle event. This is reference data, not the field-level rules themselves — those live in
        Configuration Center.
      </p>

      <div className="flex gap-6 items-start">
        <nav className="w-64 shrink-0 space-y-5">
          {groups.map((group) => (
            <div key={group.groupLabel}>
              <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1.5 px-1">{group.groupLabel}</div>
              <div className="flex flex-col gap-0.5">
                {group.types.map((t) => (
                  <button
                    key={t.catalogType}
                    onClick={() => setSelected(t.catalogType)}
                    className={`flex items-center justify-between gap-2 text-left px-3 py-1.5 rounded-lg text-sm ${
                      selectedType?.catalogType === t.catalogType ? "bg-accent/10 text-accent font-medium" : "text-label-secondary hover:bg-black/5"
                    }`}
                  >
                    <span className="truncate">{t.label}</span>
                    <span className="text-xs text-label-tertiary shrink-0">{t.activeCount}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0">{selectedType && <CatalogItemsPanel key={selectedType.catalogType} type={selectedType} />}</div>
      </div>
    </div>
  );
}
