import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import type { AttendanceCorrectionRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { describeError } from "../shared/describeError";
import { formatDay, formatTime } from "../shared/dates";

function CorrectionRow({ request, onChanged }: { request: AttendanceCorrectionRequestView; onChanged: () => void }) {
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitDecision(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await api.decideAttendanceCorrection(request.id, { decision, comment: comment || undefined });
      setDeciding(null);
      setComment("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <EmployeeAvatar employeeId={request.employeeId} name={request.employeeName} size="md" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">
            {request.employeeName}
            {request.isOnBehalf && <span className="text-xs text-label-tertiary ml-1.5">(submitted by HR)</span>}
          </div>
          <div className="text-sm text-label-secondary mt-0.5">
            {formatDay(request.requestedDate)}
            {request.requestedClockIn && ` · in ${formatTime(request.requestedClockIn)}`}
            {request.requestedClockOut && ` · out ${formatTime(request.requestedClockOut)}`}
          </div>
          <div className="text-xs text-label-tertiary mt-1">&ldquo;{request.reason}&rdquo;</div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-black/5">
        {deciding ? (
          <div className="space-y-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Comment (optional)"
              className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="flex gap-3 items-center">
              <button
                onClick={() => submitDecision(deciding)}
                disabled={busy}
                className={`text-xs font-semibold rounded-lg px-3 py-1.5 text-white disabled:opacity-50 ${
                  deciding === "approved" ? "bg-success" : "bg-danger"
                }`}
              >
                Confirm {deciding === "approved" ? "approval" : "rejection"}
              </button>
              <button onClick={() => setDeciding(null)} className="text-xs text-label-tertiary">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-4 items-center flex-wrap">
            <button
              onClick={() => setDeciding("approved")}
              className="text-xs font-semibold text-green-700 hover:underline"
            >
              Approve
            </button>
            <button onClick={() => setDeciding("rejected")} className="text-xs font-semibold text-danger hover:underline">
              Reject
            </button>
          </div>
        )}
        {error && <p className="text-xs text-danger mt-2">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Attendance Policies increment 1 — the decider's queue.
 * `listPendingAttendanceCorrections` already returns only what THIS
 * caller can decide (their own reports for a line_manager, the whole
 * company for hr_admin — AttendanceCorrectionsService.listPendingForDecider's
 * own scoping), so there's no client-side filtering to get wrong here.
 */
export function PendingCorrectionsSection({ refreshKey, onChanged, standalone = false }: { refreshKey: number; onChanged: () => void; standalone?: boolean }) {
  const [pending, setPending] = useState<AttendanceCorrectionRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPendingAttendanceCorrections()
      .then(setPending)
      .catch((err) => setError(describeError(err)));
  }, [refreshKey]);

  if (standalone && error) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!standalone && (error || (pending && pending.length === 0))) return null;

  return (
    <section className={standalone ? "" : "mt-8"}>
      {!standalone && <h2 className="text-lg font-semibold mb-4">Pending Attendance Corrections</h2>}
      {pending && pending.length === 0 ? (
        <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-tertiary">No attendance corrections are waiting for you.</div>
      ) : !pending ? (
        <LoadingNote />
      ) : (
        <div className="space-y-3">
          {pending.map((c) => (
            <CorrectionRow key={c.id} request={c} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}
