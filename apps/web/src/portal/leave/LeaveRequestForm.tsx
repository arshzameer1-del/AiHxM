import { FormEvent, useEffect, useState } from "react";
import type { EmployeeView, LeaveType, OverlapWarning, SubmitLeaveRequestResponse } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { LEAVE_TYPES, LEAVE_TYPE_LABELS } from "./leaveLabels";

/**
 * Shared by both submit paths this task builds: an employee_self_service
 * holder submitting their own request (`fixedEmployeeId` set, no picker)
 * and an hr_admin submitting On-Behalf for anyone (`fixedEmployeeId`
 * omitted — LeaveRequestsService's own `manage.all` path, unconditional
 * on whose leave it is). Which one a given session sees is decided by
 * LeavePage; this component just renders the form either way.
 */
export function LeaveRequestForm({
  fixedEmployeeId,
  onCancel,
  onSubmitted,
}: {
  fixedEmployeeId?: string;
  onCancel: () => void;
  onSubmitted: (result: SubmitLeaveRequestResponse) => void;
}) {
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [employeeId, setEmployeeId] = useState(fixedEmployeeId ?? "");
  const [leaveType, setLeaveType] = useState<LeaveType>("annual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (fixedEmployeeId) return;
    // On-Behalf path only — reuses the same scoped GET /employees the
    // Employee Core create-page's manager dropdown already calls.
    api.listEmployees().then(setEmployees).catch(() => {
      // A failed employee-list fetch shouldn't block the rest of the form.
    });
  }, [fixedEmployeeId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.submitLeaveRequest({
        employeeId,
        leaveType,
        startDate,
        endDate,
        reason: reason || undefined,
      });
      onSubmitted(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit this leave request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      {!fixedEmployeeId && (
        <div>
          <label className="block text-sm font-medium mb-1">Employee</label>
          <select
            required
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">Select an employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Leave type</label>
          <select
            value={leaveType}
            onChange={(e) => setLeaveType(e.target.value as LeaveType)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {LEAVE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Start date</label>
          <input
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">End date</label>
          <input
            type="date"
            required
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Reason (optional)</label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Submit request"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function OverlapNotice({ warnings }: { warnings: OverlapWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
      <div className="font-semibold text-amber-900">
        Heads up — {warnings.length === 1 ? "someone" : `${warnings.length} people`} on the same team already
        {warnings.length === 1 ? " has" : " have"} overlapping time off:
      </div>
      {warnings.map((w) => (
        <div key={w.leaveRequestId} className="text-amber-900">
          {w.employeeFullName}: {w.startDate} – {w.endDate}
        </div>
      ))}
      <div className="text-amber-800">This is just a notice — your request was still submitted.</div>
    </div>
  );
}
