import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AttendanceGeofenceView, AttendancePenaltyRowView, AttendancePenaltyRuleView, AttendancePolicyView, GeofenceMode, LocationExceptionView, SelfieMode,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const inputCls = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
const primaryBtn = "bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50";
const ghostBtn = "px-3 py-1.5 text-sm font-medium rounded-lg border border-black/10 disabled:opacity-50";
const msg = (err: unknown, fallback = "Something went wrong.") => (err instanceof ApiError ? err.message : fallback);

type Tab = "location" | "review" | "penalties";
const TABS: { key: Tab; label: string }[] = [
  { key: "location", label: "Location and selfie" },
  { key: "review", label: "Review clock-ins" },
  { key: "penalties", label: "Late and early penalties" },
];

export const FLAG_LABEL: Record<string, string> = {
  low_accuracy: "Poor GPS accuracy",
  impossible_travel: "Impossible travel since last punch",
  perfect_accuracy: "Suspiciously perfect accuracy",
  reported_mock_location: "App reported a mock location",
};

/** HR: where people may clock in from, whether a selfie is needed, which clock-ins looked wrong, and the late/early penalty rules. */
export function AttendanceRulesPage() {
  const [tab, setTab] = useState<Tab>("location");
  return (
    <div>
      <BackLink to="/app/attendance">Back to Time & Attendance</BackLink>
      <PageHeader title="Attendance rules" subtitle="Location checks, selfies, clock-in review and penalties for lateness." />
      <div className="flex gap-1 mb-6 border-b border-black/5 overflow-x-auto" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px whitespace-nowrap ${tab === t.key ? "border-accent text-accent" : "border-transparent text-label-tertiary hover:text-label-primary"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "location" && <LocationPanel />}
      {tab === "review" && <ReviewPanel />}
      {tab === "penalties" && <PenaltiesPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- location

function LocationPanel() {
  const [policy, setPolicy] = useState<AttendancePolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api.getAttendancePolicy().then(setPolicy).catch((e) => setError(msg(e, "Could not load the rules."))), []);
  useEffect(() => { load(); }, [load]);

  async function update(patch: Parameters<typeof api.updateAttendancePolicy>[0]) {
    setError(null);
    setNote(null);
    try {
      setPolicy(await api.updateAttendancePolicy(patch));
      setNote("Saved");
    } catch (e) {
      setError(msg(e));
    }
  }

  if (!policy) return error ? <div role="alert" className="text-danger text-sm">{error}</div> : <LoadingNote />;
  return (
    <div className="space-y-6 max-w-3xl">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
      {note && <div className="text-sm text-success" role="status">{note}</div>}
      <section className="bg-card rounded-card shadow-sm p-5 space-y-4">
        <h2 className="font-semibold">Allowed places</h2>
        <p className="text-xs text-label-tertiary">A clock-in is inside when the phone or computer reports a position within the radius of one of these places.</p>
        <GeofenceList policy={policy} onChanged={load} />
      </section>
      <section className="bg-card rounded-card shadow-sm p-5 space-y-4">
        <h2 className="font-semibold">Checks at clock-in</h2>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="ar-geo">Location check</label>
          <select id="ar-geo" className={`${inputCls} max-w-md`} value={policy.geofenceMode} onChange={(e) => update({ geofenceMode: e.target.value as GeofenceMode })}>
            <option value="off">Off: any location is accepted</option>
            <option value="flag">Flag: accept it, mark clock-ins from outside for review</option>
            <option value="block">Block: refuse clock-ins from outside the allowed places</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="ar-selfie">Selfie</label>
          <select id="ar-selfie" className={`${inputCls} max-w-md`} value={policy.selfieMode} onChange={(e) => update({ selfieMode: e.target.value as SelfieMode })}>
            <option value="off">Off</option>
            <option value="optional">Optional: kept when the person takes one</option>
            <option value="required">Required: no selfie, no clock-in</option>
          </select>
          <p className="text-xs text-label-tertiary mt-1">A selfie is a small photo that only the person and people who can see everyone&apos;s attendance can open.</p>
        </div>
        <fieldset className="border-t border-black/5 pt-4 space-y-3">
          <legend className="text-sm font-semibold pr-2">Suspicious positions</legend>
          <p className="text-xs text-label-tertiary">These are simple rules, not proof. A weak signal can flag an honest person, and a careful spoofer may not be flagged. Use them to decide who to look at.</p>
          <AccuracyForm policy={policy} onSave={update} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={policy.blockSuspectLocation} onChange={(e) => update({ blockSuspectLocation: e.target.checked })} />
            Refuse the clock-in when any of these signals appear (otherwise it is accepted and flagged)
          </label>
        </fieldset>
      </section>
    </div>
  );
}

function AccuracyForm({ policy, onSave }: { policy: AttendancePolicyView; onSave: (p: { maxGpsAccuracyM: number | null; maxTravelSpeedKmh: number }) => void }) {
  const [acc, setAcc] = useState(policy.maxGpsAccuracyM === null ? "" : String(policy.maxGpsAccuracyM));
  const [speed, setSpeed] = useState(String(policy.maxTravelSpeedKmh));
  return (
    <form className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); onSave({ maxGpsAccuracyM: acc === "" ? null : Number(acc), maxTravelSpeedKmh: Number(speed) }); }}>
      <div>
        <label className="block text-xs font-semibold mb-1" htmlFor="ar-acc">Flag accuracy worse than (metres)</label>
        <input id="ar-acc" inputMode="numeric" className={inputCls} value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="Not checked" />
      </div>
      <div>
        <label className="block text-xs font-semibold mb-1" htmlFor="ar-speed">Flag travel faster than (km/h)</label>
        <input id="ar-speed" inputMode="numeric" className={inputCls} value={speed} onChange={(e) => setSpeed(e.target.value)} />
      </div>
      <button type="submit" className={ghostBtn}>Save limits</button>
    </form>
  );
}

