import { FormEvent, useEffect, useMemo, useState } from "react";
import type { EmployeeView, LeaveBalanceView, LeaveColleagueView, LeaveDayPart, LeaveRequestView, LeaveType, LeaveTypeView, OverlapWarning, SubmitLeaveRequestResponse } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LEAVE_TYPES, leaveTypeLabel } from "./leaveLabels";
import { countCalendarDays, countWorkingDays, formatDisplayDate, returnDateAfter } from "./leaveCalendar";
import { approverStepLabel, groupApprovalSteps } from "./leaveApprovals";

/**
 * Shared by both submit paths: an employee_self_service holder submitting their own request
 * (`fixedEmployeeId` set, no picker) and an hr_admin submitting On-Behalf (`fixedEmployeeId` omitted).
 * Which one a session sees is decided by LeavePage; this component renders the form either way.
 *
 * Laid out after the SAP "Create Request" screen: a "More than 1 day / One day or less" toggle, the
 * balance for the chosen type, a live "N days will be consumed" preview and the return date, and a
 * relief person. The preview is only a convenience; the server recounts working days on submit.
 */
export function LeaveRequestForm({
  fixedEmployeeId,
  onCancel,
  onSubmitted,
  initialStart,
  initialEnd,
  editing,
}: {
  fixedEmployeeId?: string;
  onCancel: () => void;
  onSubmitted: (result: SubmitLeaveRequestResponse) => void;
  initialStart?: string;
  initialEnd?: string;
  /** LV-UP: a pending request to edit. The form opens filled in and saves with PATCH instead of creating a new one. */
  editing?: LeaveRequestView;
}) {
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [colleagues, setColleagues] = useState<LeaveColleagueView[]>([]);
  const [employeeId, setEmployeeId] = useState(editing?.employeeId ?? fixedEmployeeId ?? "");
  const [leaveType, setLeaveType] = useState<LeaveType>(editing?.leaveType ?? "annual");
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeView[]>([]);
  const [balances, setBalances] = useState<LeaveBalanceView[]>([]);
  const [holidayDates, setHolidayDates] = useState<Map<string, string>>(new Map());
  const seedStart = editing?.startDate ?? initialStart;
  const seedEnd = editing?.endDate ?? initialEnd;
  const [multiDay, setMultiDay] = useState(!seedStart || !seedEnd || seedStart !== seedEnd);
  const [dayPart, setDayPart] = useState<LeaveDayPart>(editing?.dayPart ?? "full");
  const [startDate, setStartDate] = useState(seedStart ?? "");
  const [endDate, setEndDate] = useState(seedEnd ?? "");
  const [delegateEmployeeId, setDelegateEmployeeId] = useState(editing?.delegateEmployeeId ?? "");
  const [reason, setReason] = useState(editing?.reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A new range picked on the calendar while the form is open replaces the dates.
  useEffect(() => {
    if (editing) return;
    if (initialStart) setStartDate(initialStart);
    if (initialEnd) setEndDate(initialEnd);
    if (initialStart && initialEnd) {
      setMultiDay(initialStart !== initialEnd);
      if (initialStart !== initialEnd) setDayPart("full");
    }
  }, [initialStart, initialEnd, editing]);

  useEffect(() => {
    // TLM-01: the tenant's active leave types; the built-ins are the fallback if this fails.
    api.listLeaveTypes().then(setLeaveTypes).catch(() => undefined);
  }, []);

  useEffect(() => {
    // Public holidays only feed the "days consumed" / return-date preview; a failure just makes it weekday-only.
    const y = new Date().getUTCFullYear();
    Promise.all([api.listHolidays(String(y)), api.listHolidays(String(y + 1))])
      .then(([a, b]) => setHolidayDates(new Map([...a, ...b].filter((h) => !h.isOptional).map((h) => [h.holidayDate.slice(0, 10), h.name]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!employeeId) {
      setBalances([]);
      return;
    }
    api.getLeaveBalances(employeeId).then(setBalances).catch(() => setBalances([]));
  }, [employeeId]);

  useEffect(() => {
    // The employee picker (only when no employee is fixed): the same scoped GET /employees.
    if (fixedEmployeeId || editing) return;
    api.listEmployees().then(setEmployees).catch(() => {
      // A failed employee-list fetch shouldn't block the rest of the form.
    });
  }, [fixedEmployeeId, editing]);

  useEffect(() => {
    // Relief person candidates: the colleagues under the same manager. An ordinary employee cannot list
    // other employees, so this has its own endpoint.
    if (!employeeId) {
      setColleagues([]);
      return;
    }
    api.getLeaveColleagues(employeeId).then(setColleagues).catch(() => setColleagues([]));
  }, [employeeId]);

  const selectedType = leaveTypes.find((t) => t.code === leaveType);
  const halfDayAllowed = selectedType ? selectedType.halfDayAllowed : true;
  const tracksBalance = selectedType ? selectedType.tracksBalance : true;
  const year = startDate ? Number(startDate.slice(0, 4)) : new Date().getUTCFullYear();
  const balance = balances.find((b) => b.leaveType === leaveType && b.year === year);

  const effectiveEnd = multiDay ? endDate : startDate;
  const consumed = useMemo(() => {
    if (!startDate || !effectiveEnd) return null;
    if (!multiDay && dayPart !== "full") return 0.5;
    return countWorkingDays(startDate, effectiveEnd, holidayDates);
  }, [startDate, effectiveEnd, multiDay, dayPart, holidayDates]);
  const calendarDays = startDate && effectiveEnd ? countCalendarDays(startDate, effectiveEnd) : 0;
  const returnDate = startDate && effectiveEnd && effectiveEnd >= startDate ? (!multiDay && dayPart === "first_half" ? startDate : returnDateAfter(effectiveEnd, holidayDates)) : null;
  const overBalance = tracksBalance && balance !== undefined && consumed !== null && consumed > balance.remainingDays;

  const reliefCandidates = colleagues;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Inline, visible validation: native `required` tooltips are easy to miss, and a live QA pass saw the
    // form appear to do nothing when no employee was picked on the On-Behalf path.
    if (!employeeId) {
      setError("Select the employee this leave is for.");
      return;
    }
    if (!startDate || !effectiveEnd) {
      setError("Choose the leave dates.");
      return;
    }
    if (effectiveEnd < startDate) {
      setError("End date can't be before the start date.");
      return;
    }
    if (dayPart !== "full" && effectiveEnd !== startDate) {
      setError("A half-day leave must start and end on the same date.");
      return;
    }
    setSubmitting(true);
    try {
      const result = editing
        ? await api.updateLeaveRequest(editing.id, {
            leaveType,
            startDate,
            endDate: effectiveEnd,
            reason: reason || null,
            dayPart,
            delegateEmployeeId: delegateEmployeeId || null,
          })
        : await api.submitLeaveRequest({
            employeeId,
            leaveType,
            startDate,
            endDate: effectiveEnd,
            reason: reason || undefined,
            dayPart: dayPart === "full" ? undefined : dayPart,
            delegateEmployeeId: delegateEmployeeId || undefined,
          });
      onSubmitted(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editing ? "Could not save these changes." : "Could not submit this leave request.");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4" aria-label={editing ? "Edit leave request" : "Create leave request"}>
      {!fixedEmployeeId && !editing && (
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="leave-employee">Employee</label>
          <select id="leave-employee" required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={fieldClass}>
            <option value="">Select an employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
                {emp.department ? ` — ${emp.department}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="leave-type">Leave type</label>
        <select
          id="leave-type"
          value={leaveType}
          onChange={(e) => {
            setLeaveType(e.target.value as LeaveType);
            setDayPart("full");
          }}
          className={fieldClass}
        >
          {(leaveTypes.length > 0 ? leaveTypes.map((t) => ({ code: t.code, name: t.name })) : LEAVE_TYPES.map((t) => ({ code: t, name: leaveTypeLabel(t) }))).map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>
        {employeeId && tracksBalance && (
          <p className={`mt-1 text-xs ${balance && balance.remainingDays <= 0 ? "text-danger" : "text-label-secondary"}`} data-testid="leave-available-days">
            {balance ? `${balance.remainingDays} ${balance.remainingDays === 1 ? "Day" : "Days"} available` : "No balance has been set up for this leave type"}
          </p>
        )}
        {!tracksBalance && <p className="mt-1 text-xs text-label-secondary">This leave type has no balance; it is deducted in payroll instead.</p>}
      </div>

      <div role="radiogroup" aria-label="Request length" className="inline-flex rounded-lg border border-black/10 overflow-hidden text-sm">
        {(
          [
            [true, "More than 1 day"],
            [false, "One day or less"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={multiDay === value}
            onClick={() => {
              setMultiDay(value);
              if (value) setDayPart("full");
              else if (startDate) setEndDate(startDate);
            }}
            className={`px-3 py-1.5 font-medium ${multiDay === value ? "bg-accent text-white" : "bg-surface text-label-secondary"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={`grid gap-4 ${multiDay ? "grid-cols-2" : "grid-cols-1"}`}>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="leave-start">{multiDay ? "Start date" : "Date"}</label>
          <input
            id="leave-start"
            type="date"
            required
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              if (!multiDay || (endDate && endDate < e.target.value)) setEndDate(e.target.value);
            }}
            className={fieldClass}
          />
        </div>
        {multiDay && (
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="leave-end">End date</label>
            <input id="leave-end" type="date" required value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className={fieldClass} />
          </div>
        )}
      </div>

      {!multiDay && halfDayAllowed && (
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="leave-day-part">Duration</label>
          <select id="leave-day-part" value={dayPart} onChange={(e) => setDayPart(e.target.value as LeaveDayPart)} className={fieldClass}>
            <option value="full">Full day</option>
            <option value="first_half">First half of the day</option>
            <option value="second_half">Second half of the day</option>
          </select>
        </div>
      )}

      {consumed !== null && startDate && effectiveEnd >= startDate && (
        <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900" data-testid="leave-consumed-preview" aria-live="polite">
          <div className="font-semibold tabular-nums">
            {consumed} {consumed === 1 ? "Day" : "Days"} will be consumed
          </div>
          <div className="text-xs tabular-nums">
            {calendarDays} calendar {calendarDays === 1 ? "day" : "days"} selected; weekends and public holidays are not counted.
            {returnDate && <> Return date: {formatDisplayDate(returnDate)}.</>}
          </div>
          {overBalance && <div className="text-xs text-danger mt-1">This is more than the {balance?.remainingDays} day(s) available. The server may reject it or treat the rest as unpaid, depending on the leave type.</div>}
        </div>
      )}

      {selectedType?.documentRequired && (
        <div className="text-xs text-label-secondary">
          {selectedType.name} {selectedType.documentRequiredAfterDays > 0 ? `over ${selectedType.documentRequiredAfterDays} day(s) ` : ""}needs a supporting document - upload it under the employee&apos;s Documents first.
        </div>
      )}

      <div className="grid grid-cols-3 gap-4" data-testid="leave-form-computed">
        {(
          [
            ["Working days", consumed === null ? "" : String(consumed)],
            ["Absence days", startDate && effectiveEnd >= startDate ? String(calendarDays) : ""],
            ["Return date", returnDate ? formatDisplayDate(returnDate) : ""],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <label className="block text-xs font-medium mb-1 text-label-secondary">{label}</label>
            <input readOnly tabIndex={-1} value={value} aria-label={label} className={`${fieldClass} bg-black/[0.04] text-label-secondary tabular-nums`} />
          </div>
        ))}
      </div>

      {reliefCandidates.length > 0 && (
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="leave-relief">Relief person (optional)</label>
          <select id="leave-relief" value={delegateEmployeeId} onChange={(e) => setDelegateEmployeeId(e.target.value)} className={fieldClass}>
            <option value="">No relief person</option>
            {reliefCandidates.map((emp) => (
              <option key={emp.employeeId} value={emp.employeeId}>
                {emp.employeeName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>
      )}

      {editing && editing.approvals && editing.approvals.length > 0 && (
        <div className="grid grid-cols-2 gap-4" data-testid="leave-form-approvers">
          {groupApprovalSteps(editing.approvals).map((step) => (
            <div key={step.stepOrder}>
              <label className="block text-xs font-medium mb-1 text-label-secondary">{approverStepLabel(step.stepOrder)}</label>
              <input readOnly tabIndex={-1} value={step.names.length > 0 ? step.names.join(", ") : step.stepName} className={`${fieldClass} bg-black/[0.04] text-label-secondary`} />
            </div>
          ))}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="leave-reason">Note (optional)</label>
        <textarea id="leave-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} />
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button type="submit" disabled={submitting} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {submitting ? (editing ? "Saving…" : "Submitting…") : editing ? "Save changes" : "Submit request"}
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
