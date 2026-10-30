import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { EmployeeView, LeaveApproverPreviewView, LeaveBalanceView, LeaveColleagueView, LeaveDayPart, LeaveRequestView, LeaveType, LeaveTypeView, LeaveValidationFinding, LeaveValidationResult, OverlapWarning, SubmitLeaveRequestResponse } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LEAVE_TYPES, leaveTypeLabel } from "./leaveLabels";
import { countCalendarDays, countWorkingDays, formatDisplayDate, returnDateAfter } from "./leaveCalendar";
import { approverStepLabel, groupApprovalSteps } from "./leaveApprovals";
import { TeamCalendar } from "./TeamCalendar";
import { useFormSettings } from "../shared/useFormSettings";
import { SapConfirm, SapField, SapFooter, SapSection } from "../shared/FormSections";
import { formatPeriod } from "../shared/dates";
import { findingsFor, formatMinutes, formatUnits, isTimeMode, isTimeOnly, pruneAcks, toggleAck } from "./leaveUnits";

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
  const fs = useFormSettings("leave_request");
  const fsReason = fs("reason", { label: "New Note" });
  const fsRelief = fs("delegateEmployeeId", { label: "Relief person" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [approverPreview, setApproverPreview] = useState<LeaveApproverPreviewView[]>([]);
  // BACKLOG58: timed requests, the server's answer to "what would happen if I submitted this?", and the warnings the person confirmed.
  const [startTime, setStartTime] = useState(editing?.startTime?.slice(0, 5) ?? "");
  const [endTime, setEndTime] = useState(editing?.endTime?.slice(0, 5) ?? "");
  const [check, setCheck] = useState<LeaveValidationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [acks, setAcks] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [attachmentId, setAttachmentId] = useState(editing?.attachmentDocumentId ?? "");
  const [attachmentName, setAttachmentName] = useState("");
  const [uploading, setUploading] = useState(false);
  const checkSeq = useRef(0);

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
  const mode = selectedType?.durationMode ?? "full_day";
  const timeOnly = isTimeOnly(mode);
  const timeAvailable = isTimeMode(mode);
  const isTimed = !multiDay && dayPart === "hours";
  const tracksBalance = selectedType ? selectedType.tracksBalance : true;
  const year = startDate ? Number(startDate.slice(0, 4)) : new Date().getUTCFullYear();
  const balance = balances.find((b) => b.leaveType === leaveType && b.year === year);

  useEffect(() => {
    // A short-hours / hourly type is only ever requested by the hour on one day; a type without times never is.
    if (!selectedType) return;
    if (timeOnly) {
      setMultiDay(false);
      setDayPart("hours");
    } else if (!timeAvailable && dayPart === "hours") {
      setDayPart("full");
    }
  }, [selectedType, timeOnly, timeAvailable, dayPart]);

  const effectiveEnd = multiDay ? endDate : startDate;
  const consumed = useMemo(() => {
    if (!startDate || !effectiveEnd) return null;
    if (!multiDay && dayPart !== "full") return 0.5;
    return countWorkingDays(startDate, effectiveEnd, holidayDates);
  }, [startDate, effectiveEnd, multiDay, dayPart, holidayDates]);
  const calendarDays = startDate && effectiveEnd ? countCalendarDays(startDate, effectiveEnd) : 0;
  const returnDate = startDate && effectiveEnd && effectiveEnd >= startDate ? (!multiDay && dayPart === "first_half" ? startDate : returnDateAfter(effectiveEnd, holidayDates)) : null;
  const balanceUnit = balance?.unit ?? "days";
  const availableUnits = balance ? (balance.availableDays ?? balance.remainingDays) : 0;
  const overBalance = tracksBalance && !isTimed && balance !== undefined && consumed !== null && consumed > availableUnits;

  const reliefCandidates = colleagues;

  const timedPayload = isTimed ? { startTime: startTime || undefined, endTime: endTime || undefined } : {};

  // BACKLOG58: the server is the one that knows the schedule, breaks, balance and rules, so it prices and checks the
  // request as it is typed (the same code that decides on submit). Debounced; a late answer for an older edit is dropped.
  useEffect(() => {
    if (!employeeId || !startDate || !effectiveEnd || effectiveEnd < startDate) {
      setCheck(null);
      return;
    }
    const seq = ++checkSeq.current;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await api.validateLeaveRequest({
          employeeId,
          leaveType,
          startDate,
          endDate: effectiveEnd,
          reason: reason || undefined,
          dayPart: dayPart === "full" ? undefined : dayPart,
          delegateEmployeeId: delegateEmployeeId || undefined,
          attachmentDocumentId: attachmentId || undefined,
          acknowledgedWarnings: acks,
          excludeRequestId: editing?.id,
          ...timedPayload,
        });
        if (seq !== checkSeq.current) return;
        setCheck(res);
        setAcks((prev) => pruneAcks(prev, res));
        // A fixed-window leave type decides the times; show them.
        const st = res.settings;
        if (isTimed && st?.selectionMethod === "fixed_window" && st.fixedStartTime && st.fixedEndTime) {
          setStartTime(st.fixedStartTime.slice(0, 5));
          setEndTime(st.fixedEndTime.slice(0, 5));
        }
      } catch {
        if (seq === checkSeq.current) setCheck(null);
      } finally {
        if (seq === checkSeq.current) setChecking(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, leaveType, startDate, effectiveEnd, dayPart, startTime, endTime, reason, attachmentId, delegateEmployeeId, acks, editing?.id, isTimed]);

  const fixedWindow = isTimed && check?.settings?.selectionMethod === "fixed_window";
  const incrementSeconds = (check?.settings?.incrementMinutes ?? 1) * 60;
  // Messages for a time the person has not typed yet would only nag; they appear once they try to submit.
  const showFinding = (f: LeaveValidationFinding) => attempted || !(isTimed && (!startTime || !endTime) && (f.field === "startTime" || f.field === "endTime"));
  const needsAttachment = Boolean(selectedType?.documentRequired || attachmentId || findingsFor(check, "attachment").length > 0);
  // Messages that belong to a field are shown under it; the rest are listed together.
  const inlineFields = [...(isTimed ? ["startTime", "endTime"] : []), ...(needsAttachment ? ["attachment"] : [])];
  const inPanel = (f: LeaveValidationFinding) => showFinding(f) && !(f.field && inlineFields.includes(f.field));
  const blocking = (check?.blocking ?? []).filter(inPanel);
  // Warnings always sit in the list: each one carries its own "submit anyway" tick box.
  const warnings = (check?.warnings ?? []).filter(showFinding);
  const notices = check?.info ?? [];
  const fieldMessages = (field: string) => findingsFor(check, field).filter((f) => f.severity === "block" && showFinding(f));
  const duration = check?.duration ?? null;
  const checkedBalance = check?.balance ?? null;

  async function attach(file: File | undefined) {
    if (!file || !employeeId) return;
    setUploading(true);
    setError(null);
    try {
      const doc = await api.uploadEmployeeDocument(employeeId, { file, documentType: "other", note: "Leave supporting document", own: Boolean(fixedEmployeeId) });
      setAttachmentId(doc.id);
      setAttachmentName(file.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload that file.");
    } finally {
      setUploading(false);
    }
  }

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
    setAttempted(true);
    if (isTimed && (!startTime || !endTime)) {
      setError("Enter the start and end time.");
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
            attachmentDocumentId: attachmentId || null,
            acknowledgedWarnings: acks,
            ...timedPayload,
          })
        : await api.submitLeaveRequest({
            employeeId,
            leaveType,
            startDate,
            endDate: effectiveEnd,
            reason: reason || undefined,
            dayPart: dayPart === "full" ? undefined : dayPart,
            delegateEmployeeId: delegateEmployeeId || undefined,
            attachmentDocumentId: attachmentId || undefined,
            acknowledgedWarnings: acks,
            ...timedPayload,
          });
      onSubmitted(result);
    } catch (err) {
      // The server refuses with the full list of findings; show them next to the fields instead of one line.
      const body = err instanceof ApiError ? (err.body as { validation?: LeaveValidationResult } | undefined) : undefined;
      if (body?.validation) setCheck(body.validation);
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
                  {balance ? `${formatUnits(availableUnits, balanceUnit)} available` : "No balance has been set up for this leave type"}
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
              setStartTime("");
              setEndTime("");
              setAcks([]);
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
        {!timeOnly && <div role="radiogroup" aria-label="Request length" className="flex flex-wrap gap-x-6 gap-y-1 sm:pl-[182px] pb-1 text-sm">
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
        </div>}

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

        {!multiDay && !timeOnly && (halfDayAllowed || mode === "flexible_partial") && (
          <SapField label="Duration" htmlFor="leave-day-part">
            <select id="leave-day-part" value={dayPart} onChange={(e) => setDayPart(e.target.value as LeaveDayPart)} className={fieldClass}>
              <option value="full">Full day</option>
              {halfDayAllowed && <option value="first_half">First half of the day</option>}
              {halfDayAllowed && <option value="second_half">Second half of the day</option>}
              {mode === "flexible_partial" && <option value="hours">By hours</option>}
            </select>
          </SapField>
        )}

        {isTimed && (
          <div data-testid="leave-time-fields">
            <SapField
              label="Start time"
              htmlFor="leave-start-time"
              required
              hint={fieldMessages("startTime").map((f) => <FieldMessage key={f.ruleCode} finding={f} />)}
            >
              <input
                id="leave-start-time"
                type="time"
                step={incrementSeconds}
                value={startTime}
                readOnly={fixedWindow}
                onChange={(e) => setStartTime(e.target.value)}
                className={fixedWindow ? readOnlyClass : fieldClass}
                aria-invalid={fieldMessages("startTime").some((f) => f.severity === "block")}
              />
            </SapField>
            <SapField
              label="End time"
              htmlFor="leave-end-time"
              required
              hint={fieldMessages("endTime").map((f) => <FieldMessage key={f.ruleCode} finding={f} />)}
            >
              <input
                id="leave-end-time"
                type="time"
                step={incrementSeconds}
                value={endTime}
                readOnly={fixedWindow}
                onChange={(e) => setEndTime(e.target.value)}
                className={fixedWindow ? readOnlyClass : fieldClass}
                aria-invalid={fieldMessages("endTime").some((f) => f.severity === "block")}
              />
            </SapField>
            <SapField label="Duration">
              <input readOnly tabIndex={-1} aria-label="Duration" data-testid="leave-duration" value={duration ? formatMinutes(duration.durationMinutes) : ""} className={`${readOnlyClass} text-right`} />
              {duration && duration.breakMinutes > 0 && (
                <div className="text-xs text-label-secondary mt-1">
                  {formatMinutes(duration.breakMinutes)} of break {duration.breakMinutes === 1 ? "is" : "is"} not counted.
                </div>
              )}
              {duration && duration.scheduleStartTime && duration.scheduleEndTime && (
                <div className="text-xs text-label-tertiary mt-1">
                  Your shift that day: {duration.scheduleStartTime.slice(0, 5)} – {duration.scheduleEndTime.slice(0, 5)}
                  {duration.scheduleName ? ` (${duration.scheduleName})` : ""}
                </div>
              )}
            </SapField>
          </div>
        )}

        {isTimed && duration && (
          <div className="sm:pl-[182px] text-xs pb-1" data-testid="leave-timed-summary" aria-live="polite">
            <span className="font-semibold tabular-nums">
              {formatUnits(duration.balanceUnits, duration.balanceUnit)} will be deducted
            </span>
            {checkedBalance && (
              <span className="block text-label-secondary tabular-nums">
                {formatUnits(checkedBalance.available, checkedBalance.unit)} available for {checkedBalance.year}
                {checkedBalance.reserved > 0 ? ` (${formatUnits(checkedBalance.reserved, checkedBalance.unit)} already held by pending requests)` : ""}.
              </span>
            )}
          </div>
        )}
        {!isTimed && consumed !== null && startDate && effectiveEnd >= startDate && (
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
            {overBalance && <span className="block text-danger mt-1">This is more than the {availableUnits} {balanceUnit === "days" ? "day(s)" : balanceUnit} available. The server may reject it or treat the rest as unpaid, depending on the leave type.</span>}
          </div>
        )}

        {selectedType?.documentRequired && (
          <div className="sm:pl-[182px] text-xs text-label-secondary pb-1">
            {selectedType.name} {selectedType.documentRequiredAfterDays > 0 ? `over ${selectedType.documentRequiredAfterDays} day(s) ` : ""}needs a supporting document - upload it under the employee&apos;s Documents first.
          </div>
        )}

        {needsAttachment && employeeId && (
          <SapField label="Supporting document" htmlFor="leave-attachment" hint={fieldMessages("attachment").map((f) => <FieldMessage key={f.ruleCode} finding={f} />)}>
            <input id="leave-attachment" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" disabled={uploading} onChange={(e) => void attach(e.target.files?.[0])} className="text-xs" />
            {attachmentId && (
              <div className="text-xs text-label-secondary mt-1" data-testid="leave-attachment-name">
                Attached{attachmentName ? `: ${attachmentName}` : ""}.{" "}
                <button type="button" className="text-accent hover:underline" onClick={() => { setAttachmentId(""); setAttachmentName(""); }}>
                  Remove
                </button>
              </div>
            )}
          </SapField>
        )}

        {(blocking.length > 0 || warnings.length > 0 || notices.length > 0) && (
          <div className="sm:pl-[182px] pb-2 space-y-1.5" data-testid="leave-validation" aria-live="polite">
            {blocking.map((f) => (
              <div key={`b-${f.ruleCode}`} className="text-xs text-danger rounded border border-danger/30 bg-danger/5 px-2 py-1.5" role="alert" data-testid="leave-validation-block">
                {f.message}
              </div>
            ))}
            {warnings.map((f) => (
              <label key={`w-${f.ruleCode}`} className="flex items-start gap-2 text-xs rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900" data-testid="leave-validation-warning">
                {f.allowProceed ? (
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acks.includes(f.ruleCode)}
                    onChange={(e) => setAcks((prev) => toggleAck(prev, f.ruleCode, e.target.checked))}
                    aria-label={`Confirm: ${f.message}`}
                  />
                ) : (
                  <span aria-hidden="true">!</span>
                )}
                <span>
                  {f.message}
                  {f.allowProceed ? <span className="block text-amber-800">Tick the box to submit anyway.</span> : <span className="block">This cannot be submitted as it stands.</span>}
                </span>
              </label>
            ))}
            {notices.map((f) => (
              <div key={`i-${f.ruleCode}`} className="text-xs text-label-secondary" data-testid="leave-validation-info">
                {f.message}
              </div>
            ))}
          </div>
        )}
        {checking && <div className="sm:pl-[182px] text-xs text-label-tertiary pb-1">Checking…</div>}

        <div data-testid="leave-form-approvers">
          {approverRows.map((a) => (
            <SapField key={a.stepOrder} label={a.label}>
              <input readOnly tabIndex={-1} value={a.value} aria-label={a.label} className={readOnlyClass} />
            </SapField>
          ))}
        </div>

        {!fsReason.hidden && (
          <SapField label={fsReason.label} htmlFor="leave-reason" required={fsReason.required} hint={fsReason.helpText}>
            <textarea id="leave-reason" rows={4} value={reason} maxLength={fsReason.maxLength ?? undefined} placeholder={fsReason.placeholder ?? undefined} required={fsReason.required} onChange={(e) => setReason(e.target.value)} className={fieldClass} />
          </SapField>
        )}
      </SapSection>

      </div>
      <div className="min-w-0">
      <SapSection title="Additional Data" collapsible={false}>
        {reliefCandidates.length > 0 && !fsRelief.hidden && (
          <SapField label={fsRelief.label} htmlFor="leave-relief" required={fsRelief.required} hint={fsRelief.helpText}>
            <select id="leave-relief" value={delegateEmployeeId} onChange={(e) => setDelegateEmployeeId(e.target.value)} className={fieldClass} aria-label={fsRelief.required ? fsRelief.label : `${fsRelief.label} (optional)`} required={fsRelief.required}>
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
            <input readOnly tabIndex={-1} value={isTimed ? (duration ? String(duration.daysEquivalent) : "") : consumed === null ? "" : String(consumed)} aria-label="Working days" className={`${readOnlyClass} text-right`} />
          </SapField>
          <SapField label="Absence days">
            <input readOnly tabIndex={-1} value={startDate && effectiveEnd >= startDate ? String(isTimed ? 0 : calendarDays) : ""} aria-label="Absence days" className={`${readOnlyClass} text-right`} />
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

/** A validation message shown right under the field it belongs to. */
function FieldMessage({ finding }: { finding: LeaveValidationFinding }) {
  const cls = finding.severity === "block" ? "text-danger" : finding.severity === "warning" ? "text-amber-800" : "text-label-secondary";
  return (
    <span className={`block ${cls}`} data-testid={`leave-field-${finding.severity}`}>
      {finding.message}
    </span>
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
