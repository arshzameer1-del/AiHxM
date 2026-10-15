import { FormEvent, useEffect, useState } from "react";
import type { LocationView, ScopedOvertimePolicyView, SetOvertimePolicyRequest } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage overtime policies.";
    return err.message;
  }
  return "Something went wrong.";
}

type Group = { id: string; name: string };

type FormState = {
  name: string;
  employeeGroupId: string;
  locationId: string;
  dailyThresholdMinutes: string;
  weekdayRateMultiplier: string;
  restDayRateMultiplier: string;
  holidayRateMultiplier: string;
  maxDailyMinutes: string;
  maxMonthlyMinutes: string;
  requiresPreApproval: boolean;
  compOffAllowed: boolean;
  compOffMinutesPerDay: string;
};

function formFrom(p?: ScopedOvertimePolicyView): FormState {
  return {
    name: p?.name ?? "",
    employeeGroupId: p?.employeeGroupId ?? "",
    locationId: p?.locationId ?? "",
    dailyThresholdMinutes: String(p?.dailyThresholdMinutes ?? 0),
    weekdayRateMultiplier: String(p?.weekdayRateMultiplier ?? 1.5),
    restDayRateMultiplier: String(p?.restDayRateMultiplier ?? 2),
    holidayRateMultiplier: String(p?.holidayRateMultiplier ?? 2),
    maxDailyMinutes: p?.maxDailyMinutes ? String(p.maxDailyMinutes) : "",
    maxMonthlyMinutes: p?.maxMonthlyMinutes ? String(p.maxMonthlyMinutes) : "",
    requiresPreApproval: p?.requiresPreApproval ?? false,
    compOffAllowed: p?.compOffAllowed ?? false,
    compOffMinutesPerDay: String(p?.compOffMinutesPerDay ?? 480),
  };
}

function toRequest(f: FormState): SetOvertimePolicyRequest {
  return {
    dailyThresholdMinutes: Number(f.dailyThresholdMinutes) || 0,
    weekdayRateMultiplier: Number(f.weekdayRateMultiplier),
    restDayRateMultiplier: Number(f.restDayRateMultiplier),
    holidayRateMultiplier: Number(f.holidayRateMultiplier),
    maxDailyMinutes: f.maxDailyMinutes ? Number(f.maxDailyMinutes) : null,
    maxMonthlyMinutes: f.maxMonthlyMinutes ? Number(f.maxMonthlyMinutes) : null,
    requiresPreApproval: f.requiresPreApproval,
    compOffAllowed: f.compOffAllowed,
    compOffMinutesPerDay: Number(f.compOffMinutesPerDay) || 480,
  };
}

function summary(p: ScopedOvertimePolicyView): string {
  const bits = [`${p.weekdayRateMultiplier}× weekday`, `${p.restDayRateMultiplier}× rest day`, `${p.holidayRateMultiplier}× holiday`];
  if (p.maxDailyMinutes) bits.push(`max ${p.maxDailyMinutes / 60} h/day`);
  if (p.maxMonthlyMinutes) bits.push(`max ${p.maxMonthlyMinutes / 60} h/month`);
  if (p.requiresPreApproval) bits.push("needs prior approval");
  if (p.compOffAllowed) bits.push("comp-off allowed");
  return bits.join(" · ");
}

function NumberField({ id, label, value, onChange, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1">{label}</label>
      <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm tabular-nums" />
      {hint && <p className="text-xs text-label-tertiary mt-1">{hint}</p>}
    </div>
  );
}

