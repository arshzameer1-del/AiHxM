import { FormEvent, useEffect, useMemo, useState } from "react";
import type { EmployeeView, LeaveApproverPreviewView, LeaveBalanceView, LeaveColleagueView, LeaveDayPart, LeaveRequestView, LeaveType, LeaveTypeView, OverlapWarning, SubmitLeaveRequestResponse } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LEAVE_TYPES, leaveTypeLabel } from "./leaveLabels";
import { countCalendarDays, countWorkingDays, formatDisplayDate, returnDateAfter } from "./leaveCalendar";
import { approverStepLabel, groupApprovalSteps } from "./leaveApprovals";
import { TeamCalendar } from "./TeamCalendar";
import { SapConfirm, SapField, SapFooter, SapSection } from "../shared/FormSections";
import { formatPeriod } from "../shared/dates";

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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [approverPreview, setApproverPreview] = useState<LeaveApproverPreviewView[]>([]);

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

  useEffect(() => {
    // Expected approvers, shown before anything is submitted (display only).
    if (!employeeId || editing) {
      setApproverPreview([]);
      return;
    }
    api.getLeaveApproverPreview(employeeId).then(setApproverPreview).catch(() => setApproverPreview([]));
  }, [employeeId, editing]);

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

  const fieldClass = "w-full rounded border border-black/25 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
  const readOnlyClass = "w-full rounded border border-black/10 bg-black/[0.05] px-2 py-1.5 text-sm text-label-secondary tabular-nums";
  const approverRows: { stepOrder: number; label: string; value: string }[] = editing && editing.approvals && editing.approvals.length > 0
    ? groupApprovalSteps(editing.approvals).map((step) => ({ stepOrder: step.stepOrder, label: approverStepLabel(step.stepOrder), value: step.names.length > 0 ? step.names.join(", ") : step.stepName }))
    : approverPreview.map((a) => ({ stepOrder: a.stepOrder, label: approverStepLabel(a.stepOrder), value: a.approverName ?? a.stepName }));
  const noDeduction = consumed === 0 && startDate && effectiveEnd >= startDate;

  return (
    <form onSubmit={handleSubmit} className="pb-2" aria-label={editing ? "Edit leave request" : "Create leave request"}>
      <div className="grid lg:grid-cols-2 gap-x-3 items-start">
      <div className="min-w-0">
      <SapSection title="Leave Type Selection" collapsible={false}>
        {!fixedEmployeeId && !editing && (
          <SapField label="Employee" htmlFor="leave-employee" required>
            <select id="leave-employee" required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={fieldClass}>
              <option value="">Select an employee…</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.firstName} {emp.lastName} ({emp.employeeNumber})
                  {emp.department ? ` — ${emp.department}` : ""}
                </option>
              ))}
            </select>
          </SapField>
        )}
        <SapField
          label="Leave Type"
          htmlFor="leave-type"
          hint={
            <>
              {employeeId && tracksBalance && (
                <span className={balance && balance.remainingDays <= 0 ? "text-danger" : ""} data-testid="leave-available-days">
                  {balance ? `${balance.remainingDays} ${balance.remainingDays === 1 ? "Day" : "Days"} available` : "No balance has been set up for this leave type"}
                </span>
              )}
              {!tracksBalance && <span>This leave type has no balance; it is deducted in payroll instead.</span>}
            </>
          }
        >
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
        </SapField>
      </SapSection>

      <SapSection title="General Data" collapsible={false}>
        <div role="radiogroup" aria-label="Request length" className="flex flex-wrap gap-x-6 gap-y-1 sm:pl-[182px] pb-1 text-sm">
          {(
            [
              [true, "More than 1 day"],
              [false, "One day or less"],
            ] as const
          ).map(([value, label]) => (
            <label key={label} className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="leave-length"
                checked={multiDay === value}
                onChange={() => {
                  setMultiDay(value);
                  if (value) setDayPart("full");
                  else if (startDate) setEndDate(startDate);
                }}
                className="accent-[var(--accent,#2563eb)]"
              />
              {label}
            </label>
          ))}
        </div>

        <SapField label={multiDay ? "Start date" : "Date"} htmlFor="leave-start" required>
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
        </SapField>
        {multiDay && (
          <SapField label="End date" htmlFor="leave-end" required>
            <input id="leave-end" type="date" required value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className={fieldClass} />
          </SapField>
        )}

        {!multiDay && halfDayAllowed && (
          <SapField label="Duration" htmlFor="leave-day-part">
            <select id="leave-day-part" value={dayPart} onChange={(e) => setDayPart(e.target.value as LeaveDayPart)} className={fieldClass}>
              <option value="full">Full day</option>
              <option value="first_half">First half of the day</option>
              <option value="second_half">Second half of the day</option>
            </select>
          </SapField>
        )}

        {consumed !== null && startDate && effectiveEnd >= startDate && (
          <div className="sm:pl-[182px] text-xs pb-1" data-testid="leave-consumed-preview" aria-live="polite">
            {noDeduction ? (
              <span className="text-label-secondary">No deduction possible</span>
            ) : (
              <span className="font-semibold tabular-nums">
                {consumed} {consumed === 1 ? "Day" : "Days"} will be consumed
              </span>
            )}
            <span className="block text-label-secondary tabular-nums">
              {calendarDays} calendar {calendarDays === 1 ? "day" : "days"} selected; weekends and public holidays are not counted.
              {returnDate && <> Return date: {formatDisplayDate(returnDate)}.</>}
            </span>
            {overBalance && <span className="block text-danger mt-1">This is more than the {balance?.remainingDays} day(s) available. The server may reject it or treat the rest as unpaid, depending on the leave type.</span>}
          </div>
        )}

        {selectedType?.documentRequired && (
          <div className="sm:pl-[182px] text-xs text-label-secondary pb-1">
            {selectedType.name} {selectedType.documentRequiredAfterDays > 0 ? `over ${selectedType.documentRequiredAfterDays} day(s) ` : ""}needs a supporting document - upload it under the employee&apos;s Documents first.
          </div>
        )}

        <div data-testid="leave-form-approvers">
          {approverRows.map((a) => (
            <SapField key={a.stepOrder} label={a.label}>
              <input readOnly tabIndex={-1} value={a.value} aria-label={a.label} className={readOnlyClass} />
            </SapField>
          ))}
        </div>

        <SapField label="New Note" htmlFor="leave-reason">
          <textarea id="leave-reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} />
        </SapField>
      </SapSection>

      </div>
      <div className="min-w-0">
      <SapSection title="Additional Data" collapsible={false}>
        {reliefCandidates.length > 0 && (
          <SapField label="Relief person" htmlFor="leave-relief">
            <select id="leave-relief" value={delegateEmployeeId} onChange={(e) => setDelegateEmployeeId(e.target.value)} className={fieldClass} aria-label="Relief person (optional)">
              <option value="">No relief person</option>
              {reliefCandidates.map((emp) => (
                <option key={emp.employeeId} value={emp.employeeId}>
                  {emp.employeeName} ({emp.employeeNumber})
                </option>
              ))}
            </select>
          </SapField>
        )}
        <div data-testid="leave-form-computed">
          <SapField label="Working days">
            <input readOnly tabIndex={-1} value={consumed === null ? "" : String(consumed)} aria-label="Working days" className={`${readOnlyClass} text-right`} />
          </SapField>
          <SapField label="Absence days">
            <input readOnly tabIndex={-1} value={startDate && effectiveEnd >= startDate ? String(calendarDays) : ""} aria-label="Absence days" className={`${readOnlyClass} text-right`} />
          </SapField>
          <SapField label="Return date">
            <input readOnly tabIndex={-1} value={returnDate ? formatDisplayDate(returnDate) : ""} aria-label="Return date" className={readOnlyClass} />
          </SapField>
        </div>
      </SapSection>

      {employeeId && startDate && (
        <SapSection title="Team" collapsible>
          <TeamCalendar employeeId={employeeId} holidays={holidayDates} weekend={[0, 6]} initialDate={startDate} />
        </SapSection>
      )}
      </div>
      </div>

      {error && <div className="text-danger text-sm px-1 mb-2" role="alert">{error}</div>}

      <SapFooter>
        <button type="submit" disabled={submitting} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          {submitting ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setConfirmCancel(true)} className="border border-accent text-accent rounded px-4 py-1.5 text-sm font-semibold">
          Cancel
        </button>
      </SapFooter>
      {confirmCancel && <SapConfirm message="Cancel and discard all changes?" onConfirm={onCancel} onCancel={() => setConfirmCancel(false)} />}
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
          {w.employeeFullName}: {formatPeriod(w.startDate, w.endDate)}
        </div>
      ))}
      <div className="text-amber-800">This is just a notice — your request was still submitted.</div>
    </div>
  );
}
