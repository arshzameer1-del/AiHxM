import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { TravelMode, TravelRateKind, TravelRateView, TravelRequestView, TravelSettlementView, TravelTripType } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { MODE_LABEL, STATUS_BADGE, TRIP_LABEL, balanceText, pkr } from "./travelUi";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
const lbl = "block text-xs font-medium text-label-secondary mb-1";
const btn = "rounded-lg px-3 py-1.5 text-sm font-semibold";
const errText = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

type Tab = "mine" | "approvals" | "manage";

function Badge({ status }: { status: TravelRequestView["status"] }) {
  const b = STATUS_BADGE[status];
  return <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${b.cls}`}>{b.label}</span>;
}

function RequestForm({ employeeId, onDone, onCancel }: { employeeId: string; onDone: (t: TravelRequestView) => void; onCancel: () => void }) {
  const [f, setF] = useState({ destination: "", purpose: "", tripType: "domestic" as TravelTripType, travelMode: "car" as TravelMode, startDate: "", endDate: "", estDistanceKm: "", estOtherCost: "", advanceRequested: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const n = (v: string) => (v.trim() === "" ? null : Number(v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      onDone(await api.submitTravel({
        employeeId, destination: f.destination.trim(), purpose: f.purpose.trim(), tripType: f.tripType, travelMode: f.travelMode, startDate: f.startDate, endDate: f.endDate || f.startDate,
        estDistanceKm: n(f.estDistanceKm), estOtherCost: n(f.estOtherCost), advanceRequested: n(f.advanceRequested) ?? 0,
      }));
    } catch (x) {
      setErr(errText(x, "Could not send your travel request."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="bg-card rounded-card shadow-sm p-4 space-y-3 mb-4" aria-label="Ask to travel">
      <h2 className="text-base font-semibold">Ask to travel</h2>
      {err && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2">{err}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div><label className={lbl} htmlFor="tr-dest">Destination</label><input id="tr-dest" required maxLength={160} className={field} value={f.destination} onChange={set("destination")} /></div>
        <div><label className={lbl} htmlFor="tr-from">From</label><input id="tr-from" type="date" required className={field} value={f.startDate} onChange={set("startDate")} /></div>
        <div><label className={lbl} htmlFor="tr-to">To</label><input id="tr-to" type="date" required className={field} value={f.endDate} onChange={set("endDate")} /></div>
        <div>
          <label className={lbl} htmlFor="tr-type">Trip</label>
          <select id="tr-type" className={field} value={f.tripType} onChange={set("tripType")}>{(Object.keys(TRIP_LABEL) as TravelTripType[]).map((k) => <option key={k} value={k}>{TRIP_LABEL[k]}</option>)}</select>
        </div>
        <div>
          <label className={lbl} htmlFor="tr-mode">Travelling by</label>
          <select id="tr-mode" className={field} value={f.travelMode} onChange={set("travelMode")}>{(Object.keys(MODE_LABEL) as TravelMode[]).map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}</select>
        </div>
        <div><label className={lbl} htmlFor="tr-km">Expected distance (km)</label><input id="tr-km" inputMode="decimal" className={field} value={f.estDistanceKm} onChange={set("estDistanceKm")} /></div>
        <div><label className={lbl} htmlFor="tr-other">Other expected costs (PKR)</label><input id="tr-other" inputMode="decimal" className={field} value={f.estOtherCost} onChange={set("estOtherCost")} placeholder="Tickets, hotel" /></div>
        <div><label className={lbl} htmlFor="tr-adv">Advance you would like (PKR)</label><input id="tr-adv" inputMode="decimal" className={field} value={f.advanceRequested} onChange={set("advanceRequested")} /></div>
      </div>
      <div><label className={lbl} htmlFor="tr-purpose">What is the trip for?</label><textarea id="tr-purpose" required rows={2} maxLength={1000} className={field} value={f.purpose} onChange={set("purpose")} /></div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${btn} bg-accent text-white disabled:opacity-50`}>{busy ? "Sending…" : "Send request"}</button>
        <button type="button" onClick={onCancel} className={`${btn} bg-black/5`}>Cancel</button>
      </div>
    </form>
  );
}

