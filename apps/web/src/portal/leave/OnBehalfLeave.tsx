import { useEffect, useState } from "react";
import { UserRoundX, Users } from "lucide-react";
import type { EmployeeView, OverlapWarning } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LeaveRequestForm, OverlapNotice } from "./LeaveRequestForm";
import { MyLeaveOverview } from "./LeaveOverview";

/**
 * HR submitting leave for someone else, laid out like the SAP "acting on behalf" flow: pick the employee
 * in a Select Employee box, a banner states whose leave this is (with a stop icon that returns to your
 * own view), and the same Entitlement / Request Overview / Create Request screen is then shown for that
 * employee. The server still decides whether the caller may do this (`leave_request.manage.all`).
 */
export function OnBehalfLeave({ onChanged, onClose }: { onChanged: () => void; onClose: () => void }) {
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<EmployeeView | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [overlapWarnings, setOverlapWarnings] = useState<OverlapWarning[]>([]);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  if (!target) {
    const needle = filter.trim().toLowerCase();
    const matches = (employees ?? []).filter((e) =>
      needle === "" ? true : `${e.firstName} ${e.lastName} ${e.employeeNumber} ${e.department ?? ""}`.toLowerCase().includes(needle),
    );
    return (
      <div className="bg-black/5 rounded-lg p-4 mb-4" role="dialog" aria-label="Select Employee">
        <div className="flex items-center gap-2 mb-3">
          <Users size={16} className="text-accent" aria-hidden />
          <h3 className="text-sm font-semibold">Select Employee</h3>
        </div>
        <label htmlFor="on-behalf-search" className="sr-only">
          Search employees
        </label>
        <input
          id="on-behalf-search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by name, number or department"
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <ul className="max-h-56 overflow-y-auto divide-y divide-black/5 bg-surface rounded-lg border border-black/5">
          {employees === null && <li className="px-3 py-2 text-sm text-label-tertiary">Loading…</li>}
          {employees !== null && matches.length === 0 && <li className="px-3 py-2 text-sm text-label-tertiary">No employee matches.</li>}
          {matches.map((emp) => (
            <li key={emp.id}>
              <button type="button" onClick={() => setTarget(emp)} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10">
                <span className="font-medium">
                  {emp.firstName} {emp.lastName}
                </span>{" "}
                <span className="text-label-tertiary">
                  ({emp.employeeNumber}){emp.department ? ` · ${emp.department}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <button type="button" onClick={onClose} className="text-sm font-medium text-label-secondary">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4" data-testid="on-behalf-leave">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-3 text-sm text-amber-900">
        <span>
          You are acting on behalf of employee “{target.firstName} {target.lastName} ({target.employeeNumber})”
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Stop acting on behalf"
          title="Stop acting on behalf"
          className="inline-flex p-1 text-amber-900 hover:text-danger"
        >
          <UserRoundX size={18} strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex justify-end mb-2">
        {!showForm && (
          <button type="button" onClick={() => setShowForm(true)} className="text-sm font-semibold text-accent hover:underline">
            Create Request
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-4">
          <LeaveRequestForm
            fixedEmployeeId={target.id}
            initialStart={range?.start}
            initialEnd={range?.end}
            onCancel={() => setShowForm(false)}
            onSubmitted={(result) => {
              setShowForm(false);
              setRange(null);
              setOverlapWarnings(result.overlapWarnings);
              setRefreshKey((k) => k + 1);
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

      <MyLeaveOverview
        employeeId={target.id}
        refreshKey={refreshKey}
        canSubmit
        onChanged={() => {
          setRefreshKey((k) => k + 1);
          onChanged();
        }}
        onCreateRange={(start, end) => {
          setRange({ start, end });
          setShowForm(true);
        }}
      />
    </div>
  );
}
