import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EmployeeView, LeaveRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { describeError } from "../shared/describeError";
import { leaveTypeLabel, STATUS_LABELS, STATUS_STYLES } from "./leaveLabels";
import { formatDay, formatPeriod } from "../shared/dates";

function RequestRow({
  request,
  employee,
  canDecide,
  canCancel,
  onChanged,
}: {
  request: LeaveRequestView;
  employee: EmployeeView | undefined;
  canDecide: boolean;
  canCancel: boolean;
  onChanged: () => void;
}) {
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitDecision(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await api.decideLeaveRequest(request.id, { decision, comment: comment || undefined });
      setDeciding(null);
      setComment("");
      onChanged();
    } catch (err) {
      // A real 403 here ("not a resolved approver on this step") is the
      // honest answer for canDecide's cosmetic role-gate being wrong for
      // THIS specific request's workflow routing — surfaced verbatim,
      // not swallowed.
      setError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm("Cancel this leave request?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelLeaveRequest(request.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel this request.");
    } finally {
      setBusy(false);
    }
  }

  async function requestCancellation() {
    const reason = window.prompt("Why does this approved leave need to be cancelled?");
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestLeaveCancellation(request.id, { reason: reason.trim() });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request the cancellation.");
    } finally {
      setBusy(false);
    }
  }

  async function decideCancellation(decision: "approved" | "declined") {
    setBusy(true);
    setError(null);
    try {
      await api.decideLeaveCancellation(request.id, { decision });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  const canActOnThis = request.status === "pending" && (canDecide || canCancel);
  const cancellationPending = request.status === "approved" && request.cancellationStatus === "requested";

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium text-sm">
            {employee ? `${employee.firstName} ${employee.lastName}` : "Employee"}
            {request.isOnBehalf && <span className="text-xs text-label-tertiary ml-1.5">(on behalf)</span>}
          </div>
          <div className="text-sm text-label-secondary mt-0.5">
            {leaveTypeLabel(request.leaveType)} · {formatPeriod(request.startDate, request.endDate)} · {request.daysRequested}{" "}
            day{request.daysRequested === 1 ? "" : "s"}
          </div>
          {request.dayPart !== "full" && (
            <div className="text-xs text-label-tertiary mt-1">{request.dayPart === "first_half" ? "First half of the day" : "Second half of the day"}</div>
          )}
          {request.reason && <div className="text-xs text-label-tertiary mt-1">&ldquo;{request.reason}&rdquo;</div>}
          {request.status === "rejected" && request.rejectionReason && (
            <div className="text-xs text-danger mt-1">Rejected: {request.rejectionReason}</div>
          )}
          {request.returnDate && request.status === "approved" && (
            <div className="text-xs text-label-tertiary mt-1">Back on {formatDay(request.returnDate)}</div>
          )}
          {request.cancellationStatus === "declined" && <div className="text-xs text-label-tertiary mt-1">Cancellation request declined</div>}
        </div>
        <span
          className={`shrink-0 inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[request.status]}`}
        >
          {STATUS_LABELS[request.status]}
        </span>
      </div>

      {request.status === "approved" && !request.cancellationStatus && (
        <div className="mt-3 pt-3 border-t border-black/5 flex items-center gap-3">
          <button onClick={requestCancellation} disabled={busy} className="text-xs font-semibold text-label-secondary underline disabled:opacity-50">
            Request cancellation
          </button>
          {error && <span className="text-danger text-xs">{error}</span>}
        </div>
      )}
      {cancellationPending && (
        <div className="mt-3 pt-3 border-t border-black/5 space-y-2">
          <div className="text-xs text-label-secondary">Cancellation requested: {request.cancellationReason}</div>
          {canDecide && (
            <div className="flex gap-3">
              <button onClick={() => decideCancellation("approved")} disabled={busy} className="text-xs font-semibold rounded-lg px-3 py-1.5 text-white bg-success disabled:opacity-50">
                Approve cancellation
              </button>
              <button onClick={() => decideCancellation("declined")} disabled={busy} className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-black/5 disabled:opacity-50">
                Decline
              </button>
            </div>
          )}
          {error && <div className="text-danger text-xs">{error}</div>}
        </div>
      )}

      {canActOnThis && (
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
              {canDecide && (
                <button
                  onClick={() => setDeciding("approved")}
                  className="text-xs font-semibold text-green-700 hover:underline"
                >
                  Approve
                </button>
              )}
              {canDecide && (
                <button onClick={() => setDeciding("rejected")} className="text-xs font-semibold text-danger hover:underline">
                  Reject
                </button>
              )}
              {canCancel && (
                <button onClick={handleCancel} disabled={busy} className="text-xs font-medium text-label-tertiary hover:text-danger">
                  Cancel request
                </button>
              )}
            </div>
          )}
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function RequestsSection({
  canSubmitOnBehalf,
  canDecide,
  canCancel,
  refreshKey,
  onChanged,
}: {
  canSubmitOnBehalf: boolean;
  canDecide: boolean;
  canCancel: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [requests, setRequests] = useState<LeaveRequestView[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api.listLeaveRequests(), api.listEmployees()])
      .then(([reqs, emps]) => {
        setRequests(reqs);
        setEmployees(emps);
      })
      .catch((err) => setError(describeError(err)));
  }, [refreshKey]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;

  const employeeById = new Map(employees.map((e) => [e.id, e]));

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Leave Requests</h2>
        {canSubmitOnBehalf && (
          <Link to="/app/leave/on-behalf" className="text-sm font-semibold text-accent hover:underline">
            Submit on behalf
          </Link>
        )}
      </div>

      {!requests ? (
        <LoadingNote />
      ) : requests.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No leave requests to show.
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              employee={employeeById.get(r.employeeId)}
              canDecide={canDecide}
              canCancel={canCancel}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}
