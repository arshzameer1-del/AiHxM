import { FormEvent, useEffect, useState } from "react";
import type {
  ConfigurationRuleMappingView,
  HrBusinessPolicyTypeSummary,
  HrBusinessPolicyView,
  LocationView,
  OrgUnitView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * HR Administration — Business Policies tab ("then 2" Phase 2,
 * 2026-10-02, gap-table item #8). Sits alongside the reference-catalog
 * tab in the same `HrAdministrationPage.tsx` workspace — see that
 * page's own top-level tab switch. One generic screen drives every
 * registered policy type (`BUSINESS_POLICY_REGISTRY`, the backend's own
 * registry), the same "the registry drives the list, this page never
 * hardcodes a policy type's name" discipline `HrAdministrationPage.tsx`
 * already established for reference catalogs.
 *
 * A policy's `rules` are a free-form JSON object whose SHAPE differs by
 * policy type (see each registry entry's own `rulesShape` string, shown
 * here as a hint) — this page edits them as raw, validated JSON rather
 * than a bespoke form per type, the same "one engine, not N bespoke
 * forms" tradeoff the backend's own single `rules jsonb` column makes.
 */

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view HR Administration business policies.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const textareaClass = `${inputClass} font-mono text-xs min-h-[90px]`;

function formatRules(rules: Record<string, unknown>): string {
  return JSON.stringify(rules, null, 2);
}

function parseRules(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Rules must be a JSON object, e.g. {\"durationDays\": 90}");
  }
  return parsed as Record<string, unknown>;
}

function PolicyForm({
  type,
  initial,
  onCancel,
  onSaved,
}: {
  type: HrBusinessPolicyTypeSummary;
  initial?: HrBusinessPolicyView;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "default");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [rulesText, setRulesText] = useState(formatRules(initial?.rules ?? {}));
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? !initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let rules: Record<string, unknown>;
    try {
      rules = parseRules(rulesText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rules must be valid JSON.");
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await api.updateHrBusinessPolicy(initial.id, { name: name.trim(), description: description.trim() || undefined, rules, isDefault });
      } else {
        await api.createHrBusinessPolicy({
          policyType: type.policyType,
          code: code.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          rules,
          isDefault,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3 mb-3">
      <div className="grid grid-cols-2 gap-3">
        {!initial && (
          <div>
            <label className="block text-xs font-medium mb-1">Code</label>
            <input required value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. senior_hire" className={inputClass} />
          </div>
        )}
        <div className={initial ? "col-span-2" : ""}>
          <label className="block text-xs font-medium mb-1">Name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Senior Hire Probation" className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Description (optional)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">
            Rules (JSON) <span className="text-label-tertiary font-normal">— {type.rulesShape}</span>
          </label>
          <textarea value={rulesText} onChange={(e) => setRulesText(e.target.value)} className={textareaClass} spellCheck={false} />
        </div>
        <label className="col-span-2 flex items-center gap-1.5 text-xs text-label-secondary">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="rounded border-black/20" />
          Make this the default {type.label.toLowerCase()} (the one actually applied)
        </label>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Saving…" : initial ? "Save" : "Add policy"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

type ScopeType = "org_unit" | "location" | "employee";
const SCOPE_TYPE_LABELS: Record<ScopeType, string> = { org_unit: "Org unit", location: "Location", employee: "Employee" };

function describeOverrideError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view HR Administration configuration overrides.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

/**
 * "then 2" Phases 4+5 (2026-10-02, gap-table items #11+#12) — the
 * Configuration Hierarchy & Resolution / Mapping Engine's own management
 * UI for ONE policy type at a time, nested inside that type's own
 * `PolicyTypePanel` below (an override is meaningless without the policy
 * type it overrides). Most-specific-wins at RUNTIME is
 * employee > location > org_unit (see `configuration-rule-mapping.service.ts`'s
 * own `resolveOverride()`), but this list view sorts by scope type alone
 * for a stable, predictable grouping — it is not trying to visualize the
 * runtime resolution order for a dozen different hypothetical employees
 * at once.
 */
function OverrideForm({
  policyType,
  orgUnits,
  locations,
  initial,
  onCancel,
  onSaved,
}: {
  policyType: string;
  orgUnits: OrgUnitView[];
  locations: LocationView[];
  initial?: ConfigurationRuleMappingView;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [scopeType, setScopeType] = useState<ScopeType>(initial?.scopeType ?? "org_unit");
  const [scopeValue, setScopeValue] = useState(initial?.scopeValue ?? "");
  const [ruleValueText, setRuleValueText] = useState(formatRules(initial?.ruleValue ?? {}));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let ruleValue: Record<string, unknown>;
    try {
      ruleValue = parseRules(ruleValueText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rule value must be valid JSON.");
      return;
    }
    if (!initial && !scopeValue.trim()) {
      setError(scopeType === "employee" ? "Employee id is required." : `Select a ${SCOPE_TYPE_LABELS[scopeType].toLowerCase()}.`);
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await api.updateConfigurationRuleMapping(initial.id, { ruleValue });
      } else {
        await api.createConfigurationRuleMapping({
          configDomain: "hr_business_policy",
          configKey: policyType,
          scopeType,
          scopeValue: scopeValue.trim(),
          ruleValue,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this override.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3 mb-3">
      <div className="grid grid-cols-2 gap-3">
        {!initial && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1">Scope type</label>
              <select
                value={scopeType}
                onChange={(e) => {
                  setScopeType(e.target.value as ScopeType);
                  setScopeValue("");
                }}
                className={inputClass}
              >
                <option value="org_unit">Org unit</option>
                <option value="location">Location</option>
                <option value="employee">Employee</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{SCOPE_TYPE_LABELS[scopeType]}</label>
              {scopeType === "org_unit" && (
                <select required value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className={inputClass}>
                  <option value="" disabled>
                    Select an org unit…
                  </option>
                  {orgUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              )}
              {scopeType === "location" && (
                <select required value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className={inputClass}>
                  <option value="" disabled>
                    Select a location…
                  </option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
              {scopeType === "employee" && (
                <input
                  required
                  value={scopeValue}
                  onChange={(e) => setScopeValue(e.target.value)}
                  placeholder="Employee id"
                  className={inputClass}
                />
              )}
            </div>
          </>
        )}
        {initial && (
          <div className="col-span-2 text-xs text-label-tertiary">
            {SCOPE_TYPE_LABELS[initial.scopeType]}: <span className="font-mono">{initial.scopeValue}</span> (the scope itself can't be
            changed after creation — deactivate this override and add a new one instead)
          </div>
        )}
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Override value (JSON) — merged over the type&apos;s default rules</label>
          <textarea value={ruleValueText} onChange={(e) => setRuleValueText(e.target.value)} className={textareaClass} spellCheck={false} />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Saving…" : initial ? "Save" : "Add override"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function OverridesPanel({ policyType }: { policyType: string }) {
  const [overrides, setOverrides] = useState<ConfigurationRuleMappingView[] | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [locations, setLocations] = useState<LocationView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api
      .listConfigurationRuleMappings("hr_business_policy", policyType, true)
      .then(setOverrides)
      .catch((err) => setLoadError(describeOverrideError(err)));
  }

  useEffect(() => {
    setOverrides(null);
    setLoadError(null);
    setAdding(false);
    setEditingId(null);
    setRowError(null);
    load();
    Promise.all([api.listOrgUnits(), api.listLocations()])
      .then(([units, locs]) => {
        setOrgUnits(units);
        setLocations(locs);
      })
      .catch(() => {
        // Non-fatal — the list below still works, just shows raw ids
        // instead of names, for whichever of these two didn't load.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyType]);

  async function toggleActive(mapping: ConfigurationRuleMappingView) {
    setRowError(null);
    setBusyId(mapping.id);
    try {
      await api.updateConfigurationRuleMapping(mapping.id, { isActive: !mapping.isActive });
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not update this override.");
    } finally {
      setBusyId(null);
    }
  }

  function scopeLabel(mapping: ConfigurationRuleMappingView): string {
    if (mapping.scopeType === "org_unit") return orgUnits.find((u) => u.id === mapping.scopeValue)?.name ?? mapping.scopeValue;
    if (mapping.scopeType === "location") return locations.find((l) => l.id === mapping.scopeValue)?.name ?? mapping.scopeValue;
    return mapping.scopeValue;
  }

  return (
    <div className="mt-4 pt-4 border-t border-black/10">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h3 className="font-semibold text-sm">Scoped overrides</h3>
          <p className="text-xs text-label-tertiary mt-0.5">
            Override this policy&apos;s rules for a specific org unit, location, or employee — the most specific match wins
            (employee, then location, then the org unit itself or its nearest configured ancestor), falling back to the
            default policy above when none applies.
          </p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-xs font-semibold text-accent hover:underline shrink-0">
            + Add override
          </button>
        )}
      </div>

      {loadError && <div className="text-danger text-xs mt-2 mb-2">{loadError}</div>}
      {rowError && <div className="text-danger text-xs mt-2 mb-2">{rowError}</div>}

      {adding && (
        <OverrideForm
          policyType={policyType}
          orgUnits={orgUnits}
          locations={locations}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      {overrides === null && <div className="text-sm text-label-tertiary mt-2">Loading…</div>}
      {overrides && overrides.length === 0 && !adding && <div className="text-sm text-label-tertiary mt-2">No overrides yet.</div>}

      {overrides && overrides.length > 0 && (
        <div className="divide-y divide-black/5 mt-2">
          {overrides.map((mapping) =>
            editingId === mapping.id ? (
              <div key={mapping.id} className="py-2.5">
                <OverrideForm
                  policyType={policyType}
                  orgUnits={orgUnits}
                  locations={locations}
                  initial={mapping}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    load();
                  }}
                />
              </div>
            ) : (
              <div key={mapping.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={`text-sm flex items-center gap-2 ${mapping.isActive ? "" : "text-label-tertiary"}`}>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">
                      {SCOPE_TYPE_LABELS[mapping.scopeType]}
                    </span>
                    <span className="font-medium">{scopeLabel(mapping)}</span>
                    {!mapping.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">Deactivated</span>}
                  </div>
                  <pre className="text-xs font-mono text-label-tertiary bg-black/5 rounded px-2 py-1.5 mt-1.5 overflow-x-auto max-w-md">
                    {formatRules(mapping.ruleValue)}
                  </pre>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => setEditingId(mapping.id)} className="text-xs font-medium text-accent hover:underline">
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive(mapping)}
                    disabled={busyId === mapping.id}
                    className="text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
                  >
                    {mapping.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function PolicyTypePanel({ type }: { type: HrBusinessPolicyTypeSummary }) {
  const [policies, setPolicies] = useState<HrBusinessPolicyView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api
      .listHrBusinessPolicies(type.policyType, showInactive)
      .then((rows) => setPolicies([...rows].sort((a, b) => a.sortOrder - b.sortOrder)))
      .catch((err) => setLoadError(describeError(err)));
  }

  useEffect(() => {
    setPolicies(null);
    setLoadError(null);
    setAdding(false);
    setEditingId(null);
    setRowError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type.policyType, showInactive]);

  async function toggleActive(policy: HrBusinessPolicyView) {
    setRowError(null);
    setBusyId(policy.id);
    try {
      await api.updateHrBusinessPolicy(policy.id, { isActive: !policy.isActive });
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not update this policy.");
    } finally {
      setBusyId(null);
    }
  }

  async function makeDefault(policy: HrBusinessPolicyView) {
    setRowError(null);
    setBusyId(policy.id);
    try {
      await api.updateHrBusinessPolicy(policy.id, { isDefault: true });
      load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "Could not set this as the default.");
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
            + Add policy
          </button>
        )}
      </div>

      <div
        className={`text-xs rounded-lg px-3 py-2 mt-3 mb-3 ${
          type.wiredInto.startsWith("Not yet consumed") ? "bg-amber-500/10 text-amber-700" : "bg-emerald-500/10 text-emerald-700"
        }`}
      >
        {type.wiredInto}
      </div>

      <label className="flex items-center gap-1.5 text-xs text-label-tertiary mb-3">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded border-black/20" />
        Show deactivated policies
      </label>

      {loadError && <div className="text-danger text-xs mb-2">{loadError}</div>}
      {rowError && <div className="text-danger text-xs mb-2">{rowError}</div>}

      {adding && <PolicyForm type={type} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}

      {policies === null && <div className="text-sm text-label-tertiary">Loading…</div>}
      {policies && policies.length === 0 && !adding && <div className="text-sm text-label-tertiary">No policies yet.</div>}

      {policies && policies.length > 0 && (
        <div className="divide-y divide-black/5">
          {policies.map((policy) =>
            editingId === policy.id ? (
              <div key={policy.id} className="py-2.5">
                <PolicyForm type={type} initial={policy} onCancel={() => setEditingId(null)} onSaved={() => { setEditingId(null); load(); }} />
              </div>
            ) : (
              <div key={policy.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={`text-sm flex items-center gap-2 ${policy.isActive ? "" : "text-label-tertiary"}`}>
                    <span className="font-medium">{policy.name}</span>
                    <span className="text-xs text-label-tertiary font-mono">{policy.code}</span>
                    {policy.isDefault && <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">Default</span>}
                    {!policy.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">Deactivated</span>}
                  </div>
                  {policy.description && <div className="text-xs text-label-tertiary mt-0.5">{policy.description}</div>}
                  <pre className="text-xs font-mono text-label-tertiary bg-black/5 rounded px-2 py-1.5 mt-1.5 overflow-x-auto max-w-md">
                    {formatRules(policy.rules)}
                  </pre>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {!policy.isDefault && policy.isActive && (
                    <button onClick={() => makeDefault(policy)} disabled={busyId === policy.id} className="text-xs font-medium text-accent hover:underline disabled:opacity-50">
                      Make default
                    </button>
                  )}
                  <button onClick={() => setEditingId(policy.id)} className="text-xs font-medium text-accent hover:underline">
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive(policy)}
                    disabled={busyId === policy.id}
                    className="text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
                  >
                    {policy.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <OverridesPanel policyType={type.policyType} />
    </section>
  );
}

export function BusinessPoliciesPanel() {
  const [types, setTypes] = useState<HrBusinessPolicyTypeSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api
      .listHrBusinessPolicyTypes()
      .then((rows) => {
        setTypes(rows);
        setSelected((current) => current ?? rows[0]?.policyType ?? null);
      })
      .catch((err) => setLoadError(describeError(err)));
  }, []);

  if (loadError) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{loadError}</div>;
  if (!types) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const selectedType = types.find((t) => t.policyType === selected) ?? types[0] ?? null;

  return (
    <div className="flex gap-6 items-start">
      <nav className="w-64 shrink-0 space-y-0.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1.5 px-1">Business Policies</div>
        {types.map((t) => (
          <button
            key={t.policyType}
            onClick={() => setSelected(t.policyType)}
            className={`w-full flex items-center justify-between gap-2 text-left px-3 py-1.5 rounded-lg text-sm ${
              selectedType?.policyType === t.policyType ? "bg-accent/10 text-accent font-medium" : "text-label-secondary hover:bg-black/5"
            }`}
          >
            <span className="truncate">{t.label}</span>
            <span className="text-xs text-label-tertiary shrink-0">{t.policyCount}</span>
          </button>
        ))}
      </nav>

      <div className="flex-1 min-w-0">{selectedType && <PolicyTypePanel key={selectedType.policyType} type={selectedType} />}</div>
    </div>
  );
}
