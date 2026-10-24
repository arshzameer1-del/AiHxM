import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { EmployeeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { useAuth } from "../../auth/AuthContext";
import { compareEmployeeNumbers } from "./employeeNumberOrder";
import { StatTile } from "../../components/StatTile";
import { Building2, CalendarPlus, LayoutGrid, List, UserCheck, Users } from "lucide-react";

/**
 * Employees = maintenance of the people already hired (directory, records, profiles, lifecycle). Hiring itself (guided
 * wizard, quick add, bulk) is its own section under /app/hire and is deliberately not offered from here.
 *
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

  // A company can have hundreds of people: find them by name, number, department or job title, and by status.
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [department, setDepartment] = useState("all");
  const [view, setView] = useState<"list" | "cards">("list");
  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of employees ?? []) if (e.department) counts.set(e.department, (counts.get(e.department) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [employees]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...(employees ?? [])].sort((a, b) => compareEmployeeNumbers(a.employeeNumber, b.employeeNumber)).filter((e) => {
      if (status !== "all" && e.employmentStatus !== status) return false;
      if (department !== "all" && e.department !== department) return false;
      if (!q) return true;
      return [e.employeeNumber, `${e.firstName} ${e.lastName}`, e.department, e.designation].some((v) => (v ?? "").toLowerCase().includes(q));
    });
  }, [employees, search, status, department]);

  const total = employees?.length ?? 0;
  const activeCount = (employees ?? []).filter((e) => e.employmentStatus === "active").length;
  const departmentCount = new Set((employees ?? []).map((e) => e.department).filter(Boolean)).size;
  const newlyHired = (employees ?? []).filter((e) => e.dateOfJoining && Date.now() - new Date(e.dateOfJoining).getTime() < 30 * 86400000).length;

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
      </div>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {employees && employees.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5" data-testid="emp-tiles">
          <StatTile icon={Users} value={total} label="All employees" active={status === "all"} onClick={() => setStatus("all")} />
          <StatTile icon={UserCheck} value={activeCount} label="Active" active={status === "active"} onClick={() => setStatus("active")} />
          <StatTile icon={CalendarPlus} value={newlyHired} label="Joined in 30 days" />
          <StatTile icon={Building2} value={departmentCount} label="Departments" />
        </div>
      )}

      {!error && !employees && <LoadingNote />}

      {employees && employees.length === 0 && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No employees to show yet.
          {canCreate && (
            <>
              {" "}
              <Link to="/app/hire" className="text-accent hover:underline font-medium">
                Hire the first employee
              </Link>
            </>
          )}
        </div>
      )}

      {employees && employees.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label className="sr-only" htmlFor="emp-search">
            Search employees
          </label>
          <input
            id="emp-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number, department, job title…"
            className="w-80 max-w-full rounded-lg border border-black/10 bg-card px-3 py-2 text-sm"
            data-testid="emp-search"
          />
          <label className="sr-only" htmlFor="emp-status">
            Status
          </label>
          <select id="emp-status" value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-black/10 bg-card px-3 py-2 text-sm" data-testid="emp-status">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="on_leave">On leave</option>
            <option value="terminated">Terminated</option>
          </select>
          <div className="view-switch ml-auto" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} title="List">
              <List size={16} aria-hidden /> <span>List</span>
            </button>
            <button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")} title="Cards">
              <LayoutGrid size={16} aria-hidden /> <span>Cards</span>
            </button>
          </div>
          <span className="text-xs text-label-tertiary" data-testid="emp-count" aria-live="polite">
            {shown.length === employees.length ? `${employees.length} employees` : `${shown.length} of ${employees.length} employees`}
          </span>
        </div>
      )}

      {employees && departments.length > 1 && (
        <div className="dept-pills mb-3" role="group" aria-label="Department">
          <button type="button" aria-pressed={department === "all"} onClick={() => setDepartment("all")}>
            All departments <span>{employees.length}</span>
          </button>
          {departments.map(([name, count]) => (
            <button key={name} type="button" aria-pressed={department === name} onClick={() => setDepartment(name)}>
              {name} <span>{count}</span>
            </button>
          ))}
        </div>
      )}

      {employees && employees.length > 0 && shown.length === 0 && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary" data-testid="emp-none">
          No one matches this search.{" "}
          <button
            type="button"
            className="text-accent hover:underline font-medium"
            onClick={() => {
              setSearch("");
              setStatus("all");
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      {employees && shown.length > 0 && view === "cards" && (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-testid="emp-cards">
          {shown.map((e) => (
            <Link key={e.id} to={`/app/employees/${e.id}`} className="emp-card ui-card">
              <div className="emp-card-banner">
                {e.department && <span className="emp-card-tag">{e.department}</span>}
              </div>
              <div className="emp-card-avatar" aria-hidden="true">
                <EmployeeAvatar employeeId={e.id} name={`${e.firstName} ${e.lastName}`} size="fill" className="!bg-transparent" />
              </div>
              <div className="emp-card-body">
                <div className="emp-card-name">
                  {e.firstName} {e.lastName}
                </div>
                <div className="emp-card-job">{e.designation ?? "—"}</div>
                <div className="emp-card-meta">
                  <span className="font-mono">{e.employeeNumber}</span>
                  <span className={`emp-card-status is-${e.employmentStatus}`}>{e.employmentStatus.replace("_", " ")}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {employees && shown.length > 0 && view === "list" && (
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
              {shown.map((e) => (
                <tr key={e.id} className="hover:bg-black/[0.02]">
                  <td className="px-4 py-3">
                    <Link to={`/app/employees/${e.id}`} className="font-mono text-xs text-accent hover:underline">
                      {e.employeeNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/app/employees/${e.id}`} className="flex items-center gap-2.5 font-medium hover:underline">
                      <EmployeeAvatar employeeId={e.id} name={`${e.firstName} ${e.lastName}`} size="sm" />
                      <span>{e.firstName} {e.lastName}</span>
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
