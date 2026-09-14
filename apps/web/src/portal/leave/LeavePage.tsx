import { useEffect, useState } from "react";
import type { AttendanceRecordView, EmployeeView, LeaveBalanceView, LeaveRequestView, OverlapWarning } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { LeaveRequestForm, OverlapNotice } from "./LeaveRequestForm";
import { LEAVE_TYPE_LABELS, STATUS_LABELS, STATUS_STYLES } from "./leaveLabels";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

/**
 * `attendance.record.self`/`leave_request.create.self` are both granted
 * only to `employee_self_service` (0016_leave_attendance_seed.sql) — one
 * role flag correctly gates both the clock-in widget and the self-submit
 * form here, they're not independent checks.
 */
function MyLeaveCard({
  employeeId,
  canSubmit,
  canClock,
  refreshKey,
  onChanged,
}: {
  employeeId: string;
  canSubmit: boolean;
  canClock: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [balances, setBalances] = useState<LeaveBalanceView[] | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRecordView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [overlapWarnings, setOverlapWarnings] = useState<OverlapWarning[]>([]);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getEmployee(employeeId),
      api.getLeaveBalances(employeeId),
      canClock ? api.listAttendance(employeeId) : Promise.resolve(null),
    ])
      .then(([emp, bal, att]) => {
        setEmployee(emp);
        setBalances(bal);
        if (att) setAttendance(att);
      })
      .catch((err) => setError(describeError(err)));
  }, [employeeId, refreshKey, canClock]);

  const clockedIn = Boolean(attendance && attendance.length > 0 && attendance[0].clockOutAt === null);

  async function handleClock() {
    if (!employee) return;
    setClockBusy(true);
    setClockError(null);
    try {
      if (clockedIn) {
        await api.clockOut({ employeeNumber: employee.employeeNumber });
      } else {
        await api.clockIn({ employeeNumber: employee.employeeNumber, source: "manual" });
      }
      onChanged();
    } catch (err) {
      setClockError(err instanceof ApiError ? err.message : "Could not record attendance.");
    } finally {
      setClockBusy(false);
    }
  }

  if (error) {
    return <div className="bg-card rounded-card p-5 shadow-sm text-sm text-label-secondary mb-6">{error}</div>;
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">My Leave</h2>
        <div className="flex gap-4 items-center">
          {canClock && employee && (
            <button
              onClick={handleClock}
              disabled={clockBusy}
              className={`text-sm font-semibold rounded-lg px-3 py-1.5 disabled:opacity-50 ${
                clockedIn ? "bg-danger/10 text-danger" : "bg-accent text-white"
              }`}
            >
              {clockBusy ? "…" : clockedIn ? "Clock out" : "Clock in"}
            </button>
          )}
          {canSubmit && !showForm && (
            <button onClick={() => setShowForm(true)} className="text-sm font-semibold text-accent hover:underline">
              Request Leave
            </button>
          )}
        </div>
      </div>

      {clockError && <p className="text-xs text-danger mb-3">{clockError}</p>}
      {clockedIn && attendance && (
        <p className="text-xs text-label-tertiary mb-3">
          Clocked in since {new Date(attendance[0].clockInAt).toLocaleString()}
        </p>
      )}

      {!balances ? (
        <div className="text-label-tertiary text-sm">Loading…</div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {balances.map((b) => (
            <div key={b.leaveType} className="bg-black/5 rounded-lg px-3 py-2">
              <div className="text-xs uppercase tracking-wide text-label-tertiary">{LEAVE_TYPE_LABELS[b.leaveType]}</div>
              <div className="font-mono font-semibold text-sm">
                {b.remainingDays}/{b.entitledDays} days left
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="mt-4">
          <LeaveRequestForm
            fixedEmployeeId={employeeId}
            onCancel={() => setShowForm(false)}
            onSubmitted={(result) => {
              setShowForm(false);
              setOverlapWarnings(result.overlapWarnings);
              onChanged();
            }}
          />
        </div>
      )}
      {overlapWarnings.length > 0 && (
        <div className="mt-3">
          <OverlapNotice warnings={overlapWarnings} />
        </div>
      )}
    </section>
  );
}

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

  const canActOnThis = request.status === "pending" && (canDecide || canCancel);

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium text-sm">
            {employee ? `${employee.firstName} ${employee.lastName}` : "Employee"}
            {request.isOnBehalf && <span className="text-xs text-label-tertiary ml-1.5">(on behalf)</span>}
          </div>
          <div className="text-sm text-label-secondary mt-0.5">
            {LEAVE_TYPE_LABELS[request.leaveType]} · {request.startDate} – {request.endDate} · {request.daysRequested}{" "}
            day{request.daysRequested === 1 ? "" : "s"}
          </div>
          {request.reason && <div className="text-xs text-label-tertiary mt-1">&ldquo;{request.reason}&rdquo;</div>}
        </div>
        <span
          className={`shrink-0 inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[request.status]}`}
        >
          {STATUS_LABELS[request.status]}
        </span>
      </div>

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

function RequestsSection({
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
  const [showOnBehalfForm, setShowOnBehalfForm] = useState(false);
  const [overlapWarnings, setOverlapWarnings] = useState<OverlapWarning[]>([]);

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
        {canSubmitOnBehalf && !showOnBehalfForm && (
          <button
            onClick={() => setShowOnBehalfForm(true)}
            className="text-sm font-semibold text-accent hover:underline"
          >
            Submit on behalf
          </button>
        )}
      </div>

      {showOnBehalfForm && (
        <div className="mb-4">
          <LeaveRequestForm
            onCancel={() => setShowOnBehalfForm(false)}
            onSubmitted={(result) => {
              setShowOnBehalfForm(false);
              setOverlapWarnings(result.overlapWarnings);
              onChanged();
            }}
          />
        </div>
      )}
      {overlapWarnings.length > 0 && (
        <div className="mb-4">
          <OverlapNotice warnings={overlapWarnings} />
        </div>
      )}

      {!requests ? (
        <div className="text-label-tertiary text-sm">Loading…</div>
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

/**
 * Task #50 — Leave & Attendance. Same "server already RBAC-scopes it, the
 * client just renders whatever comes back" design as Employee Core
 * (Decision #15) and Admin Center (Decision #17): `GET /leave-requests`
 * returns hr_admin's whole company, a line_manager's team, or an
 * employee_self_service holder's own requests, from the identical call.
 * The only role-aware branching here is which ACTIONS render — Request
 * Leave / clock in-out (employee_self_service only, since those are the
 * only two roles `0016_leave_attendance_seed.sql` grants
 * `leave_request.create.self`/`attendance.record.self` to), Submit on
 * behalf (hr_admin, via `leave_request.manage.all`), and Approve/Reject
 * (offered to hr_admin/line_manager cosmetically — who can ACTUALLY
 * decide a given request is entirely workflow-routing-determined
 * server-side, so a wrong guess here just means a real 403, not a
 * security gap).
 */
export function LeavePage() {
  const { identity } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const roleKeys = identity?.roleKeys ?? [];
  const canSubmitSelf = roleKeys.includes("employee_self_service");
  const canSubmitOnBehalf = roleKeys.includes("hr_admin");
  const canDecide = roleKeys.includes("hr_admin") || roleKeys.includes("line_manager");
  const canCancel = roleKeys.includes("hr_admin");
  // employee.view.self/.all are what actually let GET /employees/:id (and
  // the leave-balances endpoint keyed off the same id) resolve the
  // CALLER'S OWN record — 0011_employee_seed.sql grants those only to
  // hr_admin (.all) and employee_self_service (.self). line_manager gets
  // only employee.view.team (their reports, never themselves), so a
  // line_manager-only session has no employee record this page can fetch
  // for them — confirmed via a live 404 on both endpoints during Task #50
  // verification, not assumed. Gating "My Leave" on the same roles that
  // hold self-view avoids surfacing that as a broken card.
  const canViewOwnEmployeeRecord = roleKeys.includes("hr_admin") || roleKeys.includes("employee_self_service");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Leave & Attendance</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Request, approve, and track leave — plus clock in/out for your own attendance.
      </p>

      {identity?.employeeId && canViewOwnEmployeeRecord && (
        <MyLeaveCard
          employeeId={identity.employeeId}
          canSubmit={canSubmitSelf}
          canClock={canSubmitSelf}
          refreshKey={refreshKey}
          onChanged={bump}
        />
      )}

      <RequestsSection
        canSubmitOnBehalf={canSubmitOnBehalf}
        canDecide={canDecide}
        canCancel={canCancel}
        refreshKey={refreshKey}
        onChanged={bump}
      />
    </div>
  );
}
