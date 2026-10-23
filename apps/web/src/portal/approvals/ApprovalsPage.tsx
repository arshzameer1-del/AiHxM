import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, CheckCircle2, ClipboardCheck, FileClock, Inbox, Timer } from "lucide-react";
import { api, ApiError } from "../../api/client";
import { useModuleContext, useBuildModuleContext, type ModuleContext } from "../shared/ModuleContext";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay, formatWeekdayAndDate } from "../shared/dates";
import { ageText, itemsForTab, KIND_LABELS, tabCount, type ApprovalDetail, type ApprovalItem, type ApprovalKind, type ApprovalTab } from "./approvals";
import { useApprovals } from "./useApprovals";
import { Outlet, Route, Routes } from "react-router-dom";

const KIND_ICON: Record<ApprovalKind, typeof Inbox> = { leave: CalendarDays, timesheet: Timer, correction: FileClock };

const TABS: { key: ApprovalTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "leave", label: "Time off" },
  { key: "timesheet", label: "Timesheets" },
  { key: "correction", label: "Corrections" },
  { key: "mine", label: "My requests" },
];

type Decision = "approved" | "rejected" | "returned";

async function decide(item: ApprovalItem, decision: Decision, comment: string) {
  const note = comment.trim() || undefined;
  if (item.kind === "timesheet") await api.decideTimesheet(item.id, { decision, comment: note });
  else if (item.kind === "correction") await api.decideAttendanceCorrection(item.id, { decision: decision === "returned" ? "rejected" : decision, comment: note });
  else await api.decideLeaveRequest(item.id, { decision: decision === "returned" ? "rejected" : decision, comment: note });
}

function hoursText(minutes: number): string {
  return `${(minutes / 60).toFixed(2).replace(/\.?0+$/, "") || "0"}`;
}

