import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { PendingEmployeeDocumentView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { formatDateTime, formatDay, todayIso } from "../shared/dates";
import { DEFAULT_DOCUMENT_TYPES, expiryState, typeLabel } from "./employeeDocuments";

/** BACKLOG50 - documents employees uploaded to their own file that wait for HR. Shown on the Change Requests page. */
export function PendingDocumentsInbox() {
  const [items, setItems] = useState<PendingEmployeeDocumentView[] | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    api.listPendingEmployeeDocuments().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function decide(doc: PendingEmployeeDocumentView, decision: "approved" | "rejected") {
    setRowError((e) => ({ ...e, [doc.id]: "" }));
    if (decision === "rejected" && !reason.trim()) return setRowError((e) => ({ ...e, [doc.id]: "Tell the employee why it is not approved." }));
    setBusy(doc.id);
    try {
      await api.reviewEmployeeDocument(doc.id, decision, reason.trim() || undefined);
      setRejecting(null);
      setReason("");
      load();
    } catch (err) {
      setRowError((e) => ({ ...e, [doc.id]: err instanceof ApiError ? err.message : "Could not do that." }));
    } finally {
      setBusy(null);
    }
  }

  async function open(doc: PendingEmployeeDocumentView) {
    try {
      await api.downloadEmployeeDocument(doc.employeeId, doc.id, doc.fileName);
    } catch (err) {
      setRowError((e) => ({ ...e, [doc.id]: err instanceof ApiError ? err.message : "Could not open the file." }));
    }
  }

  if (!items || items.length === 0) return null;
  const today = todayIso();
  return (
    <section className="mb-6" aria-label="Documents waiting for review" data-testid="pending-documents">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-2">Documents waiting for review · {items.length}</h2>
      <div className="space-y-3">
        {items.map((d) => (
          <div key={d.id} className="bg-card rounded-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{typeLabel(d.documentType, DEFAULT_DOCUMENT_TYPES)} · {d.fileName}</div>
                <div className="text-xs text-label-tertiary mt-0.5">
                  <Link className="text-accent hover:underline" to={`/app/employees/${d.employeeId}`}><EmployeeAvatar employeeId={d.employeeId} name={d.employeeName} size="xs" className="mr-1.5 align-middle" />{d.employeeNumber} · {d.employeeName}</Link> · sent {formatDateTime(d.createdAt)}
                  {d.expiryDate && (
                    <span className={expiryState(d.expiryDate, today) === "expired" ? "text-danger font-medium" : ""}> · expires {formatDay(d.expiryDate)}</span>
                  )}
                  {d.note ? ` · “${d.note}”` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => open(d)} className="text-xs font-medium text-accent hover:underline">Open</button>
                <button type="button" disabled={busy === d.id} onClick={() => decide(d, "approved")} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Approve</button>
                <button type="button" onClick={() => { setRejecting(rejecting === d.id ? null : d.id); setReason(""); }} className="text-xs font-medium text-label-tertiary hover:text-danger">Reject</button>
              </div>
            </div>
            {rejecting === d.id && (
              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <input aria-label="Reason for rejecting the document" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tell the employee why" className="rounded-lg border border-black/10 px-3 py-1.5 text-sm flex-1 min-w-48" />
                <button type="button" disabled={busy === d.id} onClick={() => decide(d, "rejected")} className="text-xs font-semibold text-danger hover:underline">Send rejection</button>
              </div>
            )}
            {rowError[d.id] && <div className="text-danger text-xs mt-2" role="alert">{rowError[d.id]}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
