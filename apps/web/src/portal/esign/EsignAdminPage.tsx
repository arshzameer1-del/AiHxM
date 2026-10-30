import { FormEvent, useCallback, useEffect, useState } from "react";
import type { EsignRequestView, NineBoxPerson } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay, formatDateTime } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";
const LABEL = { pending: "Waiting", signed: "Signed", declined: "Declined", cancelled: "Cancelled" } as const;

/** HR: send a text to people to read and sign, see who has, and check a receipt. */
export function EsignAdminPage() {
  const [items, setItems] = useState<EsignRequestView[] | null>(null);
  const [people, setPeople] = useState<NineBoxPerson[]>([]);
  const [form, setForm] = useState({ title: "", body: "", dueOn: "" });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const load = useCallback(() => { api.listEsign().then(setItems).catch((e) => { setItems([]); setError(e instanceof ApiError ? e.message : "Could not load."); }); }, []);
  useEffect(() => { load(); api.getNineBox().then((b) => setPeople(b.people)).catch(() => setPeople([])); }, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.createEsign({ title: form.title, body: form.body, employeeIds: [...chosen], dueOn: form.dueOn || null });
      setNotice(`Sent to ${r.created} ${r.created === 1 ? "person" : "people"}.`);
      setForm({ title: "", body: "", dueOn: "" }); setChosen(new Set()); load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not send."); }
  }
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div data-testid="esign-admin">
      <PageHeader title="Documents to sign" subtitle="Send a policy, letter or agreement text to people. Each person reads it and types their name to agree. This records agreement; it is not a certified digital signature, so ask your lawyer whether it is enough for a given document." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {notice && <p className="text-sm text-accent mb-3" role="status">{notice}</p>}
      <form onSubmit={send} className="bg-card rounded-card p-4 shadow-sm space-y-3 mb-6 max-w-3xl">
        <div><label htmlFor="es-title" className="block text-xs font-medium text-label-secondary mb-1">Title</label><input id="es-title" className={field} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} required /></div>
        <div><label htmlFor="es-body" className="block text-xs font-medium text-label-secondary mb-1">Text to read and agree to</label><textarea id="es-body" className={field} rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={20000} required /></div>
        <div><label htmlFor="es-due" className="block text-xs font-medium text-label-secondary mb-1">Sign by (optional)</label><input id="es-due" type="date" className={field} value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} /></div>
        <fieldset><legend className="text-xs font-medium text-label-secondary mb-1">Who should sign ({chosen.size} chosen)</legend>
          <div className="flex gap-2 mb-2"><button type="button" className={quiet} onClick={() => setChosen(new Set(people.map((p) => p.employeeId)))}>Everyone</button><button type="button" className={quiet} onClick={() => setChosen(new Set())}>Clear</button></div>
          <div className="max-h-48 overflow-y-auto grid sm:grid-cols-2 gap-1">{people.map((p) => (<label key={p.employeeId} className="text-sm flex items-center gap-2"><input type="checkbox" checked={chosen.has(p.employeeId)} onChange={() => toggle(p.employeeId)} />{p.employeeName} <span className="text-label-tertiary">{p.employeeNumber}</span></label>))}</div></fieldset>
        <button type="submit" className={btn} disabled={chosen.size === 0}>Send to {chosen.size || "…"} {chosen.size === 1 ? "person" : "people"}</button>
      </form>
      {items === null ? <LoadingNote what="documents" /> : items.length === 0 ? <p className="text-sm text-label-tertiary">Nothing sent yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="esign-table">
          <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3">Document</th><th className="pr-3">Person</th><th className="pr-3">Status</th><th className="pr-3">When</th><th /></tr></thead>
          <tbody>{items.map((d) => (
            <tr key={d.id} className="border-t border-black/5"><td className="py-1.5 pr-3">{d.title}</td><td className="pr-3">{d.employeeName}</td>
              <td className="pr-3">{LABEL[d.status]}{d.declineReason ? ` — ${d.declineReason}` : ""}</td>
              <td className="pr-3">{d.signedAt ? formatDateTime(d.signedAt) : d.dueOn ? `due ${formatDay(d.dueOn)}` : ""}</td>
              <td className="space-x-2 whitespace-nowrap">
                {d.status === "pending" && <button type="button" className="text-xs text-danger" onClick={() => api.cancelEsign(d.id).then(load).catch((e) => setError(e instanceof ApiError ? e.message : "Could not cancel."))}>Cancel</button>}
                {d.status === "signed" && <button type="button" className="text-xs text-accent" onClick={() => api.verifyEsign(d.id).then((v) => setVerified({ ...verified, [d.id]: v.valid })).catch(() => setError("Could not check."))}>{verified[d.id] === undefined ? "Check receipt" : verified[d.id] ? "Receipt matches" : "Receipt does NOT match"}</button>}
              </td></tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}