function GeofenceList({ policy, onChanged }: { policy: AttendancePolicyView; onChanged: () => void }) {
  const [editing, setEditing] = useState<AttendanceGeofenceView | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(g: AttendanceGeofenceView) {
    setError(null);
    try {
      await api.deleteAttendanceGeofence(g.id);
      onChanged();
    } catch (e) {
      setError(msg(e));
    }
  }

  return (
    <div className="space-y-3">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
      {policy.geofences.length === 0 && <p className="text-sm text-label-tertiary">No places yet. Add your office to start using location checks.</p>}
      <ul className="divide-y divide-black/5">
        {policy.geofences.map((g) => (
          <li key={g.id} className="py-2 flex flex-wrap items-center gap-3" data-testid="geofence-row">
            <span className="font-medium text-sm">{g.name}</span>
            <span className="text-xs text-label-tertiary tabular-nums">{g.latitude.toFixed(5)}, {g.longitude.toFixed(5)} · {g.radiusM} m{g.isActive ? "" : " · switched off"}</span>
            <span className="ml-auto flex gap-3">
              <button className="text-accent text-xs font-medium hover:underline" onClick={() => setEditing(g)}>Edit</button>
              <button className="text-danger text-xs font-medium hover:underline" onClick={() => remove(g)}>Remove</button>
            </span>
          </li>
        ))}
      </ul>
      {editing === null && <button className={ghostBtn} onClick={() => setEditing("new")}>Add a place</button>}
      {editing !== null && <GeofenceForm initial={editing === "new" ? null : editing} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />}
    </div>
  );
}

