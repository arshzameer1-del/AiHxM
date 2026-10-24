import { useCallback, useEffect, useState } from "react";
import type { EmployeeChangeRequestStatus, EmployeeChangeRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatDateTime } from "../shared/dates";

const STATUS: Record<EmployeeChangeRequestStatus, { label: string; cls: string }> = {
  pending: { label: "Waiting for HR", cls: "bg-warning/15 text-warning" },
  approved: { label: "Approved", cls: "bg-accent/10 text-accent" },
  rejected: { label: "Not approved", cls: "bg-danger/10 text-danger" },
  cancelled: { label: "Withdrawn", cls: "bg-black/5 text-label-tertiary" },
};

/** BACKLOG48 - the employee's own change requests and what HR answered. */
export function MyChangeRequestsPanel() {
  const [items, setItems] = useState<EmployeeChangeRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listMyChangeRequests().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("change-request-sent", load);
    return () => window.removeEventListener("change-request-sent", load);
  }, [load]);

  async function cancel(id: string) {
    setError(null);
    try {
      await api.cancelEmployeeChangeRequest(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not withdraw the request.");
    }
  }

  if (!items || items.length === 0) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm mt-6" aria-label="My change requests">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">My change requests</h2>
      {error && <div className="text-danger text-xs mb-2">{error}</div>}
      <div className="divide-y divide-black/5">
        {items.slice(0, 15).map((r) => (
          <div key={r.id} className="py-2.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm">{r.summary}</div>
              <div className="text-xs text-label-tertiary mt-0.5">
                Sent {formatDateTime(r.submittedAt)}
                {r.decisionNote ? ` · HR: ${r.decisionNote}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
              {r.status === "pending" && (
                <button onClick={() => cancel(r.id)} className="text-xs font-medium text-label-tertiary hover:text-danger">
                  Withdraw
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
