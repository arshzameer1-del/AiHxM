import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AssetCategory, AssetCondition, AssetDetailView, AssetDisposalMethod, AssetSummaryView, AssetView, EmployeeView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import {
  ACTIONS_BY_STATUS, ACTION_LABEL, CATEGORY_LABEL, CONDITION_LABEL, DISPOSAL_LABEL, EVENT_LABEL, STATUS_LABEL, formatPkr, type AssetAction,
} from "./assetUi";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
const lbl = "block text-xs font-medium text-label-secondary mb-1";
const btn = "rounded-lg px-3 py-1.5 text-sm font-semibold";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "warn" }) {
  return (
    <div className="bg-card rounded-card shadow-sm px-4 py-3">
      <p className="text-xs text-label-tertiary">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone === "warn" && Number(value) > 0 ? "text-warning" : ""}`}>{value}</p>
    </div>
  );
}

function AddAssetForm({ onDone, onCancel }: { onDone: (a: AssetDetailView) => void; onCancel: () => void }) {
  const [f, setF] = useState({ assetTag: "", name: "", category: "laptop" as AssetCategory, serialNumber: "", vendor: "", purchaseDate: "", purchaseCost: "", warrantyUntil: "", location: "", notes: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const a = await api.createAsset({
        assetTag: f.assetTag.trim(), name: f.name.trim(), category: f.category, serialNumber: f.serialNumber || null, vendor: f.vendor || null,
        purchaseDate: f.purchaseDate || null, purchaseCost: f.purchaseCost ? Number(f.purchaseCost) : null, warrantyUntil: f.warrantyUntil || null, location: f.location || null, notes: f.notes || null,
      });
      onDone(a);
    } catch (x) {
      setErr(errText(x, "Could not add this asset."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-card rounded-card shadow-sm p-4 space-y-3 mb-4" aria-label="Add an asset">
      <h2 className="text-base font-semibold">Add an asset</h2>
      {err && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2">{err}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div><label className={lbl} htmlFor="as-tag">Asset tag</label><input id="as-tag" required maxLength={60} className={field} value={f.assetTag} onChange={set("assetTag")} /></div>
        <div><label className={lbl} htmlFor="as-name">Name</label><input id="as-name" required maxLength={160} className={field} value={f.name} onChange={set("name")} placeholder="Dell Latitude 5440" /></div>
        <div>
          <label className={lbl} htmlFor="as-cat">Category</label>
          <select id="as-cat" className={field} value={f.category} onChange={set("category")}>
            {(Object.keys(CATEGORY_LABEL) as AssetCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </div>
        <div><label className={lbl} htmlFor="as-serial">Serial number</label><input id="as-serial" className={field} value={f.serialNumber} onChange={set("serialNumber")} /></div>
        <div><label className={lbl} htmlFor="as-vendor">Vendor</label><input id="as-vendor" className={field} value={f.vendor} onChange={set("vendor")} /></div>
        <div><label className={lbl} htmlFor="as-loc">Location</label><input id="as-loc" className={field} value={f.location} onChange={set("location")} /></div>
        <div><label className={lbl} htmlFor="as-pd">Purchase date</label><input id="as-pd" type="date" className={field} value={f.purchaseDate} onChange={set("purchaseDate")} /></div>
        <div><label className={lbl} htmlFor="as-pc">Purchase cost (PKR)</label><input id="as-pc" inputMode="decimal" className={field} value={f.purchaseCost} onChange={set("purchaseCost")} /></div>
        <div><label className={lbl} htmlFor="as-wu">Warranty until</label><input id="as-wu" type="date" className={field} value={f.warrantyUntil} onChange={set("warrantyUntil")} /></div>
      </div>
      <div><label className={lbl} htmlFor="as-notes">Notes</label><textarea id="as-notes" rows={2} maxLength={1000} className={field} value={f.notes} onChange={set("notes")} /></div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${btn} bg-accent text-white disabled:opacity-50`}>{busy ? "Adding…" : "Add asset"}</button>
        <button type="button" onClick={onCancel} className={`${btn} bg-black/5`}>Cancel</button>
      </div>
    </form>
  );
}

