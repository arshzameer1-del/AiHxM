import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, XCircle } from "lucide-react";
import type { HolidayView, LeaveBalanceView, LeaveRequestStatus, LeaveRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import {
  buildMonth,
  formatDisplayDate,
  formatDisplayRange,
  nextMonth,
  previousMonth,
  weekdayLabels,
  type CalendarCell,
} from "./leaveCalendar";
import { STATUS_LABELS, leaveTypeLabel } from "./leaveLabels";

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
    <section className="mb-5" aria-labelledby="leave-entitlement-heading" data-testid="leave-balance-card">
      <h3 id="leave-entitlement-heading" className="text-sm font-semibold mb-2">
        Entitlement <span className="text-label-tertiary font-normal">({balances.length})</span>
      </h3>
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
    </section>
  );
}

function RequestDetail({ request }: { request: LeaveRequestView }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs bg-black/[0.03] rounded-lg p-3">
      <div>
        <dt className="text-label-tertiary">Leave type</dt>
        <dd className="font-medium">{leaveTypeLabel(request.leaveType)}</dd>
      </div>
      <div>
        <dt className="text-label-tertiary">Days requested</dt>
        <dd className="font-medium tabular-nums">{request.daysRequested}</dd>
      </div>
      <div>
        <dt className="text-label-tertiary">Return date</dt>
        <dd className="font-medium tabular-nums">{request.returnDate ? formatDisplayDate(request.returnDate) : "—"}</dd>
      </div>
      <div>
        <dt className="text-label-tertiary">Submitted</dt>
        <dd className="font-medium tabular-nums">{formatDisplayDate(request.createdAt.slice(0, 10))}</dd>
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
  );
}

