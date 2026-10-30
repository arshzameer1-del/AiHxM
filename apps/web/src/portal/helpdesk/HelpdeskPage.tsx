import { FormEvent, useCallback, useEffect, useState } from "react";
import type { HelpdeskCategoryView, HelpdeskTicketView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";
const STATUS_LABEL = { open: "Waiting for HR", waiting_on_employee: "HR replied", resolved: "Resolved" } as const;

function Thread({ ticket, onReply, onResolve, resolveLabel }: { ticket: HelpdeskTicketView; onReply: (body: string) => Promise<void>; onResolve: () => Promise<void>; resolveLabel: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await onReply(body); setBody(""); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3" data-testid="hd-thread">
      <ul className="space-y-2">
        {(ticket.messages ?? []).map((m) => (
          <li key={m.id} className={`rounded-lg p-3 text-sm ${m.fromHr ? "bg-accent/10" : "bg-black/5"}`}>
            <div className="text-xs text-label-tertiary mb-1">{m.authorName} · {formatDateTime(m.createdAt)}</div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </li>
        ))}
      </ul>
      <form onSubmit={send} className="space-y-2">
        <label htmlFor="hd-reply" className="sr-only">Reply</label>
        <textarea id="hd-reply" className={field} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a reply" required />
        <div className="flex gap-2">
          <button type="submit" className={btn} disabled={busy || !body.trim()}>Send reply</button>
          {ticket.status !== "resolved" && <button type="button" className={quiet} onClick={() => void onResolve()}>{resolveLabel}</button>}
        </div>
      </form>
    </div>
  );
}

/** Employees: ask HR a question and follow the answer. */
export function HelpdeskPage() {
  const [tickets, setTickets] = useState<HelpdeskTicketView[] | null>(null);
  const [cats, setCats] = useState<HelpdeskCategoryView[]>([]);
  const [open, setOpen] = useState<HelpdeskTicketView | null>(null);
  const [form, setForm] = useState({ categoryId: "", subject: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listMyHelpdeskTickets().then(setTickets).catch((e) => { setTickets([]); setError(e instanceof ApiError ? e.message : "Could not load your questions."); }); }, []);
  useEffect(() => { load(); api.listHelpdeskCategories().then(setCats).catch(() => setCats([])); }, [load]);

  async function raise(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const t = await api.raiseHelpdeskTicket({ categoryId: form.categoryId || null, subject: form.subject, body: form.body });
      setForm({ categoryId: "", subject: "", body: "" });
      setOpen(t);
      load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not send your question."); }
  }
  const show = (id: string) => api.getMyHelpdeskTicket(id).then(setOpen).catch((e) => setError(e instanceof ApiError ? e.message : "Could not open it."));

  return (
    <div data-testid="helpdesk">
      <PageHeader title="Ask HR" subtitle="Ask a question and follow the answer here." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <form onSubmit={raise} className="bg-card rounded-card p-4 shadow-sm space-y-3">
            {cats.length > 0 && (
              <div><label htmlFor="hd-cat" className="block text-xs font-medium text-label-secondary mb-1">About</label>
                <select id="hd-cat" className={field} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  <option value="">Not sure</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></div>
            )}
            <div><label htmlFor="hd-subject" className="block text-xs font-medium text-label-secondary mb-1">Title</label><input id="hd-subject" className={field} maxLength={200} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required /></div>
            <div><label htmlFor="hd-body" className="block text-xs font-medium text-label-secondary mb-1">Your question</label><textarea id="hd-body" className={field} rows={4} maxLength={4000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></div>
            <button type="submit" className={btn}>Send to HR</button>
          </form>
          {tickets === null ? <LoadingNote what="your questions" /> : tickets.length === 0 ? <p className="text-sm text-label-tertiary">You have not asked anything yet.</p> : (
            <ul className="space-y-2" data-testid="hd-mine">
              {tickets.map((t) => (
                <li key={t.id}><button type="button" onClick={() => void show(t.id)} className="w-full text-left bg-card rounded-card p-3 shadow-sm">
                  <div className="text-sm font-medium">{t.subject}</div>
                  <div className="text-xs text-label-tertiary">{STATUS_LABEL[t.status]}{t.categoryName ? ` · ${t.categoryName}` : ""} · {formatDateTime(t.createdAt)}</div>
                </button></li>
              ))}
            </ul>
          )}
        </div>
        <div>
          {open && (
            <div className="bg-card rounded-card p-4 shadow-sm">
              <h2 className="font-semibold mb-1">{open.subject}</h2>
              <p className="text-xs text-label-tertiary mb-3">{STATUS_LABEL[open.status]}</p>
              <Thread ticket={open} resolveLabel="Mark as resolved"
                onReply={async (b) => { setOpen(await api.replyHelpdeskTicket(open.id, b)); load(); }}
                onResolve={async () => { setOpen(await api.resolveHelpdeskTicket(open.id)); load(); }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { Thread as HelpdeskThread };