function ActionForm({ asset, action, employees, onDone, onCancel }: { asset: AssetDetailView; action: AssetAction; employees: EmployeeView[]; onDone: (a: AssetDetailView) => void; onCancel: () => void }) {
  const [employeeId, setEmployeeId] = useState("");
  const [condition, setCondition] = useState<AssetCondition | "">("");
  const [note, setNote] = useState("");
  const [cost, setCost] = useState("");
  const [disposal, setDisposal] = useState<AssetDisposalMethod>("sold");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsPerson = action === "assign" || action === "transfer";
  const people = employees.filter((e) => e.id !== asset.holderId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (needsPerson && !employeeId) { setErr("Choose an employee."); return; }
    setBusy(true);
    const base = { note: note.trim() || undefined };
    try {
      let out: AssetDetailView;
      if (action === "assign") out = await api.assignAsset(asset.id, { employeeId, condition: condition || undefined, ...base });
      else if (action === "transfer") out = await api.transferAsset(asset.id, { employeeId, condition: condition || undefined, ...base });
      else if (action === "return") out = await api.returnAsset(asset.id, { condition: condition || undefined, ...base });
      else if (action === "maintenance_start") out = await api.assetMaintenance(asset.id, "start", base);
      else if (action === "maintenance_complete") out = await api.assetMaintenance(asset.id, "complete", { ...base, cost: cost ? Number(cost) : null });
      else if (action === "lost") out = await api.markAssetLost(asset.id, base);
      else if (action === "found") out = await api.markAssetFound(asset.id, base);
      else out = await api.retireAsset(asset.id, { disposalMethod: disposal, disposalValue: value ? Number(value) : null, ...base });
      onDone(out);
    } catch (x) {
      setErr(errText(x, "Could not save this."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-black/5 rounded-lg p-3 space-y-3 mt-3" aria-label={ACTION_LABEL[action]}>
      <h3 className="text-sm font-semibold">{ACTION_LABEL[action]}</h3>
      {err && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2">{err}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {needsPerson && (
          <div>
            <label className={lbl} htmlFor="act-emp">Employee</label>
            <select id="act-emp" className={field} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeNumber})</option>)}
            </select>
          </div>
        )}
        {(needsPerson || action === "return") && (
          <div>
            <label className={lbl} htmlFor="act-cond">Condition</label>
            <select id="act-cond" className={field} value={condition} onChange={(e) => setCondition(e.target.value as AssetCondition | "")}>
              <option value="">Not recorded</option>
              {(Object.keys(CONDITION_LABEL) as AssetCondition[]).map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
            </select>
            {action === "return" && <p className="text-[11px] text-label-tertiary mt-1">A damaged asset goes to maintenance instead of back on the shelf.</p>}
          </div>
        )}
        {action === "maintenance_complete" && (
          <div><label className={lbl} htmlFor="act-cost">Repair cost (PKR)</label><input id="act-cost" inputMode="decimal" className={field} value={cost} onChange={(e) => setCost(e.target.value)} /></div>
        )}
        {action === "retire" && (
          <>
            <div>
              <label className={lbl} htmlFor="act-disp">How did it leave the company?</label>
              <select id="act-disp" className={field} value={disposal} onChange={(e) => setDisposal(e.target.value as AssetDisposalMethod)}>
                {(Object.keys(DISPOSAL_LABEL) as AssetDisposalMethod[]).map((d) => <option key={d} value={d}>{DISPOSAL_LABEL[d]}</option>)}
              </select>
            </div>
            <div><label className={lbl} htmlFor="act-val">Amount received (PKR)</label><input id="act-val" inputMode="decimal" className={field} value={value} onChange={(e) => setValue(e.target.value)} /></div>
          </>
        )}
      </div>
      <div><label className={lbl} htmlFor="act-note">Note</label><input id="act-note" maxLength={1000} className={field} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${btn} bg-accent text-white disabled:opacity-50`}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel} className={`${btn} bg-white border border-black/10`}>Cancel</button>
      </div>
    </form>
  );
}

function AssetDetail({ asset, employees, onChange, onClose }: { asset: AssetDetailView; employees: EmployeeView[]; onChange: (a: AssetDetailView) => void; onClose: () => void }) {
  const [action, setAction] = useState<AssetAction | null>(null);
  const st = STATUS_LABEL[asset.status];
  return (
    <section className="bg-card rounded-card shadow-sm p-4 mb-4" aria-label={`Asset ${asset.assetTag}`} data-testid="asset-detail">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{asset.name} <span className="text-label-tertiary font-normal">· {asset.assetTag}</span></h2>
          <p className="text-xs text-label-tertiary mt-0.5">
            {CATEGORY_LABEL[asset.category]}{asset.serialNumber ? ` · Serial ${asset.serialNumber}` : ""}{asset.location ? ` · ${asset.location}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${st.cls}`}>{st.label}</span>
          <button type="button" onClick={onClose} className={`${btn} bg-black/5`}>Close</button>
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm mt-3">
        <div><dt className="text-xs text-label-tertiary">With</dt><dd>{asset.holderName ? `${asset.holderName} (${asset.holderNumber})` : "No one"}</dd></div>
        <div><dt className="text-xs text-label-tertiary">Bought</dt><dd>{asset.purchaseDate ? formatDay(asset.purchaseDate) : "Not recorded"}{asset.purchaseCost !== null ? ` · ${formatPkr(asset.purchaseCost)}` : ""}</dd></div>
        <div><dt className="text-xs text-label-tertiary">Warranty</dt><dd className={asset.warrantyExpired ? "text-danger" : ""}>{asset.warrantyUntil ? `${asset.warrantyExpired ? "Ended " : "Until "}${formatDay(asset.warrantyUntil)}` : "Not recorded"}</dd></div>
        <div><dt className="text-xs text-label-tertiary">Last seen in stock-take</dt><dd>{asset.lastVerifiedOn ? formatDay(asset.lastVerifiedOn) : "Never"}</dd></div>
        {asset.status === "retired" && (
          <div className="col-span-2"><dt className="text-xs text-label-tertiary">Retired</dt><dd>{formatDay(asset.retiredOn)} · {asset.disposalMethod ? DISPOSAL_LABEL[asset.disposalMethod] : ""}{asset.disposalValue !== null ? ` · ${formatPkr(asset.disposalValue)}` : ""}</dd></div>
        )}
      </dl>

      {ACTIONS_BY_STATUS[asset.status].length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4">
          {ACTIONS_BY_STATUS[asset.status].map((a) => (
            <button key={a} type="button" onClick={() => setAction(a)} className={`${btn} border border-black/10 bg-white hover:bg-black/5 ${action === a ? "ring-2 ring-accent" : ""}`}>{ACTION_LABEL[a]}</button>
          ))}
        </div>
      )}
      {action && <ActionForm asset={asset} action={action} employees={employees} onCancel={() => setAction(null)} onDone={(a) => { setAction(null); onChange(a); }} />}

      <h3 className="text-sm font-semibold mt-5 mb-2">History</h3>
      <ul className="divide-y divide-black/5 text-sm" aria-label="Asset history">
        {asset.history.map((h) => (
          <li key={h.id} className="py-2 flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="font-medium">{EVENT_LABEL[h.eventType]}</span>
            {h.employeeName && <span>{h.fromEmployeeName ? `${h.fromEmployeeName} → ` : ""}{h.employeeName}</span>}
            {h.condition && <span className="text-label-tertiary">Condition: {CONDITION_LABEL[h.condition]}</span>}
            {h.cost !== null && <span className="text-label-tertiary">{formatPkr(h.cost)}</span>}
            {h.acknowledgedAt && <span className="text-accent">Receipt confirmed</span>}
            {h.note && <span className="text-label-secondary">“{h.note}”</span>}
            <span className="text-label-tertiary ml-auto">{formatDay(h.occurredOn)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** HR: the company asset register. Add assets, issue and take them back, send for repair, record loss and disposal, run a stock-take. */
export function AssetRegisterPage() {
  const [rows, setRows] = useState<AssetView[] | null>(null);
  const [summary, setSummary] = useState<AssetSummaryView | null>(null);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<AssetDetailView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listAssets({ status, category, q: q.trim() }).then(setRows).catch((e) => { setRows([]); setError(errText(e, "Could not load the asset register.")); });
    api.getAssetSummary().then(setSummary).catch(() => setSummary(null));
  }, [status, category, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { api.listEmployees().then(setEmployees).catch(() => setEmployees([])); }, []);

  const visible = useMemo(() => rows ?? [], [rows]);

  async function show(id: string) {
    setError(null);
    try { setOpen(await api.getAsset(id)); } catch (e) { setError(errText(e, "Could not open this asset.")); }
  }
  function changed(a: AssetDetailView, msg: string) {
    setOpen(a);
    setNotice(msg);
    load();
  }
  async function stockTake() {
    setError(null);
    try {
      const r = await api.verifyAssets([...picked]);
      setPicked(new Set());
      setNotice(`${r.verified} asset${r.verified === 1 ? "" : "s"} marked as seen today.`);
      load();
    } catch (e) { setError(errText(e, "Could not record the stock-take.")); }
  }
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <PageHeader
        title="Asset Register"
        subtitle="Laptops, phones, vehicles and everything else the company lends out: who has what, and what happened to it."
        actions={<button type="button" onClick={() => setAdding(true)} className={`${btn} bg-accent text-white`}>Add asset</button>}
      />
      {notice && <div role="status" className="text-sm bg-accent/10 text-accent rounded p-2 mb-3">{notice}</div>}
      {error && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4" aria-label="Asset summary">
          <Stat label="Assets" value={summary.total} />
          <Stat label="Issued" value={summary.byStatus.assigned} />
          <Stat label="In stock" value={summary.byStatus.in_stock} />
          <Stat label="In maintenance" value={summary.byStatus.under_maintenance} tone="warn" />
          <Stat label="Warranty ends within 60 days" value={summary.warrantyExpiringSoon} tone="warn" />
          <Stat label="Not seen in a year" value={summary.notVerifiedInYear} tone="warn" />
        </div>
      )}

      {adding && <AddAssetForm onCancel={() => setAdding(false)} onDone={(a) => { setAdding(false); changed(a, `${a.assetTag} added to the register.`); }} />}
      {open && <AssetDetail asset={open} employees={employees} onClose={() => setOpen(null)} onChange={(a) => changed(a, "Saved.")} />}

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div><label className={lbl} htmlFor="f-q">Search</label><input id="f-q" className={field} placeholder="Tag, name or serial" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div>
          <label className={lbl} htmlFor="f-status">Status</label>
          <select id="f-status" className={field} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl} htmlFor="f-cat">Category</label>
          <select id="f-cat" className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {picked.size > 0 && <button type="button" onClick={stockTake} className={`${btn} border border-black/10 bg-white`}>Mark {picked.size} as seen today</button>}
      </div>

      {rows === null ? (
        <LoadingNote what="assets" />
      ) : visible.length === 0 ? (
        <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">{q || status || category ? "No asset matches this search." : "No assets yet. Add the first one to start the register."}</div>
      ) : (
        <div className="bg-card rounded-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm" aria-label="Assets">
            <thead>
              <tr className="text-left text-xs text-label-tertiary">
                <th className="p-3 w-8"><span className="sr-only">Select for stock-take</span></th>
                <th className="p-3">Tag</th><th className="p-3">Name</th><th className="p-3">Category</th><th className="p-3">Status</th><th className="p-3">With</th><th className="p-3">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id} className="border-t border-black/5 hover:bg-black/[0.03]">
                  <td className="p-3">{a.status !== "retired" && <input type="checkbox" aria-label={`Select ${a.assetTag}`} checked={picked.has(a.id)} onChange={() => toggle(a.id)} />}</td>
                  <td className="p-3 font-medium"><button type="button" className="text-accent hover:underline" onClick={() => show(a.id)}>{a.assetTag}</button></td>
                  <td className="p-3">{a.name}</td>
                  <td className="p-3">{CATEGORY_LABEL[a.category]}</td>
                  <td className="p-3"><span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${STATUS_LABEL[a.status].cls}`}>{STATUS_LABEL[a.status].label}</span></td>
                  <td className="p-3">{a.holderName ?? <span className="text-label-tertiary">—</span>}</td>
                  <td className="p-3 text-label-tertiary">{a.lastVerifiedOn ? formatDay(a.lastVerifiedOn) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
