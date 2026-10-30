import { useCallback, useEffect, useState } from "react";
import type { EsignRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay, formatDateTime } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

function Item({ doc, onChanged, onError }: { doc: EsignRequestView; onChanged: () => void; onError: (m: string | null) => void }) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const fail = (e: unknown) => onError(e instanceof ApiError ? e.message : "That did not work.");
  return (
    <div className="bg-card rounded-card p-4 shadow-sm space-y-3" data-testid="sign-item">
      <div className="flex items-start gap-3 flex-wrap"><h2 className="font-semibold flex-1">{doc.title}</h2>
        <span className="text-xs px-2 py-0.5 rounded-full bg-black/5">{doc.status === "pending" ? "Waiting for you" : doc.status === "signed" ? "Signed" : "Declined"}</span></div>
      <div className="whitespace-pre-wrap text-sm rounded-lg bg-black/5 p-3 max-h-72 overflow-y-auto" tabIndex={0} aria-label={`Text of ${doc.title}`}>{doc.body}</div>
      {doc.dueOn && doc.status === "pending" && <p className="text-xs text-label-tertiary">Please sign by {formatDay(doc.dueOn)}.</p>}
      {doc.status === "pending" && (
        <div className="space-y-2">
          <label htmlFor={`nm-${doc.id}`} className="block text-xs font-medium text-label-secondary">Type your full name to say you have read this and agree</label>
          <input id={`nm-${doc.id}`} className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          <div className="flex gap-2">
            <button type="button" className={btn} disabled={!name.trim()} onClick={() => api.signEsign(doc.id, name).then(() => { onError(null); onChanged(); }).catch(fail)}>Sign</button>
            <button type="button" className={quiet} onClick={() => setDeclining(!declining)}>I do not agree</button>
          </div>
          {declining && (
            <div className="space-y-2"><label htmlFor={`rs-${doc.id}`} className="block text-xs font-medium text-label-secondary">Why are you not signing?</label>
              <input id={`rs-${doc.id}`} className={field} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              <button type="button" className={quiet} disabled={!reason.trim()} onClick={() => api.declineEsign(doc.id, reason).then(() => { onError(null); onChanged(); }).catch(fail)}>Send to HR</button></div>
          )}
        </div>
      )}
      {doc.status === "signed" && <p className="text-xs text-label-secondary">Signed as {doc.signedName} on {formatDateTime(doc.signedAt)}. Receipt <code className="break-all">{doc.receipt?.slice(0, 16)}…</code></p>}
      {doc.status === "declined" && <p className="text-xs text-label-secondary">You declined: {doc.declineReason}</p>}
    </div>
  );
}

/** Employees: documents HR asked me to read and sign. Typing my name records that I agree; it is not a certified digital signature. */
export function SignPage() {
  const [docs, setDocs] = useState<EsignRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listMyEsign().then(setDocs).catch((e) => { setDocs([]); setError(e instanceof ApiError ? e.message : "Could not load your documents."); }); }, []);
  useEffect(load, [load]);
  return (
    <div data-testid="sign-page">
      <PageHeader title="Documents to sign" subtitle="Read each document, then type your full name to agree. HR keeps a receipt." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {docs === null ? <LoadingNote what="your documents" /> : docs.length === 0 ? <p className="text-sm text-label-tertiary">Nothing to sign.</p> : (
        <div className="space-y-4 max-w-3xl">{docs.map((d) => <Item key={d.id} doc={d} onChanged={load} onError={setError} />)}</div>
      )}
    </div>
  );
}