function SettlementSummary({ s }: { s: TravelSettlementView }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm" aria-label="Settlement">
      <div><dt className="text-xs text-label-tertiary">Per diem ({s.actualDays} day{s.actualDays === 1 ? "" : "s"}{s.perDiemRate !== null ? ` × ${pkr(s.perDiemRate)}` : ", no rate set"})</dt><dd>{pkr(s.perDiemAmount)}</dd></div>
      <div><dt className="text-xs text-label-tertiary">Mileage ({s.actualKm} km{s.mileageRate !== null ? ` × ${pkr(s.mileageRate)}` : ", no rate set"})</dt><dd>{pkr(s.mileageAmount)}</dd></div>
      <div><dt className="text-xs text-label-tertiary">Other costs</dt><dd>{pkr(s.otherCost)}{s.otherCostNote ? ` · ${s.otherCostNote}` : ""}</dd></div>
      <div><dt className="text-xs text-label-tertiary">Total cost</dt><dd className="font-semibold">{pkr(s.totalCost)}</dd></div>
      <div><dt className="text-xs text-label-tertiary">Advance already paid</dt><dd>{pkr(s.advanceAmount)}</dd></div>
      <div className="col-span-2 sm:col-span-3"><dt className="text-xs text-label-tertiary">Balance</dt><dd className="font-semibold" data-testid="settlement-balance">{balanceText(s.netAmount)}</dd></div>
    </dl>
  );
}

function TripCard({ t, children }: { t: TravelRequestView; children?: React.ReactNode }) {
  return (
    <li className="bg-card rounded-card shadow-sm p-4" data-testid="trip">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold">{t.destination} <span className="text-label-tertiary font-normal">· {t.employeeName}</span></p>
          <p className="text-xs text-label-tertiary mt-0.5">
            {formatDay(t.startDate)} to {formatDay(t.endDate)} · {TRIP_LABEL[t.tripType]} · {MODE_LABEL[t.travelMode]} · Estimated {pkr(t.estimatedCost)}
            {t.advanceRequested > 0 ? ` · Advance asked ${pkr(t.advanceRequested)}` : ""}
          </p>
        </div>
        <Badge status={t.status} />
      </div>
      <p className="text-sm mt-2 whitespace-pre-wrap">{t.purpose}</p>
      {t.decisionComment && <p className="text-xs text-label-secondary mt-1">Comment: “{t.decisionComment}”</p>}
      {t.advanceAmount > 0 && <p className="text-xs text-accent mt-1">Advance of {pkr(t.advanceAmount)} is being paid with salary.</p>}
      {t.settlement && <div className="mt-3"><SettlementSummary s={t.settlement} /></div>}
      {children}
    </li>
  );
}

function MyTrips({ employeeId }: { employeeId: string | null }) {
  const [rows, setRows] = useState<TravelRequestView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listMyTravel().then(setRows).catch((e) => { setRows([]); setError(errText(e, "Could not load your trips.")); }); }, []);
  useEffect(load, [load]);

  async function withdraw(id: string) {
    setError(null);
    try { await api.cancelTravel(id); setNotice("Trip withdrawn."); load(); } catch (e) { setError(errText(e, "Could not withdraw this trip.")); }
  }
  return (
    <div>
      {notice && <div role="status" className="text-sm bg-accent/10 text-accent rounded p-2 mb-3">{notice}</div>}
      {error && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}
      {employeeId && !adding && <button type="button" onClick={() => setAdding(true)} className={`${btn} bg-accent text-white mb-4`}>Ask to travel</button>}
      {adding && employeeId && <RequestForm employeeId={employeeId} onCancel={() => setAdding(false)} onDone={(t) => { setAdding(false); setNotice(`Your request to travel to ${t.destination} was sent.`); load(); }} />}
      {rows === null ? <LoadingNote what="your trips" /> : rows.length === 0 ? (
        <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">You have no travel requests yet.</div>
      ) : (
        <ul className="space-y-3" aria-label="My trips">
          {rows.map((t) => (
            <TripCard key={t.id} t={t}>
              {["pending", "approved", "returned"].includes(t.status) && (
                <div className="mt-3"><button type="button" onClick={() => withdraw(t.id)} className={`${btn} border border-black/10 bg-white`}>Withdraw</button></div>
              )}
            </TripCard>
          ))}
        </ul>
      )}
    </div>
  );
}

