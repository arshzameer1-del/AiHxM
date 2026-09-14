import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EmployeeView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

/**
 * One list, every role. `GET /employees` already returns exactly the
 * rows RbacService's view-scope grants the caller (`.all` for hr_admin,
 * `.team` — direct reports only — for line_manager) — this page renders
 * whatever comes back rather than branching on `identity.roleKeys`
 * itself, the same "server decides scope, client just renders it"
 * split every portal screen in this build follows.
 */
export function EmployeeListPage() {
  const { identity } = useAuth();
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listEmployees()
      .then(setEmployees)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load employees."));
  }, []);

  const canCreate = identity?.roleKeys.includes("hr_admin") ?? false;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Employees</h1>
          <p className="text-sm text-label-tertiary mt-1">
            {identity?.roleKeys.includes("hr_admin")
              ? "Everyone at " + (identity?.companyName ?? "your company")
              : "Your direct reports"}
          </p>
        </div>
        {canCreate && (
          <Link
            to="/app/employees/new"
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
          >
            New Employee
          </Link>
        )}
      </div>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {!error && !employees && <div className="text-label-tertiary text-sm">Loading…</div>}

      {employees && employees.length === 0 && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No employees to show yet.
        </div>
      )}

      {employees && employees.length > 0 && (
        <div className="bg-card rounded-card shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-label-tertiary border-b border-black/5">
                <th className="px-4 py-3">Employee #</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Department</th>
                <th className="px-4 py-3">Designation</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {employees.map((e) => (
                <tr key={e.id} className="hover:bg-black/[0.02]">
                  <td className="px-4 py-3">
                    <Link to={`/app/employees/${e.id}`} className="font-mono text-xs text-accent hover:underline">
                      {e.employeeNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/app/employees/${e.id}`} className="font-medium hover:underline">
                      {e.firstName} {e.lastName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-label-secondary">{e.department ?? "—"}</td>
                  <td className="px-4 py-3 text-label-secondary">{e.designation ?? "—"}</td>
                  <td className="px-4 py-3 capitalize text-label-secondary">
                    {e.employmentStatus.replace("_", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