function GeofenceForm({ initial, onDone, onCancel }: { initial: AttendanceGeofenceView | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [lat, setLat] = useState(initial ? String(initial.latitude) : "");
  const [lng, setLng] = useState(initial ? String(initial.longitude) : "");
  const [radius, setRadius] = useState(initial ? String(initial.radiusM) : "150");
  const [active, setActive] = useState(initial?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  function useMyPosition() {
    setError(null);
    if (!navigator.geolocation) { setError("This browser cannot share a position. Type the coordinates instead."); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(6)); setLng(p.coords.longitude.toFixed(6)); },
      () => setError("Could not read your position. Allow location access, or type the coordinates."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name, latitude: Number(lat), longitude: Number(lng), radiusM: Number(radius), isActive: active };
    try {
      if (initial) await api.updateAttendanceGeofence(initial.id, body);
      else await api.createAttendanceGeofence(body);
      onDone();
    } catch (err) {
      setError(msg(err));
    }
  }

  return (
    <form onSubmit={save} className="bg-black/[0.03] rounded-lg p-4 space-y-3" aria-label="Allowed place">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label className="block text-xs font-semibold mb-1" htmlFor="gf-name">Name</label><input id="gf-name" required className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="gf-radius">Radius (metres)</label><input id="gf-radius" required inputMode="numeric" className={inputCls} value={radius} onChange={(e) => setRadius(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="gf-lat">Latitude</label><input id="gf-lat" required inputMode="decimal" className={inputCls} value={lat} onChange={(e) => setLat(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="gf-lng">Longitude</label><input id="gf-lng" required inputMode="decimal" className={inputCls} value={lng} onChange={(e) => setLng(e.target.value)} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use</label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={ghostBtn} onClick={useMyPosition}>Use my current position</button>
        <button type="submit" className={primaryBtn}>Save place</button>
        <button type="button" className={ghostBtn} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------- review

const iso = (d: Date) => d.toISOString().slice(0, 10);

function ReviewPanel() {
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 13 * 86_400_000)));
  const [to, setTo] = useState(() => iso(new Date()));
  const [rows, setRows] = useState<LocationExceptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<{ id: string; url: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.listLocationExceptions(from, to).then(setRows).catch((e) => { setRows([]); setError(msg(e, "Could not load the list.")); });
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  async function showSelfie(id: string) {
    try {
      setSelfie({ id, url: await api.fetchAttendanceSelfie(id) });
    } catch (e) {
      setError(msg(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div><label className="block text-xs font-semibold mb-1" htmlFor="rv-from">From</label><input id="rv-from" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="rv-to">To</label><input id="rv-to" type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
      {!rows ? <LoadingNote /> : rows.length === 0 ? (
        <div className="bg-card rounded-card shadow-sm p-5 text-sm text-label-tertiary">No clock-ins in this period were outside the allowed places or flagged.</div>
      ) : (
        <div className="bg-card rounded-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-label-tertiary"><th className="p-3">Employee</th><th className="p-3">Clock-in</th><th className="p-3">Place</th><th className="p-3">Signals</th><th className="p-3" /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recordId} className="border-t border-black/5" data-testid="exception-row">
                  <td className="p-3">{r.employeeName}<span className="block text-xs text-label-tertiary">{r.employeeNumber}</span></td>
                  <td className="p-3 whitespace-nowrap">{formatDateTime(r.clockInAt)}</td>
                  <td className="p-3">{r.geofenceResult === "outside" ? "Outside allowed places" : r.geofenceResult === "unknown" ? "No position given" : r.geofenceName ?? "Inside"}</td>
                  <td className="p-3">{r.flags.length ? r.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ") : "None"}{r.gpsAccuracyM !== null && <span className="block text-xs text-label-tertiary">accuracy {r.gpsAccuracyM} m</span>}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    {r.gpsLat !== null && r.gpsLng !== null && <a className="text-accent text-xs font-medium hover:underline mr-3" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${r.gpsLat}&mlon=${r.gpsLng}#map=17/${r.gpsLat}/${r.gpsLng}`}>Map</a>}
                    {r.hasSelfie && <button className="text-accent text-xs font-medium hover:underline" onClick={() => showSelfie(r.recordId)}>Selfie</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selfie && (
        <div className="bg-card rounded-card shadow-sm p-4 inline-block" data-testid="selfie-view">
          <img src={selfie.url} alt="Clock-in selfie" className="max-w-[240px] rounded" />
          <button className="block text-xs text-accent mt-2" onClick={() => { URL.revokeObjectURL(selfie.url); setSelfie(null); }}>Close</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- penalties

function lastMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function PenaltiesPanel() {
  const [rules, setRules] = useState<AttendancePenaltyRuleView[] | null>(null);
  const [leaveTypes, setLeaveTypes] = useState<Array<{ code: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AttendancePenaltyRuleView | "new" | null>(null);
  const [month, setMonth] = useState(lastMonth);
  const [rows, setRows] = useState<AttendancePenaltyRowView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadRules = useCallback(() => api.listAttendancePenaltyRules().then(setRules).catch((e) => { setRules([]); setError(msg(e, "Could not load the rules.")); }), []);
  const loadPreview = useCallback(() => api.previewAttendancePenalties(month).then(setRows).catch((e) => { setRows([]); setError(msg(e)); }), [month]);
  useEffect(() => { loadRules(); api.listLeaveTypes().then((t) => setLeaveTypes(t.filter((x) => x.tracksBalance).map((x) => ({ code: x.code, name: x.name })))).catch(() => undefined); }, [loadRules]);
  useEffect(() => { loadPreview(); }, [loadPreview, rules]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await loadPreview();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  }

  const describe = (r: AttendancePenaltyRuleView) =>
    `Every ${r.everyN} ${r.triggerKind === "late" ? "late arrival" : "early departure"}${r.everyN === 1 ? "" : "s"} of ${r.minMinutes}+ minutes: ` +
    (r.penaltyType === "leave_deduction" ? `${r.penaltyDays} day(s) from ${leaveTypes.find((t) => t.code === r.leaveType)?.name ?? r.leaveType}` : `PKR ${r.penaltyAmount?.toLocaleString("en-PK")} deducted from pay`);

  return (
    <div className="space-y-6 max-w-4xl">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
      <section className="bg-card rounded-card shadow-sm p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Rules</h2>
          {editing === null && <button className={ghostBtn} onClick={() => setEditing("new")}>Add a rule</button>}
        </div>
        <p className="text-xs text-label-tertiary">Nothing is applied by itself. After a month ends you review who reached a threshold, then apply the penalty yourself. Approved leave, holidays and rest days are never counted.</p>
        {!rules ? <LoadingNote /> : rules.length === 0 && editing === null && <p className="text-sm text-label-tertiary">No rules yet.</p>}
        <ul className="divide-y divide-black/5">
          {(rules ?? []).map((r) => (
            <li key={r.id} className="py-2 flex flex-wrap items-center gap-3" data-testid="penalty-rule">
              <span className="font-medium text-sm">{r.name}</span>
              <span className="text-xs text-label-tertiary">{describe(r)}{r.isActive ? "" : " · switched off"}</span>
              <span className="ml-auto flex gap-3">
                <button className="text-accent text-xs font-medium hover:underline" onClick={() => setEditing(r)}>Edit</button>
                <button className="text-danger text-xs font-medium hover:underline" onClick={() => act(`del-${r.id}`, async () => { await api.deleteAttendancePenaltyRule(r.id); await loadRules(); })}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
        {editing !== null && <RuleForm initial={editing === "new" ? null : editing} leaveTypes={leaveTypes} onDone={() => { setEditing(null); loadRules(); }} onCancel={() => setEditing(null)} />}
      </section>

      <section className="bg-card rounded-card shadow-sm p-5 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="font-semibold mr-auto">Month review</h2>
          <div><label className="block text-xs font-semibold mb-1" htmlFor="pn-month">Month</label><input id="pn-month" type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} /></div>
        </div>
        {!rows ? <LoadingNote /> : rows.length === 0 ? (
          <p className="text-sm text-label-tertiary">Nobody reached a threshold in this month.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase tracking-wide text-label-tertiary"><th className="p-2">Employee</th><th className="p-2">Rule</th><th className="p-2">Occurrences</th><th className="p-2">Penalty</th><th className="p-2" /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.ruleId}-${r.employeeId}`} className="border-t border-black/5" data-testid="penalty-row">
                    <td className="p-2">{r.employeeName}<span className="block text-xs text-label-tertiary">{r.employeeNumber}</span></td>
                    <td className="p-2">{r.ruleName}</td>
                    <td className="p-2 tabular-nums">{r.occurrences}</td>
                    <td className="p-2">{r.penaltyDays !== null ? `${r.penaltyDays} day(s)` : `PKR ${r.penaltyAmount?.toLocaleString("en-PK")}`}</td>
                    <td className="p-2 text-right whitespace-nowrap">
                      {r.status === "pending" && <button className={primaryBtn} disabled={busy !== null} onClick={() => act(`a-${r.ruleId}-${r.employeeId}`, () => api.applyAttendancePenalty({ ruleId: r.ruleId, employeeId: r.employeeId, month }))}>Apply</button>}
                      {r.status === "applied" && <><span className="text-xs text-success mr-3">Applied</span><button className={ghostBtn} disabled={busy !== null} onClick={() => act(`r-${r.applicationId}`, () => api.reverseAttendancePenalty(r.applicationId as string))}>Reverse</button></>}
                      {r.status === "reversed" && <span className="text-xs text-label-tertiary">Reversed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function RuleForm({ initial, leaveTypes, onDone, onCancel }: { initial: AttendancePenaltyRuleView | null; leaveTypes: Array<{ code: string; name: string }>; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState(initial?.triggerKind ?? "late");
  const [minutes, setMinutes] = useState(String(initial?.minMinutes ?? 10));
  const [everyN, setEveryN] = useState(String(initial?.everyN ?? 3));
  const [type, setType] = useState(initial?.penaltyType ?? "leave_deduction");
  const [leaveType, setLeaveType] = useState(initial?.leaveType ?? leaveTypes[0]?.code ?? "");
  const [days, setDays] = useState(String(initial?.penaltyDays ?? 1));
  const [amount, setAmount] = useState(String(initial?.penaltyAmount ?? ""));
  const [active, setActive] = useState(initial?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      name, triggerKind: trigger, minMinutes: Number(minutes), everyN: Number(everyN), penaltyType: type, isActive: active,
      leaveType: type === "leave_deduction" ? leaveType : null, penaltyDays: type === "leave_deduction" ? Number(days) : null, penaltyAmount: type === "salary_deduction" ? Number(amount) : null,
    };
    try {
      if (initial) await api.updateAttendancePenaltyRule(initial.id, body);
      else await api.createAttendancePenaltyRule(body);
      onDone();
    } catch (err) {
      setError(msg(err));
    }
  }

  return (
    <form onSubmit={save} className="bg-black/[0.03] rounded-lg p-4 space-y-3" aria-label="Penalty rule">
      {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2"><label className="block text-xs font-semibold mb-1" htmlFor="pr-name">Rule name</label><input id="pr-name" required className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-trigger">Counts</label>
          <select id="pr-trigger" className={inputCls} value={trigger} onChange={(e) => setTrigger(e.target.value as "late" | "early_leave")}><option value="late">Late arrivals</option><option value="early_leave">Early departures</option></select></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-min">Only when at least (minutes)</label><input id="pr-min" required inputMode="numeric" className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-every">Penalty for every (occurrences)</label><input id="pr-every" required inputMode="numeric" className={inputCls} value={everyN} onChange={(e) => setEveryN(e.target.value)} /></div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-type">Penalty</label>
          <select id="pr-type" className={inputCls} value={type} onChange={(e) => setType(e.target.value as "leave_deduction" | "salary_deduction")}><option value="leave_deduction">Deduct leave days</option><option value="salary_deduction">Deduct an amount from pay</option></select></div>
        {type === "leave_deduction" ? (
          <>
            <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-lt">Leave type</label>
              <select id="pr-lt" required className={inputCls} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>{leaveTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></div>
            <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-days">Days per penalty</label><input id="pr-days" required inputMode="decimal" className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} /></div>
          </>
        ) : (
          <div><label className="block text-xs font-semibold mb-1" htmlFor="pr-amt">Amount per penalty (PKR)</label><input id="pr-amt" required inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Rule is in use</label>
      <div className="flex gap-2"><button type="submit" className={primaryBtn}>Save rule</button><button type="button" className={ghostBtn} onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
