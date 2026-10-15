import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Pencil, XCircle } from "lucide-react";
import type { HolidayView, LeaveBalanceView, LeaveRequestStatus, LeaveRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import {
  buildMonth,
  formatDisplayDate,
  formatDisplayRange,
  formatLongRange,
  nextMonth,
  previousMonth,
  weekdayLabels,
  type CalendarCell,
} from "./leaveCalendar";
import { STATUS_LABELS, leaveTypeLabel } from "./leaveLabels";
import { approverStepLabel, approverSummary, groupApprovalSteps } from "./leaveApprovals";
import { TeamCalendar } from "./TeamCalendar";
import { SapSection } from "../shared/FormSections";

/**
 * "My Leave Request" overview, laid out like the SAP Fiori screen the product owner asked us to match:
 * an Entitlement table (Available / Planned / Used / Entitlement) above a Request Overview with a
 * Calendar tab and an Items tab. Everything shown here already exists in the API; nothing is invented.
 */

/** Status text colour; kept as text (not a pill) the way the reference screen shows it. */
const STATUS_TEXT: Record<LeaveRequestStatus, string> = {
  pending: "text-amber-700",
  approved: "text-green-700",
  rejected: "text-red-700",
  cancelled: "text-label-tertiary",
};

const CALENDAR_STATUS_CLASS: Record<LeaveRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
  approved: "bg-green-100 text-green-900 ring-1 ring-green-300",
  rejected: "bg-pink-100 text-pink-900 ring-1 ring-pink-300",
  cancelled: "",
};

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong.";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Requests that still occupy days on the calendar. */
function isLive(r: LeaveRequestView): boolean {
  return r.status === "pending" || r.status === "approved";
}

