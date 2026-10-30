import { FormEvent, useCallback, useEffect, useState } from "react";
import type { ColleagueView, RecognitionView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";

/** A company-wide thank-you feed. Words only: no points, no prizes, nothing paid. */
export function RecognitionPage() {
  const [feed, setFeed] = useState<RecognitionView[] | null>(null);
  const [canModerate, setCanModerate] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ColleagueView[]>([]);
  const [target, setTarget] = useState<ColleagueView | null>(null);
  const [message, setMessage] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getRecognitionFeed().then(setFeed).catch((e) => { setFeed([]); setError(e instanceof ApiError ? e.message : "Could not load the feed."); });
  }, []);
  useEffect(() => {
    load();
    api.canModerateRecognition().then((r) => setCanModerate(r.canModerate)).catch(() => setCanModerate(false));
  }, [load]);
  useEffect(() => {
    if (target || query.trim().length < 2) { setMatches([]); return; }
    const t = setTimeout(() => api.searchColleagues(query).then(setMatches).catch(() => setMatches([])), 250);
    return () => clearTimeout(t);
  }, [query, target]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.giveRecognition({ toEmployeeId: target.id, message, valueTag: tag || null });
      setNotice(`Your thank-you to ${target.name} is on the feed.`);
      setTarget(null); setQuery(""); setMessage(""); setTag("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="recognition">
      <PageHeader title="Recognition" subtitle="Thank a colleague. Everyone in the company can read these." />
      <form onSubmit={send} className="bg-card rounded-card p-4 shadow-sm space-y-3 mb-6 max-w-2xl">
        <div>
          <label htmlFor="rec-who" className="block text-xs font-medium text-label-secondary mb-1">Who do you want to thank?</label>
          {target ? (
            <div className="flex items-center gap-2 text-sm"><strong>{target.name}</strong><button type="button" className="text-accent text-xs" onClick={() => setTarget(null)}>change</button></div>
          ) : (
            <>
              <input id="rec-who" className={field} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing a name" autoComplete="off" />
              {matches.length > 0 && (
                <ul className="mt-1 rounded-lg border border-black/10 divide-y divide-black/5" data-testid="rec-matches">
                  {matches.map((m) => (<li key={m.id}><button type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-black/5" onClick={() => { setTarget(m); setMatches([]); }}>{m.name} <span className="text-label-tertiary">{m.employeeNumber}</span></button></li>))}
                </ul>
              )}
            </>
          )}
        </div>
        <div>
          <label htmlFor="rec-msg" className="block text-xs font-medium text-label-secondary mb-1">What are you thanking them for?</label>
          <textarea id="rec-msg" className={field} rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="rec-tag" className="block text-xs font-medium text-label-secondary mb-1">Tag (optional)</label>
          <input id="rec-tag" className={field} maxLength={40} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Teamwork, Customer care…" />
        </div>
        <button type="submit" className={btn} disabled={busy || !target || !message.trim()}>Send thank-you</button>
        {notice && <p className="text-sm text-accent" role="status">{notice}</p>}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </form>
      {feed === null ? <LoadingNote what="the feed" /> : feed.length === 0 ? (
        <p className="text-sm text-label-tertiary" data-testid="rec-empty">No thank-yous yet. Be the first.</p>
      ) : (
        <ul className="space-y-3 max-w-2xl" data-testid="rec-feed">
          {feed.map((r) => (
            <li key={r.id} className={`bg-card rounded-card p-4 shadow-sm ${r.mine ? "ring-1 ring-accent/30" : ""}`} data-testid="rec-item">
              <div className="text-sm"><strong>{r.fromName}</strong> thanked <strong>{r.toName}</strong>{r.valueTag && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-black/5">{r.valueTag}</span>}</div>
              <p className="text-sm mt-1 whitespace-pre-wrap">{r.message}</p>
              <div className="text-xs text-label-tertiary mt-2 flex gap-3">{formatDateTime(r.createdAt)}
                {canModerate && <button type="button" className="text-danger" onClick={() => api.hideRecognition(r.id).then(load).catch((e) => setError(e instanceof ApiError ? e.message : "Could not hide."))}>Hide</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