function timeText(iso: string | null): string {
  if (!iso) return "not given";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "not given" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The submitted record, read-only, so the approver can decide without opening another page. */
function DetailPanel({ detail }: { detail: ApprovalDetail }) {
  const [projects, setProjects] = useState<Record<string, string>>({});
  useEffect(() => {
    if (detail.kind !== "timesheet" || !detail.lines.some((l) => l.costCenterId)) return;
    api.listCostCenters().then((c) => setProjects(Object.fromEntries(c.map((x) => [x.id, x.code ? `${x.code} · ${x.name}` : x.name])))).catch(() => undefined);
  }, [detail]);

  if (detail.kind === "correction") {
    return (
      <div className="mt-3 pt-3 border-t border-black/5 text-sm" data-testid="approval-detail">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><div className="text-xs text-label-tertiary">Day</div>{formatDay(detail.date)}</div>
          <div><div className="text-xs text-label-tertiary">Clock in</div>{timeText(detail.clockIn)}</div>
          <div><div className="text-xs text-label-tertiary">Clock out</div>{timeText(detail.clockOut)}</div>
          <div><div className="text-xs text-label-tertiary">Entered by</div>{detail.onBehalf ? "HR, on their behalf" : "The employee"}</div>
        </div>
        <p className="mt-2"><span className="text-xs text-label-tertiary">Reason: </span>{detail.reason}</p>
      </div>
    );
  }
  const shown = detail.days.filter((d) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return (w !== 0 && w !== 6) || detail.lines.some((l) => (l.minutesByDay[d] ?? 0) > 0);
  });
  return (
    <div className="mt-3 pt-3 border-t border-black/5 overflow-x-auto" data-testid="approval-detail">
      <table className="w-full text-xs min-w-[520px]">
        <thead>
          <tr className="text-left text-label-tertiary">
            <th className="font-semibold py-1 pr-2">Task</th>
            {shown.map((d) => <th key={d} className="font-normal text-center px-1">{formatWeekdayAndDate(d)}</th>)}
            <th className="font-semibold text-right pl-2">Total (h)</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((l) => (
            <tr key={l.key} className="border-t border-black/5">
              <td className="py-1 pr-2">
                <div className="font-semibold">{l.task || "No task"}</div>
                {(l.costCenterId || l.description) && (
                  <div className="text-label-tertiary">{[l.costCenterId ? projects[l.costCenterId] ?? "Project" : null, l.description || null].filter(Boolean).join(" · ")}</div>
                )}
              </td>
              {shown.map((d) => <td key={d} className="text-center tabular-nums">{l.minutesByDay[d] ? hoursText(l.minutesByDay[d]) : "·"}</td>)}
              <td className="text-right tabular-nums font-semibold pl-2">{hoursText(l.total)}</td>
            </tr>
          ))}
          <tr className="border-t border-black/10 font-semibold">
            <td className="py-1 pr-2">Submitted</td>
            {shown.map((d) => <td key={d} className="text-center tabular-nums">{hoursText(detail.lines.reduce((s, l) => s + (l.minutesByDay[d] ?? 0), 0))}</td>)}
            <td className="text-right tabular-nums pl-2">{hoursText(detail.totalMinutes)}</td>
          </tr>
          <tr className="text-label-tertiary">
            <td className="py-1 pr-2">Clock recorded</td>
            {shown.map((d) => <td key={d} className="text-center tabular-nums">{hoursText(detail.recordedByDay[d] ?? 0)}</td>)}
            <td className="text-right tabular-nums pl-2">{hoursText(detail.recordedMinutes)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Row({ item, mine, onDone }: { item: ApprovalItem; mine: boolean; onDone: () => void }) {
  const [refusing, setRefusing] = useState<null | "approved" | "rejected" | "returned">(null);
  // Whether approving needs a comment: known up front for leave, learned from the server's answer for the rest.
  const [approveNeedsComment, setApproveNeedsComment] = useState(Boolean(item.commentOnApprove));
  const [showDetail, setShowDetail] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = KIND_ICON[item.kind];

  async function run(decision: Decision) {
    if (decision !== "approved" && !comment.trim()) {
      setError("Say why, so the person knows.");
      return;
    }
    if (decision === "approved" && approveNeedsComment && !comment.trim()) {
      setRefusing("approved");
      setError("This step needs a comment to approve. Write it below.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await decide(item, decision, comment);
      onDone();
    } catch (err) {
      if (decision === "approved" && err instanceof ApiError && /comment is required when approving/i.test(err.message)) {
        setApproveNeedsComment(true);
        setRefusing("approved");
        setError("This step needs a comment to approve. Write it below.");
      } else {
        setError(err instanceof ApiError ? err.message : "That didn't work.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="approval-row bg-card rounded-card shadow-sm border border-black/5 p-4" data-testid={`approval-${item.key}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <span className="approval-kind-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.75} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/10 text-accent">{KIND_LABELS[item.kind]}</span>
            {item.kind === "leave" || mine ? (
              <Link to={item.to} className="font-semibold text-sm hover:underline">{mine ? item.title : item.who}</Link>
            ) : (
              <span className="font-semibold text-sm">{item.who}</span>
            )}
          </div>
          <div className="text-sm text-label-secondary mt-0.5">{mine ? item.detail : `${item.title} · ${item.detail}`}</div>
          <div className="text-xs text-label-tertiary mt-1">
            {item.stage}
            {item.waitingOn && <> · waiting on <span className="font-semibold text-label-secondary">{item.waitingOn}</span></>}
            {item.submittedAt && <> · sent {formatDay(item.submittedAt)} ({ageText(item.submittedAt)})</>}
          </div>
        </div>
        {!mine && (
          <div className="flex items-center gap-2 shrink-0">
            {!refusing && (
              <>
                <button disabled={busy} onClick={() => run("approved")} className="text-xs font-semibold rounded-lg px-3 py-1.5 text-white bg-success disabled:opacity-50" data-testid={`approve-${item.key}`}>
                  Approve
                </button>
                {item.kind === "timesheet" && (
                  <button disabled={busy} onClick={() => setRefusing("returned")} className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-black/5 text-label-secondary" data-testid={`send-back-${item.key}`}>
                    Send back
                  </button>
                )}
                <button disabled={busy} onClick={() => setRefusing("rejected")} className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-black/5 text-danger" data-testid={`refuse-${item.key}`}>
                  Refuse
                </button>
              </>
            )}
            {item.kind === "leave" || !item.record ? (
              <Link to={item.to} className="text-xs font-semibold text-accent hover:underline">Open</Link>
            ) : (
              <button type="button" onClick={() => setShowDetail(!showDetail)} aria-expanded={showDetail} data-testid={`details-${item.key}`} className="text-xs font-semibold text-accent hover:underline">
                {showDetail ? "Hide details" : "Details"}
              </button>
            )}
          </div>
        )}
      </div>
      {showDetail && item.record && <DetailPanel detail={item.record} />}
      {refusing && (
        <div className="mt-3 pt-3 border-t border-black/5 flex items-center gap-2 flex-wrap">
          <label htmlFor={`why-${item.key}`} className="sr-only">{refusing === "approved" ? "Comment" : "Reason"}</label>
          <input id={`why-${item.key}`} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={refusing === "returned" ? "What should they change? (required)" : refusing === "approved" ? "Comment (required)" : "Reason (required)"} className="flex-1 min-w-[12rem] rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent" />
          <button disabled={busy} onClick={() => run(refusing)} className={`text-xs font-semibold rounded-lg px-3 py-1.5 text-white disabled:opacity-50 ${refusing === "returned" ? "bg-accent" : refusing === "approved" ? "bg-success" : "bg-danger"}`} data-testid={`confirm-${refusing}-${item.key}`}>
            {refusing === "returned" ? "Send back" : refusing === "approved" ? "Confirm approval" : "Confirm refusal"}
          </button>
          <button onClick={() => { setRefusing(null); setError(null); }} className="text-xs text-label-tertiary">Cancel</button>
        </div>
      )}
      {error && <p className="text-xs text-danger mt-2" role="alert">{error}</p>}
    </li>
  );
}

/** One place for everything waiting on a decision, and for the requests you have in progress. */
export function ApprovalsPanel() {
  const { employeeId, canDecide, refreshKey, bump } = useModuleContext();
  const { loading, toDecide, mine, reload } = useApprovals(employeeId, canDecide, refreshKey);
  const [tab, setTab] = useState<ApprovalTab>(canDecide ? "all" : "mine");
  const visible = canDecide ? TABS : TABS.filter((t) => t.key === "mine");
  const rows = itemsForTab(tab, toDecide, mine);

  return (
    <div>
      <PageHeader title="Approvals" subtitle={canDecide ? "Items waiting for your decision, and the requests you have sent. Approving is one click unless the step asks for a comment; refusing asks for a reason." : "The requests you have sent and where they are."} />
      <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Approvals">
        {visible.map((t) => {
          const n = tabCount(t.key, toDecide, mine);
          return (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} data-testid={`approvals-tab-${t.key}`} className={`approvals-tab px-3 py-1.5 rounded-full text-sm font-semibold border ${tab === t.key ? "is-active" : ""}`}>
              {t.label} <span className="approvals-count tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>
      {loading ? (
        <LoadingNote what="approvals" />
      ) : rows.length === 0 ? (
        <div className="bg-card rounded-card shadow-sm p-8 text-center text-sm text-label-secondary" data-testid="approvals-empty">
          <CheckCircle2 className="mx-auto mb-2 text-success" size={26} aria-hidden="true" />
          {tab === "mine" ? "You have no requests in progress." : "Nothing is waiting for your decision."}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="approvals-list">
          {rows.map((i) => (
            <Row key={i.key} item={i} mine={tab === "mine"} onDone={() => { reload(); bump(); }} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function ApprovalsRoutes() {
  const ctx: ModuleContext = useBuildModuleContext();
  return (
    <Routes>
      <Route element={<Outlet context={ctx} />}>
        <Route index element={<ApprovalsPanel />} />
      </Route>
    </Routes>
  );
}

export const APPROVALS_ICON = ClipboardCheck;
