import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DelegateCandidateView, DelegationView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay, todayIso } from "../shared/dates";
import { delegationState } from "./delegation";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";
const todayKey = () => todayIso();

const STATE_BADGE = {
  active: { label: "Covering now", cls: "bg-accent/10 text-accent" },
  upcoming: { label: "Starts later", cls: "bg-warning/15 text-warning" },
  ended: { label: "Ended", cls: "bg-black/5 text-label-tertiary" },
  revoked: { label: "Cancelled", cls: "bg-black/5 text-label-tertiary" },
} as const;

/**
 * BACKLOG53 - out of office: hand your approvals to a colleague for a period. While it is active they can decide everything
 * you could (leave, timesheets, corrections and the rest); every decision records who it was really made for.
 */
export function DelegationPage() {
  const [items, setItems] = useState<DelegationView[] | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<DelegateCandidateView[]>([]);
  const [chosen, setChosen] = useState<DelegateCandidateView | null>(null);
  const [from, setFrom] = useState(todayKey());
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("Out of office");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayKey();

  const load = useCallback(() => {
    api.listMyDelegations().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (chosen || query.trim().length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => api.searchDelegateCandidates(query.trim()).then(setMatches).catch(() => setMatches([])), 250);
    return () => clearTimeout(t);
  }, [query, chosen]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!chosen) return setError("Choose who will cover for you.");
    if (!to) return setError("Say when you are back.");
    if (to < from) return setError("The end date cannot be before the start date.");
    if (!reason.trim()) return setError("Add a short reason.");
    setBusy(true);
    try {
      await api.createDelegation({ delegateUserAccountId: chosen.userAccountId, validFrom: from, validTo: to, reason: reason.trim() });
      setNotice(`${chosen.name} can now approve for you from ${formatDay(from)} to ${formatDay(to)}.`);
      setChosen(null);
      setQuery("");
      setTo("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the cover arrangement.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.revokeDelegation(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel it.");
    }
  }

  const given = (items ?? []).filter((d) => d.direction === "given");
  const received = (items ?? []).filter((d) => d.direction === "received");

  return (
    <div data-testid="delegation-page">
      <PageHeader
        title="Out of office"
        subtitle="Choose a colleague to approve in your place while you are away. You stay responsible for what they decide; each decision shows it was made on your behalf."
        actions={<Link to="/app/approvals" className="text-sm font-semibold text-accent hover:underline">Back to approvals</Link>}
      />
      <form onSubmit={submit} className="bg-card rounded-card p-5 shadow-sm mb-5 space-y-3" aria-label="Cover arrangement">
        <div>
          <label htmlFor="dlg-who" className={label}>Who covers for you?</label>
          {chosen ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 text-sm">
              <span>{chosen.name} · {chosen.employeeNumber}{chosen.designation ? ` · ${chosen.designation}` : ""}</span>
              <button type="button" className="text-xs font-medium text-accent" onClick={() => setChosen(null)}>Change</button>
            </div>
          ) : (
            <>
              <input id="dlg-who" className={field} value={query} placeholder="Type a name or employee number" autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
              {matches.length > 0 && (
                <ul className="mt-1 rounded-lg border border-black/10 divide-y divide-black/5 text-sm" role="listbox" aria-label="Colleagues">
                  {matches.map((m) => (
                    <li key={m.userAccountId}>
                      <button type="button" role="option" aria-selected="false" className="w-full text-left px-3 py-2 hover:bg-black/5" onClick={() => setChosen(m)}>
                        {m.name} · {m.employeeNumber}{m.designation ? ` · ${m.designation}` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {query.trim().length >= 2 && matches.length === 0 && <p className="text-xs text-label-tertiary mt-1">No colleague with a login matches.</p>}
            </>
          )}
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="dlg-from" className={label}>From</label>
            <input id="dlg-from" type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor="dlg-to" className={label}>I am back on</label>
            <input id="dlg-to" type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label htmlFor="dlg-reason" className={label}>Reason</label>
            <input id="dlg-reason" className={field} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        {error && <div className="text-xs text-danger" role="alert">{error}</div>}
        {notice && <div className="text-sm text-accent" role="status">{notice}</div>}
        <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">{busy ? "Saving…" : "Save cover arrangement"}</button>
      </form>

      <section aria-label="My cover arrangements" className="bg-card rounded-card p-5 shadow-sm mb-5">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Covering for me</h2>
        {items === null ? <LoadingNote what="arrangements" /> : given.length === 0 ? (
          <p className="text-sm text-label-tertiary" data-testid="no-given">Nobody is covering for you.</p>
        ) : (
          <div className="divide-y divide-black/5">
            {given.map((d) => {
              const state = delegationState(d, today);
              const badge = STATE_BADGE[state];
              return (
                <div key={d.id} className="py-3 flex items-start justify-between gap-3" data-testid="delegation-given">
                  <div>
                    <div className="text-sm font-medium">{d.delegateName ?? "A colleague"}</div>
                    <div className="text-xs text-label-tertiary">{formatDay(d.validFrom)} to {formatDay(d.validTo)} · {d.reason}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                    {(state === "active" || state === "upcoming") && <button onClick={() => revoke(d.id)} className="text-xs font-medium text-label-tertiary hover:text-danger">Cancel</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Covering for others" className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">I am covering for</h2>
        {items === null ? <LoadingNote what="arrangements" /> : received.length === 0 ? (
          <p className="text-sm text-label-tertiary">You are not covering for anyone.</p>
        ) : (
          <div className="divide-y divide-black/5">
            {received.map((d) => {
              const badge = STATE_BADGE[delegationState(d, today)];
              return (
                <div key={d.id} className="py-3 flex items-start justify-between gap-3" data-testid="delegation-received">
                  <div>
                    <div className="text-sm font-medium">{d.delegatorName ?? "A colleague"}</div>
                    <div className="text-xs text-label-tertiary">{formatDay(d.validFrom)} to {formatDay(d.validTo)} · {d.reason}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.cls}`}>{badge.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