function ItemsTable({
  requests,
  expandedId,
  onToggle,
  onChanged,
}: {
  requests: LeaveRequestView[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onChanged: () => void;
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
    return <p className="text-sm text-label-tertiary py-3">No leave requests yet. Pick dates on the calendar or use Request Leave.</p>;
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
            <th className="py-2 pr-3 font-medium text-right">Quota Used</th>
            <th className="py-2 w-20" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => {
            const open = expandedId === r.id;
            const cancellationRequested = r.status === "approved" && r.cancellationStatus === "requested";
            const canWithdraw = (r.status === "pending" || r.status === "approved") && !cancellationRequested;
            return (
              <Fragment key={r.id}>
                <tr className={`border-b border-black/5 ${open ? "bg-black/[0.02]" : ""}`}>
                  <td className="py-2.5 pr-3 font-semibold">{leaveTypeLabel(r.leaveType)}</td>
                  <td className="py-2.5 pr-3 text-label-secondary tabular-nums">{formatDisplayRange(r.startDate, r.endDate)}</td>
                  <td className={`py-2.5 pr-3 font-medium ${STATUS_TEXT[r.status]}`}>
                    {STATUS_LABELS[r.status]}
                    {cancellationRequested && <span className="block text-xs font-normal text-label-tertiary">Cancellation requested</span>}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    <span className="font-semibold">{r.daysRequested}</span> <span className="text-label-tertiary">{r.daysRequested === 1 ? "Day" : "Days"}</span>
                  </td>
                  <td className="py-2.5 text-right whitespace-nowrap">
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
                      onClick={() => onToggle(r.id)}
                      aria-expanded={open}
                      aria-label={open ? "Hide details" : "Show details"}
                      title={open ? "Hide details" : "Show details"}
                      className="inline-flex p-1 text-label-tertiary hover:text-accent"
                    >
                      {open ? <ChevronUp size={18} strokeWidth={1.75} /> : <ChevronDown size={18} strokeWidth={1.75} />}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={5} className="pb-3">
                      <RequestDetail request={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
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
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-label-tertiary mb-1">
        {weekdayLabels(weekStart).map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {grid.weeks.flat().map((cell, i) => {
          if (!cell) return <div key={`pad-${i}`} />;
          const hits = cellRequests(cell.date);
          const inSelection =
            selectedStart !== null &&
            (selectedEnd === null ? cell.date === selectedStart : selectedStart <= cell.date && cell.date <= selectedEnd);
          let tone = "bg-surface hover:bg-accent/10";
          if (cell.kind === "non_working") tone = "bg-black/[0.06] text-label-secondary";
          if (cell.kind === "holiday") tone = "bg-slate-200 text-slate-800";
          if (hits.length > 1) tone = "bg-purple-100 text-purple-900 ring-1 ring-purple-300";
          else if (hits.length === 1) tone = CALENDAR_STATUS_CLASS[hits[0].status];
          if (inSelection) tone = "bg-accent text-white";
          const label = [formatDisplayDate(cell.date), cell.holidayName, ...hits.map((h) => `${leaveTypeLabel(h.leaveType)}, ${STATUS_LABELS[h.status]}`)].filter(Boolean).join(" - ");
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => onPick(cell)}
              title={label}
              aria-label={label}
              aria-pressed={inSelection}
              className={`h-8 rounded text-xs tabular-nums ${tone} ${cell.date === today ? "outline outline-2 outline-purple-600 -outline-offset-2" : ""}`}
            >
              {cell.dayOfMonth}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const LEGEND: { label: string; swatch: string }[] = [
  { label: "Today", swatch: "border-2 border-purple-600 bg-white" },
  { label: "Selected", swatch: "bg-accent" },
  { label: "Working Day", swatch: "bg-surface border border-black/10" },
  { label: "Non-Working Day", swatch: "bg-black/[0.06]" },
  { label: "Approved", swatch: "bg-green-300" },
  { label: "Pending", swatch: "bg-amber-300" },
  { label: "Rejected", swatch: "bg-pink-300" },
  { label: "Public Holiday", swatch: "bg-slate-300" },
  { label: "Multiple Entries", swatch: "bg-purple-300" },
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
 * The whole overview: Entitlement table, then Request Overview with its Calendar / Items tabs.
 * `onCreateRange` is called when two calendar days are picked so the parent can open the request form
 * pre-filled with those dates, the way the reference screen does.
 */
export function MyLeaveOverview({
  employeeId,
  refreshKey,
  canSubmit,
  onChanged,
  onCreateRange,
}: {
  employeeId: string;
  refreshKey: number;
  canSubmit: boolean;
  onChanged: () => void;
  onCreateRange: (start: string, end: string) => void;
}) {
  const [balances, setBalances] = useState<LeaveBalanceView[] | null>(null);
  const [requests, setRequests] = useState<LeaveRequestView[] | null>(null);
  const [holidayList, setHolidayList] = useState<HolidayView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"calendar" | "items">("items");
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
  const sorted = [...requests].sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));

  function openRequest(id: string) {
    setTab("items");
    setExpandedId(id);
  }

  return (
    <div>
      <EntitlementTable balances={balances} requests={requests} />

      <section aria-labelledby="leave-overview-heading">
        <h3 id="leave-overview-heading" className="text-sm font-semibold mb-2">
          Request Overview
        </h3>
        <div role="tablist" aria-label="Request overview views" className="flex gap-2 mb-3">
          {(
            [
              ["calendar", "Calendar"],
              ["items", `Items (${requests.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`text-sm font-semibold rounded-full px-3 py-1 border ${tab === key ? "border-accent bg-accent/10 text-accent" : "border-black/10 text-label-secondary"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "calendar" ? (
          <LeaveCalendar
            holidays={holidays}
            requests={requests}
            onRangeSelected={(s, e) => canSubmit && onCreateRange(s, e)}
            onOpenRequest={openRequest}
            weekend={[0, 6]}
            weekStart={1}
          />
        ) : (
          <ItemsTable requests={sorted} expandedId={expandedId} onToggle={(id) => setExpandedId(expandedId === id ? null : id)} onChanged={onChanged} />
        )}
      </section>
    </div>
  );
}

export { formatDisplayDate };
