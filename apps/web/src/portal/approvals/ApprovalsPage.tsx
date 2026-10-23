import { useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, CheckCircle2, ClipboardCheck, FileClock, Inbox, Timer } from "lucide-react";
import { api, ApiError } from "../../api/client";
import { useModuleContext, useBuildModuleContext, type ModuleContext } from "../shared/ModuleContext";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { ageText, itemsForTab, KIND_LABELS, tabCount, type ApprovalItem, type ApprovalKind, type ApprovalTab } from "./approvals";
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

async function decide(item: ApprovalItem, decision: "approved" | "rejected", comment: string) {
  const note = comment.trim() || undefined;
  if (item.kind === "timesheet") await api.decideTimesheet(item.id, { decision, comment: note });
  else if (item.kind === "correction") await api.decideAttendanceCorrection(item.id, { decision, comment: note });
  else await api.decideLeaveRequest(item.id, { decision, comment: note });
}

function Row({ item, mine, onDone }: { item: ApprovalItem; mine: boolean; onDone: () => void }) {
  const [refusing, setRefusing] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = KIND_ICON[item.kind];

  async function run(decision: "approved" | "rejected") {
    if (decision === "rejected" && !comment.trim()) {
      setError("Say why, so the person knows.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await decide(item, decision, comment);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
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
            <Link to={item.to} className="font-semibold text-sm hover:underline">{mine ? item.title : item.who}</Link>
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
                <button disabled={busy} onClick={() => setRefusing(true)} className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-black/5 text-danger">
                  Refuse
                </button>
              </>
            )}
            <Link to={item.to} className="text-xs font-semibold text-accent hover:underline">Open</Link>
          </div>
        )}
      </div>
      {refusing && (
        <div className="mt-3 pt-3 border-t border-black/5 flex items-center gap-2 flex-wrap">
          <label htmlFor={`why-${item.key}`} className="sr-only">Reason</label>
          <input id={`why-${item.key}`} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason (required)" className="flex-1 min-w-[12rem] rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent" />
          <button disabled={busy} onClick={() => run("rejected")} className="text-xs font-semibold rounded-lg px-3 py-1.5 text-white bg-danger disabled:opacity-50">Confirm refusal</button>
          <button onClick={() => setRefusing(false)} className="text-xs text-label-tertiary">Cancel</button>
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
      <PageHeader title="Approvals" subtitle={canDecide ? "Items waiting for your decision, and the requests you have sent. Approving is one click; refusing asks for a reason." : "The requests you have sent and where they are."} />
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
