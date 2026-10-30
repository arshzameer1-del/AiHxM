import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import type { AssistantAnswer } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { PageHeader } from "../shared/PageChrome";

const EXAMPLES = ["How many leaves do I have left?", "When is the next holiday?", "Who is my manager?", "Do I have anything to sign?", "Where is my payslip?"];

/** Quick answers from my own records. Fixed rules, not an AI chatbot; it shows what it can answer when it does not understand. */
export function AssistantPage() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Array<{ q: string; a: AssistantAnswer }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask(text: string) {
    setBusy(true);
    setError(null);
    try { const a = await api.askAssistant(text); setLog((l) => [{ q: text, a }, ...l]); setQ(""); } catch (err) { setError(err instanceof ApiError ? err.message : "Could not answer."); } finally { setBusy(false); }
  }
  return (
    <div data-testid="assistant">
      <PageHeader title="Quick answers" subtitle="Ask about your own leave, holidays, manager, payslips, surveys or documents. English or Roman Urdu. This is not an AI chatbot: it uses fixed rules and your own records." />
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (q.trim()) void ask(q); }} className="flex gap-2 max-w-2xl mb-3">
        <label htmlFor="qa-q" className="sr-only">Your question</label>
        <input id="qa-q" className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="Type a question" />
        <button type="submit" className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50" disabled={busy || !q.trim()}>Ask</button>
      </form>
      <div className="flex flex-wrap gap-2 mb-5">{EXAMPLES.map((e) => <button key={e} type="button" className="px-2.5 py-1 rounded-full bg-black/5 text-xs" onClick={() => void ask(e)}>{e}</button>)}</div>
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      <ul className="space-y-3 max-w-2xl" data-testid="qa-log">{log.map((l, i) => (
        <li key={i} className="bg-card rounded-card p-4 shadow-sm"><div className="text-xs text-label-tertiary mb-1">{l.q}</div><p className="text-sm">{l.a.answer}</p>{l.a.link && <Link to={l.a.link} className="text-sm text-accent mt-2 inline-block">{l.a.linkLabel ?? "Open"}</Link>}</li>))}</ul>
    </div>
  );
}