function Approvals() {
  const [rows, setRows] = useState<TravelRequestView[] | null>(null);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listPendingTravel().then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  async function decide(id: string, decision: "approved" | "rejected") {
    setError(null);
    try { await api.decideTravel(id, { decision, comment: comment[id]?.trim() || undefined }); load(); } catch (e) { setError(errText(e, "Could not save your decision.")); }
  }
  if (rows === null) return <LoadingNote what="requests" />;
  return (
    <div>
      {error && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}
      {rows.length === 0 ? <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">No travel requests are waiting for you.</div> : (
        <ul className="space-y-3" aria-label="Waiting for approval">
          {rows.map((t) => (
            <TripCard key={t.id} t={t}>
              <div className="flex flex-wrap items-end gap-2 mt-3">
                <div className="flex-1 min-w-[12rem]"><label className={lbl} htmlFor={`c-${t.id}`}>Comment (optional)</label><input id={`c-${t.id}`} className={field} value={comment[t.id] ?? ""} onChange={(e) => setComment((c) => ({ ...c, [t.id]: e.target.value }))} /></div>
                <button type="button" onClick={() => decide(t.id, "approved")} className={`${btn} bg-accent text-white`}>Approve</button>
                <button type="button" onClick={() => decide(t.id, "rejected")} className={`${btn} border border-black/10 bg-white`}>Do not approve</button>
              </div>
            </TripCard>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettleForm({ t, onDone }: { t: TravelRequestView; onDone: (v: TravelRequestView) => void }) {
  const days = Math.round((Date.parse(t.endDate) - Date.parse(t.startDate)) / 86400000) + 1;
  const [f, setF] = useState({ actualDays: String(days), actualKm: t.estDistanceKm !== null ? String(t.estDistanceKm) : "", otherCost: t.estOtherCost !== null ? String(t.estOtherCost) : "", otherCostNote: "" });
  const [preview, setPreview] = useState<TravelSettlementView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setPreview(null); setF((x) => ({ ...x, [k]: e.target.value })); };
  const body = () => ({ actualDays: Number(f.actualDays), actualKm: f.actualKm.trim() ? Number(f.actualKm) : null, otherCost: f.otherCost.trim() ? Number(f.otherCost) : null, otherCostNote: f.otherCostNote.trim() || null });

  async function calc(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try { setPreview(await api.previewTravelSettlement(t.id, body())); } catch (x) { setErr(errText(x, "Could not work out the settlement.")); } finally { setBusy(false); }
  }
  async function save() {
    setErr(null);
    setBusy(true);
    try { onDone(await api.settleTravel(t.id, body())); } catch (x) { setErr(errText(x, "Could not settle this trip.")); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={calc} className="bg-black/5 rounded-lg p-3 mt-3 space-y-3" aria-label="Settle trip">
      <h3 className="text-sm font-semibold">Settle this trip</h3>
      {err && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2">{err}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div><label className={lbl} htmlFor={`s-days-${t.id}`}>Days travelled</label><input id={`s-days-${t.id}`} inputMode="numeric" className={field} value={f.actualDays} onChange={set("actualDays")} /></div>
        <div><label className={lbl} htmlFor={`s-km-${t.id}`}>Distance (km)</label><input id={`s-km-${t.id}`} inputMode="decimal" className={field} value={f.actualKm} onChange={set("actualKm")} /></div>
        <div><label className={lbl} htmlFor={`s-oc-${t.id}`}>Other costs (PKR)</label><input id={`s-oc-${t.id}`} inputMode="decimal" className={field} value={f.otherCost} onChange={set("otherCost")} /></div>
        <div><label className={lbl} htmlFor={`s-note-${t.id}`}>What the other costs were</label><input id={`s-note-${t.id}`} className={field} value={f.otherCostNote} onChange={set("otherCostNote")} /></div>
      </div>
      {preview && <SettlementSummary s={preview} />}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${btn} border border-black/10 bg-white disabled:opacity-50`}>Work out the balance</button>
        {preview && <button type="button" disabled={busy} onClick={save} className={`${btn} bg-accent text-white disabled:opacity-50`}>Settle and send to payroll</button>}
      </div>
      <p className="text-[11px] text-label-tertiary">Per diem and mileage come from the rates on the Rates tab. The balance is paid, or recovered, with the next salary.</p>
    </form>
  );
}

function ManageTrips() {
  const [rows, setRows] = useState<TravelRequestView[] | null>(null);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<{ id: string; mode: "advance" | "settle" } | null>(null);
  const [adv, setAdv] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listAllTravel(status).then(setRows).catch((e) => { setRows([]); setError(errText(e, "Could not load trips.")); }); }, [status]);
  useEffect(load, [load]);

  async function issue(t: TravelRequestView) {
    setError(null);
    try { await api.issueTravelAdvance(t.id, { amount: Number(adv) }); setOpen(null); setAdv(""); setNotice(`Advance for ${t.destination} queued for the next payroll.`); load(); } catch (e) { setError(errText(e, "Could not issue the advance.")); }
  }
  return (
    <div>
      {notice && <div role="status" className="text-sm bg-accent/10 text-accent rounded p-2 mb-3">{notice}</div>}
      {error && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}
      <div className="mb-3 max-w-xs">
        <label className={lbl} htmlFor="tm-status">Show</label>
        <select id="tm-status" className={field} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All trips</option>
          {Object.entries(STATUS_BADGE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      {rows === null ? <LoadingNote what="trips" /> : rows.length === 0 ? <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">No trips to show.</div> : (
        <ul className="space-y-3" aria-label="All trips">
          {rows.map((t) => (
            <TripCard key={t.id} t={t}>
              {t.status === "approved" && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {t.advanceAmount === 0 && t.advanceRequested > 0 && <button type="button" onClick={() => { setOpen({ id: t.id, mode: "advance" }); setAdv(String(t.advanceRequested)); }} className={`${btn} border border-black/10 bg-white`}>Pay advance</button>}
                  {t.startDate <= new Date().toISOString().slice(0, 10) && <button type="button" onClick={() => setOpen({ id: t.id, mode: "settle" })} className={`${btn} border border-black/10 bg-white`}>Settle</button>}
                </div>
              )}
              {open?.id === t.id && open.mode === "advance" && (
                <div className="flex items-end gap-2 mt-3">
                  <div><label className={lbl} htmlFor={`adv-${t.id}`}>Advance (PKR)</label><input id={`adv-${t.id}`} inputMode="decimal" className={field} value={adv} onChange={(e) => setAdv(e.target.value)} /></div>
                  <button type="button" onClick={() => issue(t)} className={`${btn} bg-accent text-white`}>Queue for payroll</button>
                </div>
              )}
              {open?.id === t.id && open.mode === "settle" && <SettleForm t={t} onDone={(v) => { setOpen(null); setNotice(`Trip to ${v.destination} settled: ${balanceText(v.settlement?.netAmount ?? 0)}.`); load(); }} />}
            </TripCard>
          ))}
        </ul>
      )}
    </div>
  );
}

function Rates() {
  const [rates, setRates] = useState<TravelRateView[] | null>(null);
  const [f, setF] = useState({ name: "", rateKind: "per_diem" as TravelRateKind, tripType: "domestic" as TravelTripType, amount: "" });
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api.listTravelRates().then(setRates).catch(() => setRates([])); }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try { await api.saveTravelRate(null, { name: f.name.trim(), rateKind: f.rateKind, tripType: f.tripType, amount: Number(f.amount) }); setF({ ...f, name: "", amount: "" }); load(); } catch (x) { setErr(errText(x, "Could not save this rate.")); }
  }
  async function toggle(r: TravelRateView) {
    setErr(null);
    try { await api.saveTravelRate(r.id, { name: r.name, rateKind: r.rateKind, tripType: r.tripType, amount: r.amount, isActive: !r.isActive }); load(); } catch (x) { setErr(errText(x, "Could not change this rate.")); }
  }
  return (
    <div>
      <p className="text-sm text-label-secondary mb-3">These are your company's own rates. The newest active rate for each kind and trip type is used for estimates and settlements.</p>
      {err && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2 mb-3">{err}</div>}
      <form onSubmit={add} className="bg-card rounded-card shadow-sm p-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end mb-4" aria-label="Add a rate">
        <div><label className={lbl} htmlFor="rt-name">Name</label><input id="rt-name" required className={field} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className={lbl} htmlFor="rt-kind">Kind</label><select id="rt-kind" className={field} value={f.rateKind} onChange={(e) => setF({ ...f, rateKind: e.target.value as TravelRateKind })}><option value="per_diem">Per diem (per day)</option><option value="mileage">Mileage (per km)</option></select></div>
        <div><label className={lbl} htmlFor="rt-trip">Trip</label><select id="rt-trip" className={field} value={f.tripType} onChange={(e) => setF({ ...f, tripType: e.target.value as TravelTripType })}>{(Object.keys(TRIP_LABEL) as TravelTripType[]).map((k) => <option key={k} value={k}>{TRIP_LABEL[k]}</option>)}</select></div>
        <div><label className={lbl} htmlFor="rt-amt">Amount (PKR)</label><input id="rt-amt" required inputMode="decimal" className={field} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
        <button type="submit" className={`${btn} bg-accent text-white`}>Add rate</button>
      </form>
      {rates === null ? <LoadingNote what="rates" /> : rates.length === 0 ? <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">No rates yet. Without a per diem or mileage rate, those parts of a settlement are zero.</div> : (
        <div className="bg-card rounded-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm" aria-label="Rates">
            <thead><tr className="text-left text-xs text-label-tertiary"><th className="p-3">Name</th><th className="p-3">Kind</th><th className="p-3">Trip</th><th className="p-3">Amount</th><th className="p-3">Status</th></tr></thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} className="border-t border-black/5">
                  <td className="p-3">{r.name}</td><td className="p-3">{r.rateKind === "per_diem" ? "Per day" : "Per km"}</td><td className="p-3">{TRIP_LABEL[r.tripType]}</td><td className="p-3 tabular-nums">{pkr(r.amount)}</td>
                  <td className="p-3"><button type="button" onClick={() => toggle(r)} className="text-accent hover:underline">{r.isActive ? "In use · turn off" : "Off · turn on"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Business travel: ask to travel, approve a team's trips, and (HR) pay advances, settle trips and keep the per-diem and mileage rates. */
export function TravelPage() {
  const { identity } = useAuth();
  const roles = identity?.roleKeys ?? [];
  const isHr = roles.includes("hr_admin");
  const canApprove = isHr || roles.includes("line_manager");
  const [tab, setTab] = useState<Tab>("mine");
  const [section, setSection] = useState<"trips" | "rates">("trips");
  const tabs = useMemo(() => [{ k: "mine" as Tab, t: "My trips" }, ...(canApprove ? [{ k: "approvals" as Tab, t: "Approvals" }] : []), ...(isHr ? [{ k: "manage" as Tab, t: "All trips and rates" }] : [])], [canApprove, isHr]);
  return (
    <div>
      <PageHeader title="Business Travel" subtitle="Ask to travel, get it approved, take an advance and settle the trip when you are back." />
      <div role="tablist" className="flex gap-1 border-b border-black/10 mb-4">
        {tabs.map(({ k, t }) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={`px-3 py-2 text-sm font-semibold -mb-px border-b-2 ${tab === k ? "border-accent text-accent" : "border-transparent text-label-secondary"}`}>{t}</button>
        ))}
      </div>
      {tab === "mine" && <MyTrips employeeId={identity?.employeeId ?? null} />}
      {tab === "approvals" && <Approvals />}
      {tab === "manage" && (
        <div>
          <div className="flex gap-3 mb-3 text-sm">
            <button type="button" onClick={() => setSection("trips")} className={section === "trips" ? "font-semibold text-accent" : "text-label-secondary"}>Trips</button>
            <button type="button" onClick={() => setSection("rates")} className={section === "rates" ? "font-semibold text-accent" : "text-label-secondary"}>Rates</button>
          </div>
          {section === "trips" ? <ManageTrips /> : <Rates />}
        </div>
      )}
    </div>
  );
}