function PolicyForm({
  initial,
  scoped,
  groups,
  locations,
  onCancel,
  onSaved,
}: {
  initial?: ScopedOvertimePolicyView;
  scoped: boolean;
  groups: Group[];
  locations: LocationView[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>(() => formFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (scoped) {
        if (!f.employeeGroupId && !f.locationId) {
          setError("Choose an employee group, a location, or both.");
          return;
        }
        await api.setScopedOvertimePolicy({
          ...toRequest(f),
          name: f.name || undefined,
          employeeGroupId: f.employeeGroupId || undefined,
          locationId: f.locationId || undefined,
        });
      } else {
        await api.setOvertimePolicy(toRequest(f));
      }
      onSaved();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <form onSubmit={submit} className="bg-black/5 rounded-lg p-4 space-y-4">
      {scoped && (
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="ot-name" className="block text-sm font-medium mb-1">Name</label>
            <input id="ot-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Factory floor" className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="ot-group" className="block text-sm font-medium mb-1">Employee group</label>
            <select id="ot-group" disabled={!!initial} value={f.employeeGroupId} onChange={(e) => set("employeeGroupId", e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              <option value="">Any</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ot-loc" className="block text-sm font-medium mb-1">Location</label>
            <select id="ot-loc" disabled={!!initial} value={f.locationId} onChange={(e) => set("locationId", e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              <option value="">Any</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
      )}
      <div className="grid grid-cols-4 gap-4">
        <NumberField id="ot-wd" label="Weekday rate ×" value={f.weekdayRateMultiplier} onChange={(v) => set("weekdayRateMultiplier", v)} />
        <NumberField id="ot-rd" label="Rest day rate ×" value={f.restDayRateMultiplier} onChange={(v) => set("restDayRateMultiplier", v)} />
        <NumberField id="ot-hd" label="Holiday rate ×" value={f.holidayRateMultiplier} onChange={(v) => set("holidayRateMultiplier", v)} />
        <NumberField id="ot-th" label="Minimum extra minutes" value={f.dailyThresholdMinutes} onChange={(v) => set("dailyThresholdMinutes", v)} hint="Below this a weekday earns nothing" />
        <NumberField id="ot-md" label="Daily cap (minutes)" value={f.maxDailyMinutes} onChange={(v) => set("maxDailyMinutes", v)} hint="Empty = no cap" />
        <NumberField id="ot-mm" label="Monthly cap (minutes)" value={f.maxMonthlyMinutes} onChange={(v) => set("maxMonthlyMinutes", v)} hint="Empty = no cap" />
        <NumberField id="ot-co" label="Comp-off: minutes per day" value={f.compOffMinutesPerDay} onChange={(v) => set("compOffMinutesPerDay", v)} hint="Overtime earning one day off" />
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.requiresPreApproval} onChange={(e) => set("requiresPreApproval", e.target.checked)} />
          Overtime needs prior approval
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.compOffAllowed} onChange={(e) => set("compOffAllowed", e.target.checked)} />
          Employees may take overtime as compensatory leave
        </label>
      </div>
      {error && <div className="text-sm text-danger">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">Save policy</button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">Cancel</button>
      </div>
    </form>
  );
}

/**
 * TLM-07 - overtime rules. One company-wide policy, plus optional policies for an employee group
 * and/or a location; for each employee the group policy wins over the location policy, which wins
 * over the company default.
 */
export function OvertimePoliciesPanel() {
  const [policies, setPolicies] = useState<ScopedOvertimePolicyView[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [locations, setLocations] = useState<LocationView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);

  function load() {
    api.listOvertimePolicies().then(setPolicies).catch((err) => setError(describeError(err)));
  }
  useEffect(() => {
    load();
    api.listEmployeeGroups().then((gs) => setGroups(gs.map((g) => ({ id: g.id, name: g.name })))).catch(() => undefined);
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);

  async function end(p: ScopedOvertimePolicyView) {
    if (!window.confirm(`End the "${p.name ?? "scoped"}" overtime policy? Its employees fall back to the next policy that applies.`)) return;
    try {
      await api.endScopedOvertimePolicy(p.id);
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (error && !policies) return <p className="text-sm text-danger">{error}</p>;
  if (!policies) return <p className="text-sm text-label-tertiary">Loading…</p>;

  const nameOf = (p: ScopedOvertimePolicyView) => {
    if (p.scopeKey === "company") return "Company-wide";
    const g = groups.find((x) => x.id === p.employeeGroupId)?.name;
    const l = locations.find((x) => x.id === p.locationId)?.name;
    return p.name ?? [g, l].filter(Boolean).join(" · ");
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-label-secondary max-w-2xl">
          How overtime is rated, capped and approved. Approved overtime is paid once, by the payroll run that picks it up.
        </p>
        <button onClick={() => setEditing("new")} className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm font-semibold shrink-0">
          New policy for a group or location
        </button>
      </div>

      {editing === "new" && (
        <PolicyForm scoped groups={groups} locations={locations} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}

      <div className="bg-card rounded-card shadow-sm divide-y divide-black/5">
        {policies.map((p) => (
          <div key={p.id} className="p-4">
            {editing === p.id ? (
              <PolicyForm initial={p} scoped={p.scopeKey !== "company"} groups={groups} locations={locations} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{nameOf(p)}</div>
                  <div className="text-xs text-label-secondary mt-1">{summary(p)}</div>
                </div>
                <div className="flex gap-3 text-xs font-semibold shrink-0">
                  <button onClick={() => setEditing(p.id)} className="text-accent">Edit</button>
                  {p.scopeKey !== "company" && <button onClick={() => end(p)} className="text-danger">End</button>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
