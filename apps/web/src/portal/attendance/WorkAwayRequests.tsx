import { useEffect, useState } from "react";
import type { OnDutyDutyType, OnDutyRequestStatus, OnDutyRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { describeError } from "../shared/describeError";
import { formatRange, todayIso } from "../shared/dates";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { SapSection } from "../shared/FormSections";
import { LoadingNote } from "../shared/PageChrome";
import { useFormSettings } from "../shared/useFormSettings";

export const DUTY_TYPE_LABELS: Record<OnDutyDutyType, string> = {
  work_from_home: "Work from home",
  on_duty: "On duty (official work away)",
};

const STATUS_LABELS: Record<OnDutyRequestStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Sent back",
  cancelled: "Cancelled",
};

const STATUS_STYLES: Record<OnDutyRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  returned: "bg-blue-100 text-blue-800",
  cancelled: "bg-black/5 text-label-tertiary",
};

function WorkAwayForm({ employeeId, onSubmitted, onCancel }: { employeeId: string; onSubmitted: () => void; onCancel: () => void }) {
  const [dutyType, setDutyType] = useState<OnDutyDutyType>("work_from_home");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [location, setLocation] = useState("");
  const [reason, setReason] = useState("");
  const fs = useFormSettings("on_duty_request");
  const sLoc = fs("location", { label: "Where will you be?" });
  const sReason = fs("reason", { label: "Reason" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (endDate < startDate) {
      setError("The last day cannot be before the first day.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.submitOnDutyRequest({
        employeeId,
        dutyType,
        startDate,
        endDate,
        location: location.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
  return (
    <form onSubmit={submit} className="bg-black/[0.03] rounded-lg p-4 space-y-3" aria-label="Work-away request form">
      <label className="block text-xs text-label-tertiary">
        Type
        <select id="work-away-type" value={dutyType} onChange={(e) => setDutyType(e.target.value as OnDutyDutyType)} className={input}>
          <option value="work_from_home">{DUTY_TYPE_LABELS.work_from_home}</option>
          <option value="on_duty">{DUTY_TYPE_LABELS.on_duty}</option>
        </select>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-label-tertiary">
          First day
          <input id="work-away-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required className={input} />
        </label>
        <label className="text-xs text-label-tertiary">
          Last day
          <input id="work-away-end" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required className={input} />
        </label>
      </div>
      {!sLoc.hidden && (
        <label className="block text-xs text-label-tertiary">
          {sLoc.label !== "Where will you be?" ? sLoc.label : dutyType === "on_duty" ? "Where will you be?" : "Where will you work from? (optional)"}
          {sLoc.required && <span className="text-danger">*</span>}
          <input
            id="work-away-location"
            value={location}
            required={sLoc.required}
            maxLength={sLoc.maxLength ?? undefined}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={sLoc.placeholder ?? (dutyType === "on_duty" ? "e.g. Client site, Karachi" : "e.g. Home")}
            className={input}
          />
          {sLoc.helpText && <span className="block text-label-secondary mt-1">{sLoc.helpText}</span>}
        </label>
      )}
      {!sReason.hidden && (
        <label className="block text-xs text-label-tertiary">
          {sReason.label}{sReason.required && <span className="text-danger">*</span>}
          <input id="work-away-reason" value={reason} required={sReason.required} maxLength={sReason.maxLength ?? undefined} onChange={(e) => setReason(e.target.value)} placeholder={sReason.placeholder ?? "Short note for your approver"} className={input} />
          {sReason.helpText && <span className="block text-label-secondary mt-1">{sReason.helpText}</span>}
        </label>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-3 items-center">
        <button type="submit" disabled={busy} className="text-sm font-semibold rounded-lg px-3 py-1.5 bg-accent text-white disabled:opacity-50">
          {busy ? "Sending…" : "Send request"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-label-tertiary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** My work-from-home and on-duty requests, with a form to send a new one. */
export function WorkAwayPanel({ employeeId, refreshKey, onChanged }: { employeeId: string; refreshKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<OnDutyRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    api
      .listOnDutyRequests(employeeId)
      .then(setRows)
      .catch((err) => setError(describeError(err)));
  }, [employeeId, refreshKey]);

  if (error) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <div className="grid lg:grid-cols-2 gap-x-4 items-start">
      <SapSection
        title="New request"
        collapsible={false}
        actions={
          !showForm ? (
            <button type="button" onClick={() => setShowForm(true)} className="text-sm font-semibold text-accent hover:underline">
              Request work-away
            </button>
          ) : undefined
        }
      >
        {showForm ? (
          <WorkAwayForm
            employeeId={employeeId}
            onCancel={() => setShowForm(false)}
            onSubmitted={() => {
              setShowForm(false);
              onChanged();
            }}
          />
        ) : (
          <p className="text-sm text-label-secondary">Working from home, or away on official work? Ask your approver. Approved days count as attended.</p>
        )}
      </SapSection>

      <SapSection title="My requests" count={rows?.length}>
        {!rows ? (
          <LoadingNote />
        ) : rows.length === 0 ? (
          <p className="text-sm text-label-tertiary">You have not sent any requests yet.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm" data-testid="work-away-row">
                <span className="text-label-secondary">
                  {DUTY_TYPE_LABELS[r.dutyType].split(" (")[0]} · {formatRange(r.startDate, r.endDate)}
                  {r.location && <span className="text-label-tertiary"> · {r.location}</span>}
                </span>
                <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[r.status]}`}>{STATUS_LABELS[r.status]}</span>
              </div>
            ))}
          </div>
        )}
      </SapSection>
    </div>
  );
}

function ApprovalRow({ request, onChanged }: { request: OnDutyRequestView; onChanged: () => void }) {
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await api.decideOnDutyRequest(request.id, { decision, comment: comment || undefined });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm" data-testid="work-away-approval">
      <div className="flex items-start gap-4">
        <EmployeeAvatar employeeId={request.employeeId} name={request.employeeName} size="md" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{request.employeeName}</div>
          <div className="text-sm text-label-secondary mt-0.5">
            {DUTY_TYPE_LABELS[request.dutyType].split(" (")[0]} · {formatRange(request.startDate, request.endDate)}
            {request.location && ` · ${request.location}`}
          </div>
          {request.reason && <div className="text-xs text-label-tertiary mt-1">&ldquo;{request.reason}&rdquo;</div>}
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-black/5">
        {deciding ? (
          <div className="space-y-2">
            <input
              id={`work-away-comment-${request.id}`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Comment (optional)"
              className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="flex gap-3 items-center">
              <button
                onClick={() => confirm(deciding)}
                disabled={busy}
                className={`text-xs font-semibold rounded-lg px-3 py-1.5 text-white disabled:opacity-50 ${deciding === "approved" ? "bg-success" : "bg-danger"}`}
              >
                Confirm {deciding === "approved" ? "approval" : "rejection"}
              </button>
              <button onClick={() => setDeciding(null)} className="text-xs text-label-tertiary">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-4 items-center">
            <button onClick={() => setDeciding("approved")} className="text-xs font-semibold text-green-700 hover:underline">
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

/** The approver's queue. The server already limits it to what the signed-in person can decide. */
export function WorkAwayApprovals({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [pending, setPending] = useState<OnDutyRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPendingOnDutyRequests()
      .then(setPending)
      .catch((err) => setError(describeError(err)));
  }, [refreshKey]);

  if (error) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!pending) return <LoadingNote />;
  if (pending.length === 0) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-tertiary">No work-away requests are waiting for you.</div>;
  return (
    <div className="space-y-3">
      {pending.map((r) => (
        <ApprovalRow key={r.id} request={r} onChanged={onChanged} />
      ))}
    </div>
  );
}