export function EntitlementTable({ balances, requests }: { balances: LeaveBalanceView[]; requests: LeaveRequestView[] }) {
  return (
    <div data-testid="leave-balance-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-label-tertiary border-b border-black/10">
              <th className="py-2 pr-3 font-medium">Quota Type</th>
              <th className="py-2 pr-3 font-medium">Validity</th>
              <th className="py-2 pr-3 font-medium text-right">Available</th>
              <th className="py-2 pr-3 font-medium text-right">Planned</th>
              <th className="py-2 pr-3 font-medium text-right">Used</th>
              <th className="py-2 font-medium text-right">Entitlement</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => {
              // "Planned" is leave that has been asked for but not yet approved.
              const planned = requests
                .filter((r) => r.status === "pending" && r.leaveType === b.leaveType && Number(r.startDate.slice(0, 4)) === b.year)
                .reduce((sum, r) => sum + r.daysRequested, 0);
              return (
                <tr key={`${b.leaveType}-${b.year}`} className="border-b border-black/5 last:border-0">
                  <td className="py-2.5 pr-3 font-semibold">{b.leaveTypeName ?? leaveTypeLabel(b.leaveType)}</td>
                  <td className="py-2.5 pr-3 text-label-secondary tabular-nums">
                    {formatDisplayRange(`${b.year}-01-01`, `${b.year}-12-31`)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    <span className="font-semibold">{b.remainingDays}</span> <span className="text-label-tertiary">Days</span>
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-label-secondary">{planned} Days</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-label-secondary">{b.usedDays} Days</td>
                  <td className="py-2.5 text-right tabular-nums text-label-secondary">{b.entitledDays} Days</td>
                </tr>
              );
            })}
            {balances.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-label-tertiary">
                  No leave entitlement has been assigned yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const APPROVAL_STATUS_TEXT: Record<string, string> = { pending: "Waiting", escalated: "Escalated", approved: "Approved", rejected: "Rejected" };
const APPROVAL_STATUS_CLASS: Record<string, string> = {
  pending: "text-amber-700",
  escalated: "text-amber-700",
  approved: "text-green-700",
  rejected: "text-red-700",
};

/**
 * The request's own page, laid out like the reference's "Show Request Details": a header (leave type, dates,
 * absence days, quota used, created on, approver, status), the approval chain, the rest of the fields, and the
 * Team calendar underneath.
 */
export function RequestDetail({
  request,
  holidays,
  weekend,
}: {
  request: LeaveRequestView;
  holidays: ReadonlyMap<string, string>;
  weekend: readonly number[];
}) {
  const approver = approverSummary(request.status, request.approvals);
  const steps = groupApprovalSteps(request.approvals);
  const absenceDays = request.absenceDays ?? 0;
  return (
    <div className="rounded-lg border border-black/10 bg-surface p-4 space-y-4" data-testid="leave-request-detail">
      <header className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-full bg-accent/10 text-accent flex items-center justify-center shrink-0" aria-hidden>
          <CalendarDays size={22} strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-lg font-bold leading-tight">{request.leaveTypeName ?? leaveTypeLabel(request.leaveType)}</h4>
          <p className="text-xs text-label-secondary tabular-nums">{formatLongRange(request.startDate, request.endDate)}</p>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-label-tertiary">Absence Days:</dt>
          <dd className="tabular-nums">{absenceDays} {absenceDays === 1 ? "Day" : "Days"}</dd>
          <dt className="text-label-tertiary">Quota Used:</dt>
          <dd className="tabular-nums">{request.daysRequested} {request.daysRequested === 1 ? "Day" : "Days"}</dd>
          <dt className="text-label-tertiary">Created on:</dt>
          <dd className="tabular-nums">{formatDisplayDate(request.createdAt.slice(0, 10))}</dd>
          {approver && (
            <>
              <dt className="text-label-tertiary">Approver:</dt>
              <dd>{approver}</dd>
            </>
          )}
          <dt className="text-label-tertiary">Status:</dt>
          <dd className={`font-semibold ${STATUS_TEXT[request.status]}`}>{STATUS_LABELS[request.status]}</dd>
        </dl>
      </header>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
        {request.employeeName && (
          <div>
            <dt className="text-label-tertiary">Employee</dt>
            <dd className="font-medium">
              {request.employeeName}
              {request.employeeNumber ? ` (${request.employeeNumber})` : ""}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-label-tertiary">Working days</dt>
          <dd className="font-medium tabular-nums">{request.daysRequested}</dd>
        </div>
        <div>
          <dt className="text-label-tertiary">Return date</dt>
          <dd className="font-medium tabular-nums">{request.returnDate ? formatDisplayDate(request.returnDate) : "—"}</dd>
        </div>
        <div>
          <dt className="text-label-tertiary">Relief person</dt>
          <dd className="font-medium">{request.delegateEmployeeName ?? "—"}</dd>
        </div>
        {request.dayPart !== "full" && (
          <div>
            <dt className="text-label-tertiary">Duration</dt>
            <dd className="font-medium">{request.dayPart === "first_half" ? "First half of the day" : "Second half of the day"}</dd>
          </div>
        )}
        {request.payrollImpact && (
          <div>
            <dt className="text-label-tertiary">Payroll</dt>
            <dd className="font-medium">Unpaid, deducted in payroll</dd>
          </div>
        )}
        {request.isOnBehalf && (
          <div>
            <dt className="text-label-tertiary">Submitted</dt>
            <dd className="font-medium">On behalf of the employee</dd>
          </div>
        )}
        {request.reason && (
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-label-tertiary">Note</dt>
            <dd>{request.reason}</dd>
          </div>
        )}
        {request.rejectionReason && (
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-label-tertiary">Rejection reason</dt>
            <dd className="text-red-700">{request.rejectionReason}</dd>
          </div>
        )}
        {request.cancellationStatus && (
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-label-tertiary">Cancellation</dt>
            <dd>
              {request.cancellationStatus === "requested" ? "Requested, waiting for a decision" : request.cancellationStatus === "approved" ? "Approved" : "Declined"}
              {request.cancellationReason ? `, “${request.cancellationReason}”` : ""}
            </dd>
          </div>
        )}
      </dl>

      {steps.length > 0 && (
        <section aria-label="Approval chain" data-testid="leave-approval-chain">
          <h4 className="text-xs font-semibold text-label-tertiary mb-1">Approval</h4>
          <ol className="space-y-1">
            {steps.map((step) => (
              <li key={step.stepOrder} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                <span className="text-label-tertiary w-36 shrink-0">{approverStepLabel(step.stepOrder)}</span>
                <span className="font-medium">{step.names.length > 0 ? step.names.join(", ") : step.stepName}</span>
                <span className={`font-semibold ${APPROVAL_STATUS_CLASS[step.status]}`}>{APPROVAL_STATUS_TEXT[step.status]}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <TeamCalendar employeeId={request.employeeId} holidays={holidays} weekend={weekend} initialDate={request.startDate} />
    </div>
  );
}

/**
 * The list rows already carry the approval chain, but the detail re-reads the one request so it shows the
 * freshest approver state when it is opened; if that read fails the row's own data is shown instead.
 */
export function DetailLoader({ request, holidays, weekend }: { request: LeaveRequestView; holidays: ReadonlyMap<string, string>; weekend: readonly number[] }) {
  const [fresh, setFresh] = useState<LeaveRequestView | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getLeaveRequest(request.id)
      .then((r) => {
        if (!cancelled) setFresh(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [request.id, request.updatedAt]);
  return <RequestDetail request={fresh ?? request} holidays={holidays} weekend={weekend} />;
}

function ItemsTable({
  requests,
  onOpen,
  onChanged,
  onEdit,
}: {
  requests: LeaveRequestView[];
  /** Opens the request's own page. */
  onOpen: (request: LeaveRequestView) => void;
  onChanged: () => void;
  /** Present only when the viewer may edit requests; offered on pending ones. */
  onEdit?: (request: LeaveRequestView) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function withdraw(r: LeaveRequestView) {
    setError(null);
    if (r.status === "pending") {
      if (!window.confirm("Do you really want to cancel this request?")) return;
      setBusyId(r.id);
      try {
        await api.cancelLeaveRequest(r.id);
        onChanged();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusyId(null);
      }
      return;
    }
    const reason = window.prompt("Why does this approved leave need to be cancelled?");
    if (!reason || reason.trim().length < 3) return;
    setBusyId(r.id);
    try {
      await api.requestLeaveCancellation(r.id, { reason: reason.trim() });
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (requests.length === 0) {
    return <p className="text-sm text-label-tertiary py-3">No leave requests yet. Pick dates on the calendar or use Create Request.</p>;
  }

  return (
    <div className="overflow-x-auto" data-testid="leave-requests">
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-label-tertiary border-b border-black/10">
            <th className="py-2 pr-3 font-medium">Leave Type</th>
            <th className="py-2 pr-3 font-medium">Validity</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Approver</th>
            <th className="py-2 pr-3 font-medium text-right">Quota Used</th>
            <th className="py-2 w-24" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => {
            const cancellationRequested = r.status === "approved" && r.cancellationStatus === "requested";
            const canWithdraw = (r.status === "pending" || r.status === "approved") && !cancellationRequested;
            return (
              <tr key={r.id} className="border-b border-black/5 hover:bg-black/[0.02]">
                  <td className="py-2.5 pr-3 font-semibold">{r.leaveTypeName ?? leaveTypeLabel(r.leaveType)}</td>
                  <td className="py-2.5 pr-3 text-label-secondary tabular-nums">{formatDisplayRange(r.startDate, r.endDate)}</td>
                  <td className={`py-2.5 pr-3 font-medium ${STATUS_TEXT[r.status]}`}>
                    {STATUS_LABELS[r.status]}
                    {cancellationRequested && <span className="block text-xs font-normal text-label-tertiary">Cancellation requested</span>}
                  </td>
                  <td className="py-2.5 pr-3 text-label-secondary">{approverSummary(r.status, r.approvals) ?? ""}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    <span className="font-semibold">{r.daysRequested}</span> <span className="text-label-tertiary">{r.daysRequested === 1 ? "Day" : "Days"}</span>
                  </td>
                  <td className="py-2.5 text-right whitespace-nowrap">
                    {onEdit && r.status === "pending" && (
                      <button
                        type="button"
                        onClick={() => onEdit(r)}
                        title="Edit request"
                        aria-label="Edit request"
                        className="inline-flex p-1 text-accent hover:text-accent-dark"
                      >
                        <Pencil size={17} strokeWidth={1.75} />
                      </button>
                    )}
                    {canWithdraw && (
                      <button
                        type="button"
                        onClick={() => withdraw(r)}
                        disabled={busyId === r.id}
                        title={r.status === "pending" ? "Cancel request" : "Request cancellation"}
                        aria-label={r.status === "pending" ? "Cancel request" : "Request cancellation"}
                        className="inline-flex p-1 text-accent hover:text-danger disabled:opacity-40"
                      >
                        <XCircle size={18} strokeWidth={1.75} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(r)}
                      aria-label="Show details"
                      title="Show details"
                      className="inline-flex p-1 text-label-tertiary hover:text-accent"
                    >
                      <ChevronRight size={18} strokeWidth={1.75} />
                    </button>
                  </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MonthGrid({
  year,
  month,
  holidays,
  requests,
  selectedStart,
  selectedEnd,
  onPick,
  weekend,
  weekStart,
}: {
  year: number;
  month: number;
  holidays: Map<string, string>;
  requests: LeaveRequestView[];
  selectedStart: string | null;
  selectedEnd: string | null;
  onPick: (cell: CalendarCell) => void;
  weekend: readonly number[];
  weekStart: number;
}) {
  const grid = useMemo(() => buildMonth(year, month, holidays, weekend, weekStart), [year, month, holidays, weekend, weekStart]);
  const today = todayIso();
  const liveRequests = requests.filter(isLive);

  function cellRequests(date: string): LeaveRequestView[] {
    return liveRequests.filter((r) => r.startDate <= date && date <= r.endDate);
  }

  return (
    <div className="min-w-[250px]">
      <div className="text-center text-sm font-semibold text-accent mb-2">{grid.label}</div>
      <div className="grid grid-cols-[24px_repeat(7,minmax(0,1fr))] gap-x-1 gap-y-1 text-center text-xs">
        <div aria-hidden />
        {weekdayLabels(weekStart).map((d) => (
          <div key={d} className="text-label-tertiary">
            {d}
          </div>
        ))}
        {grid.weeks.map((week, wi) => {
          const firstCell = week.find((c) => c !== null);
          return (
            <Fragment key={`w-${wi}`}>
              <div className="text-[10px] text-label-tertiary self-center tabular-nums" aria-label={firstCell ? `Week ${isoWeekNumber(firstCell.date)}` : undefined}>
                {firstCell ? isoWeekNumber(firstCell.date) : ""}
              </div>
              {week.map((cell, i) => {
                if (!cell) return <div key={`pad-${wi}-${i}`} />;
                const hits = cellRequests(cell.date);
                const inSelection =
                  selectedStart !== null &&
                  (selectedEnd === null ? cell.date === selectedStart : selectedStart <= cell.date && cell.date <= selectedEnd);
                let tone = "hover:bg-accent/10";
                if (cell.kind === "non_working") tone = "bg-black/[0.07] text-label-secondary";
                if (cell.kind === "holiday") tone = "bg-slate-200 text-slate-800";
                if (hits.length > 1) tone = "bg-purple-100 text-purple-900 ring-1 ring-purple-300";
                else if (hits.length === 1) tone = CALENDAR_STATUS_CLASS[hits[0].status];
                if (inSelection) tone = "bg-accent text-white";
                const label = [formatDisplayDate(cell.date), cell.holidayName, ...hits.map((h) => `${h.leaveTypeName ?? leaveTypeLabel(h.leaveType)}, ${STATUS_LABELS[h.status]}`)].filter(Boolean).join(" - ");
                return (
                  <button
                    key={cell.date}
                    type="button"
                    onClick={() => onPick(cell)}
                    title={label}
                    aria-label={label}
                    aria-pressed={inSelection}
                    className={`h-7 rounded-sm text-xs tabular-nums ${tone} ${cell.date === today ? "outline outline-1 outline-purple-600 outline-offset-[-2px] rounded-md" : ""}`}
                  >
                    {cell.dayOfMonth}
                  </button>
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** ISO week number of a yyyy-mm-dd date, for the calendar's week column. */
function isoWeekNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
}

const LEGEND: { label: string; swatch: string }[] = [
  { label: "Today", swatch: "border-2 border-purple-600 bg-white" },
  { label: "Selected", swatch: "bg-accent" },
  { label: "Working Day", swatch: "bg-surface border border-black/10" },
  { label: "Non-Working Day", swatch: "bg-black/[0.06]" },
  { label: "Approved / Informed", swatch: "bg-green-600" },
  { label: "Pending", swatch: "bg-amber-500" },
  { label: "Rejected", swatch: "bg-pink-600" },
  { label: "Public Holiday", swatch: "bg-slate-500" },
  { label: "Multiple Entries", swatch: "bg-purple-700" },
];

export function LeaveCalendar({
  holidays,
  requests,
  onRangeSelected,
  onOpenRequest,
  weekend,
  weekStart,
}: {
  holidays: Map<string, string>;
  requests: LeaveRequestView[];
  onRangeSelected: (start: string, end: string) => void;
  onOpenRequest: (id: string) => void;
  weekend: readonly number[];
  weekStart: number;
}) {
  const now = new Date();
  const [first, setFirst] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const second = nextMonth(first.year, first.month);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);

  function pick(cell: CalendarCell) {
    const hit = requests.find((r) => isLive(r) && r.startDate <= cell.date && cell.date <= r.endDate);
    // First click begins a range (or, on a day that already has a request, opens that request).
    if (start === null || end !== null) {
      if (hit && start === null) {
        onOpenRequest(hit.id);
        return;
      }
      setStart(cell.date);
      setEnd(null);
      return;
    }
    const [a, b] = cell.date < start ? [cell.date, start] : [start, cell.date];
    setStart(a);
    setEnd(b);
    onRangeSelected(a, b);
  }

  return (
    <div>
      <p className="text-xs bg-sky-50 border border-sky-200 text-sky-900 rounded-lg px-3 py-2 mb-3">
        Select a start and end date to create a new request; click an existing request to display it.
      </p>
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setFirst(previousMonth(first.year, first.month))}
          className="mt-0.5 p-1 text-accent"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <MonthGrid year={first.year} month={first.month} holidays={holidays} requests={requests} selectedStart={start} selectedEnd={end} onPick={pick} weekend={weekend} weekStart={weekStart} />
          <MonthGrid year={second.year} month={second.month} holidays={holidays} requests={requests} selectedStart={start} selectedEnd={end} onPick={pick} weekend={weekend} weekStart={weekStart} />
        </div>
        <button type="button" aria-label="Next month" onClick={() => setFirst(nextMonth(first.year, first.month))} className="mt-0.5 p-1 text-accent">
          <ChevronRight size={18} />
        </button>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-4 text-xs text-label-secondary" aria-label="Calendar legend">
        {LEGEND.map((l) => (
          <li key={l.label} className="flex items-center gap-1.5">
            <span className={`inline-block w-3 h-3 rounded-sm ${l.swatch}`} aria-hidden />
            {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The overview page body: Entitlement table, then Request Overview with its Calendar / Items tabs. Every
 * action goes to its own page: picking two calendar days opens the Create Request page with those dates, the
 * pencil opens the edit page, and the chevron (or a request on the calendar) opens the request's page.
 * `onBehalf` keeps the acting-on-behalf employee in the links so the banner follows.
 */
export function MyLeaveOverview({
  employeeId,
  refreshKey,
  canSubmit,
  onChanged,
  onBehalf = false,
}: {
  employeeId: string;
  refreshKey: number;
  canSubmit: boolean;
  onChanged: () => void;
  onBehalf?: boolean;
}) {
  const navigate = useNavigate();
  const [balances, setBalances] = useState<LeaveBalanceView[] | null>(null);
  const [requests, setRequests] = useState<LeaveRequestView[] | null>(null);
  const [holidayList, setHolidayList] = useState<HolidayView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"calendar" | "items">("items");
  // "Show From": requests that ended before this date are hidden. Defaults to the start of this year.
  const [showFrom, setShowFrom] = useState(`${new Date().getUTCFullYear()}-01-01`);
  const suffix = onBehalf ? `employee=${employeeId}` : "";

  useEffect(() => {
    Promise.all([api.getLeaveBalances(employeeId), api.listLeaveRequests(employeeId)])
      .then(([bal, reqs]) => {
        setBalances(bal);
        setRequests(reqs);
      })
      .catch((err) => setError(describeError(err)));
  }, [employeeId, refreshKey]);

  useEffect(() => {
    const y = new Date().getUTCFullYear();
    // The calendar can show December and January together, so fetch both years; a failure only loses the holiday shading.
    Promise.all([api.listHolidays(String(y)), api.listHolidays(String(y + 1))])
      .then(([a, b]) => setHolidayList([...a, ...b]))
      .catch(() => undefined);
  }, []);

  const holidays = useMemo(() => new Map(holidayList.filter((h) => !h.isOptional).map((h) => [h.holidayDate.slice(0, 10), h.name])), [holidayList]);

  if (error) return <p className="text-sm text-label-tertiary">{error}</p>;
  if (!balances || !requests) return <p className="text-sm text-label-tertiary">Loading…</p>;

  // Newest first, like the reference list.
  const visibleRequests = showFrom ? requests.filter((r) => r.endDate >= showFrom) : requests;
  const sorted = [...visibleRequests].sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));
  const openRequest = (id: string) => navigate(`/app/leave/${id}${suffix ? `?${suffix}` : ""}`);

  return (
    <div>
      <SapSection title="Entitlement" count={balances.length}>
        <EntitlementTable balances={balances} requests={requests} />
      </SapSection>

      <SapSection title="Request Overview">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div role="tablist" aria-label="Request overview views" className="flex gap-2">
            {(
              [
                ["calendar", "Calendar"],
                ["items", `Items (${visibleRequests.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                type="button"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`text-xs font-semibold rounded-md px-3 py-1 border ${tab === key ? "border-accent bg-accent/10 text-accent" : "border-accent/50 text-accent bg-white"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-label-secondary">
            <span className="font-semibold">Show From</span>
            <input
              type="date"
              value={showFrom}
              onChange={(e) => setShowFrom(e.target.value)}
              aria-label="Show requests from"
              className="rounded border border-black/25 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        </div>
        {tab === "calendar" ? (
          <LeaveCalendar
            holidays={holidays}
            requests={requests}
            onRangeSelected={(s, e) => canSubmit && navigate(`/app/leave/new?start=${s}&end=${e}${suffix ? `&${suffix}` : ""}`)}
            onOpenRequest={openRequest}
            weekend={[0, 6]}
            weekStart={1}
          />
        ) : (
          <ItemsTable
            requests={sorted}
            onOpen={(r) => openRequest(r.id)}
            onChanged={onChanged}
            onEdit={canSubmit ? (r) => navigate(`/app/leave/${r.id}/edit${suffix ? `?${suffix}` : ""}`) : undefined}
          />
        )}
      </SapSection>
    </div>
  );
}

export { formatDisplayDate };
