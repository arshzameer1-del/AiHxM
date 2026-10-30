import { FormEvent, useCallback, useEffect, useState } from "react";
import type { HelpdeskCategoryView, HelpdeskSummaryView, HelpdeskTicketView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";
import { HelpdeskThread } from "./HelpdeskPage";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";
const FILTERS = [["", "Open"], ["overdue", "Overdue"], ["waiting_on_employee", "Waiting on employee"], ["resolved", "Resolved"]] as const;

function age(h: number) { return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`; }

/** HR: the queue (oldest and overdue first), replies, and the first-reply target for each category. */
export function HelpdeskAdminPage() {
  const [filter, setFilter] = useState("");
  const [queue, setQueue] = useState<HelpdeskTicketView[] | null>(null);
  const [summary, setSummary] = useState<HelpdeskSummaryView | null>(null);
  const [cats, setCats] = useState<HelpdeskCategoryView[]>([]);
  const [open, setOpen] = useState<HelpdeskTicketView | null>(null);
  const [newCat, setNewCat] = useState({ name: "", sla: "" });
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "That did not work.");

  const load = useCallback(() => {
    api.getHelpdeskQueue(filter || undefined).then(setQueue).catch((e) => { setQueue([]); fail(e); });
    api.getHelpdeskSummary().then(setSummary).catch(() => setSummary(null));
  }, [filter]);
  useEffect(load, [load]);
  useEffect(() => { api.listHelpdeskCategoriesAdmin().then(setCats).catch(() => setCats([])); }, []);

  async function addCat(e: FormEvent) {
    e.preventDefault();
    try { setCats(await api.saveHelpdeskCategory({ name: newCat.name, slaHours: newCat.sla ? Number(newCat.sla) : null })); setNewCat({ name: "", sla: "" }); } catch (err) { fail(err); }
  }

  return (
    <div data-testid="helpdesk-admin">
      <PageHeader title="HR help desk" subtitle="Questions from employees. The clock counts calendar hours to the first reply and only measures; nothing is escalated on its own." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5" data-testid="hd-summary">
          {([["Open", summary.open], ["Waiting on employee", summary.waitingOnEmployee], ["Overdue", summary.overdue], ["Resolved (30 days)", summary.resolvedLast30Days], ["Avg first reply", summary.averageFirstResponseHours === null ? "—" : `${summary.averageFirstResponseHours}h`]] as const).map(([l, v]) => (
            <div key={l} className="bg-card rounded-card p-3 shadow-sm"><div className="text-xs text-label-tertiary">{l}</div><div className="text-xl font-semibold tabular-nums">{v}</div></div>
          ))}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap">{FILTERS.map(([k, l]) => <button key={k} type="button" className={filter === k ? btn : quiet} onClick={() => setFilter(k)}>{l}</button>)}</div>
          {queue === null ? <LoadingNote what="the queue" /> : queue.length === 0 ? <p className="text-sm text-label-tertiary" data-testid="hd-empty">Nothing here.</p> : (
            <ul className="space-y-2" data-testid="hd-queue">
              {queue.map((t) => (
                <li key={t.id}><button type="button" className="w-full text-left bg-card rounded-card p-3 shadow-sm" onClick={() => api.getHelpdeskTicket(t.id).then(setOpen).catch(fail)}>
                  <div className="flex items-center gap-2"><span className="text-sm font-medium flex-1">{t.subject}</span>
                    {t.responseOverdue && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">Overdue</span>}</div>
                  <div className="text-xs text-label-tertiary">{t.employeeName}{t.categoryName ? ` · ${t.categoryName}` : ""} · open {age(t.ageHours)}{t.respondBy && !t.firstResponseAt ? ` · reply by ${formatDateTime(t.respondBy)}` : ""}</div>
                </button></li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-6">
          {open && (
            <div className="bg-card rounded-card p-4 shadow-sm">
              <h2 className="font-semibold">{open.subject}</h2>
              <p className="text-xs text-label-tertiary mb-3">{open.employeeName} · {open.status.replace(/_/g, " ")}</p>
              <HelpdeskThread ticket={open} resolveLabel="Resolve"
                onReply={async (b) => { setOpen(await api.replyHelpdeskTicket(open.id, b)); load(); }}
                onResolve={async () => { setOpen(await api.resolveHelpdeskTicket(open.id)); load(); }} />
            </div>
          )}
          <div className="bg-card rounded-card p-4 shadow-sm space-y-3" data-testid="hd-categories">
            <h2 className="font-semibold">Categories and first-reply targets</h2>
            <p className="text-xs text-label-tertiary">Leave the hours empty for no clock. Nothing is added unless you add it.</p>
            {cats.length === 0 && <button type="button" className={quiet} onClick={() => api.addStarterHelpdeskCategories().then(setCats).catch(fail)}>Add suggested categories</button>}
            <ul className="space-y-1">
              {cats.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-sm"><span className="flex-1">{c.name}{!c.isActive && " (hidden)"}</span>
                  <label className="text-xs text-label-tertiary" htmlFor={`sla-${c.id}`}>hours</label>
                  <input id={`sla-${c.id}`} type="number" min={1} max={720} className="w-20 rounded-lg border border-black/10 px-2 py-1 text-sm" defaultValue={c.slaHours ?? ""}
                    onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== c.slaHours) api.saveHelpdeskCategory({ id: c.id, name: c.name, slaHours: v }).then(setCats).catch(fail); }} />
                  <button type="button" className="text-xs text-accent" onClick={() => api.saveHelpdeskCategory({ id: c.id, name: c.name, slaHours: c.slaHours, isActive: !c.isActive }).then(setCats).catch(fail)}>{c.isActive ? "Hide" : "Show"}</button>
                </li>
              ))}
            </ul>
            <form onSubmit={addCat} className="flex gap-2 items-end">
              <div className="flex-1"><label htmlFor="hd-newcat" className="block text-xs text-label-secondary mb-1">New category</label><input id="hd-newcat" className={field} value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} maxLength={60} required /></div>
              <div className="w-24"><label htmlFor="hd-newsla" className="block text-xs text-label-secondary mb-1">Reply in (h)</label><input id="hd-newsla" type="number" min={1} max={720} className={field} value={newCat.sla} onChange={(e) => setNewCat({ ...newCat, sla: e.target.value })} /></div>
              <button type="submit" className={btn}>Add</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
