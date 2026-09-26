import { useEffect, useState } from "react";
import type { LegacyReconciliationEmployeeView, LegacyReconciliationGap } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to do that.";
    return err.message;
  }
  return "Something went wrong.";
}

const GAP_LABELS: Record<LegacyReconciliationGap["gapType"], string> = {
  department: "Department",
  location: "Location",
  manager: "Manager",
};

/** One gap's own fix control — a row of suggestion buttons for
 * `department`/`location` (each links straight to that candidate; there is
 * deliberately no free-text/search box here, since `getReport()` already
 * did the matching, and a wrong org unit is a one-way write an admin
 * should pick deliberately), or a single "Create reporting line" button
 * for `manager` (nothing to choose — see `LegacyReconciliationGap`'s own
 * doc comment in shared-types). */
function GapRow({
  employeeId,
  gap,
  canManage,
  onResolved,
}: {
  employeeId: string;
  gap: LegacyReconciliationGap;
  canManage: boolean;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onResolved();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-black/5 pt-2 mt-2 first:border-t-0 first:pt-0 first:mt-0">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-label-secondary">{GAP_LABELS[gap.gapType]}:</span>
        <span className="text-label-tertiary">"{gap.legacyValue}"</span>
      </div>

      {gap.gapType !== "manager" ? (
        gap.suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-1.5">
            {gap.suggestions.map((s) => (
              <button
                key={s.id}
                disabled={busy || !canManage}
                onClick={() =>
                  run(() =>
                    gap.gapType === "department" ? api.linkLegacyOrgUnit(employeeId, s.id) : api.linkLegacyLocation(employeeId, s.id)
                  )
                }
                title={canManage ? undefined : "Requires HR Admin"}
                className="bg-accent/10 text-accent rounded-full px-2.5 py-1 text-xs font-semibold hover:bg-accent/20 disabled:opacity-50"
              >
                Link to "{s.name}"{s.matchType === "fuzzy" ? " (close match)" : ""}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-label-tertiary mt-1">
            No matching {gap.gapType === "department" ? "org unit" : "location"} found — create one first.
          </div>
        )
      ) : (
        <button
          disabled={busy || !canManage}
          onClick={() => run(() => api.linkLegacyManagerRelationship(employeeId))}
          title={canManage ? undefined : "Requires HR Admin"}
          className="bg-accent/10 text-accent rounded-full px-2.5 py-1 text-xs font-semibold hover:bg-accent/20 disabled:opacity-50 mt-1.5"
        >
          Create reporting line
        </button>
      )}

      {error && <div className="text-xs text-danger mt-1">{error}</div>}
    </div>
  );
}

function EmployeeCard({
  employee,
  canManage,
  onResolved,
}: {
  employee: LegacyReconciliationEmployeeView;
  canManage: boolean;
  onResolved: () => void;
}) {
  return (
    <div className="bg-card rounded-card shadow-sm p-4">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-sm">{employee.fullName}</span>
        <span className="text-xs font-mono text-label-tertiary">{employee.employeeNumber}</span>
      </div>
      <div className="mt-2">
        {employee.gaps.map((gap, i) => (
          <GapRow key={`${gap.gapType}-${i}`} employeeId={employee.employeeId} gap={gap} canManage={canManage} onResolved={onResolved} />
        ))}
      </div>
    </div>
  );
}

/**
 * Organization Management Phase 12 (Unified Integration & Synchronization
 * Requirements, Section 24 — Legacy Data Migration). The backfill half of
 * Phase 8's `legacy_records_not_mapped` warning (see
 * `LegacyReconciliationService`'s own header comment on the API side): a
 * plain list of the affected employees, each gap shown with the
 * already-computed candidate matches — a link, not a free-text edit,
 * closes each one. `employee.manage.all` (hr_admin) gates every action
 * server-side; `canManage` here is the same courtesy client-side mirror
 * every other Organization Management screen already uses.
 */
export function LegacyReconciliationPage() {
  const { identity } = useAuth();
  const [employees, setEmployees] = useState<LegacyReconciliationEmployeeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    api
      .getLegacyReconciliationReport()
      .then((report) => setEmployees(report.employees))
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!employees) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Legacy Data Reconciliation</h1>
        <p className="text-sm text-label-tertiary mt-1">
          Employees still carrying free-text department, location, or manager values with no canonical record linked behind
          them. Pick a match to link it — the legacy text stays in sync automatically once linked.
        </p>
      </div>

      {employees.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          Nothing to reconcile — every active employee's department, location, and manager are already linked to a
          canonical record.
        </div>
      ) : (
        <div className="space-y-3">
          {employees.map((employee) => (
            <EmployeeCard key={employee.employeeId} employee={employee} canManage={canManage} onResolved={load} />
          ))}
        </div>
      )}
    </div>
  );
}
