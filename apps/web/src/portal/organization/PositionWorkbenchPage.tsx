import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { EmployeeView, JobView, OrgUnitView, PositionStatus, PositionView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const STATUS_LABELS: Record<PositionStatus, string> = {
  vacant: "Vacant",
  filled: "Filled",
  frozen: "Frozen",
  abolished: "Abolished",
};
const ALL_STATUSES = Object.keys(STATUS_LABELS) as PositionStatus[];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    if (err.status === 409) return err.message || "That position isn't in a state that allows this action.";
    return err.message;
  }
  return "Something went wrong.";
}

function statusBadgeClass(status: PositionStatus): string {
  switch (status) {
    case "filled":
      return "bg-success/15 text-green-700";
    case "vacant":
      return "bg-accent/15 text-accent";
    case "frozen":
      return "bg-yellow-500/15 text-yellow-700";
    case "abolished":
      return "bg-black/10 text-label-tertiary";
  }
}

type CreateFormValue = {
  orgUnitId: string;
  jobId: string;
  positionTitle: string;
  positionCode: string;
  headcountFte: string;
};

/** A tiny, self-contained create form — org unit is required (a position
 * is always a seat IN some unit); job is optional (a position can exist
 * before a job is assigned to it), in which case positionTitle becomes
 * required (server-enforced too — this is a courtesy, not the real
 * guard). */
function CreatePositionForm({
  orgUnits,
  jobs,
  initialOrgUnitId,
  onCancel,
  onSaved,
}: {
  orgUnits: OrgUnitView[];
  jobs: JobView[];
  /** Set when this form was opened via the "+ Position" shortcut on an org
   * unit's own row in the Hierarchy tree (`?orgUnitId=` on this page's own
   * URL) — defaults the org unit picker to that unit instead of the first
   * one alphabetically, so the shortcut actually saves the click it's
   * supposed to. Plain top-level "New Position" (no query param) keeps the
   * old default. */
  initialOrgUnitId?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<CreateFormValue>({
    orgUnitId: initialOrgUnitId || orgUnits[0]?.id || "",
    jobId: "",
    positionTitle: "",
    positionCode: "",
    headcountFte: "1",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!value.jobId && !value.positionTitle.trim()) {
      setError("Enter a position title, or pick a job to default the title from.");
      return;
    }
    setSubmitting(true);
    try {
      await api.createPosition({
        orgUnitId: value.orgUnitId,
        jobId: value.jobId || undefined,
        positionTitle: value.positionTitle || undefined,
        positionCode: value.positionCode || undefined,
        headcountFte: value.headcountFte ? Number(value.headcountFte) : undefined,
      });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">New position — created vacant, ready to assign once saved.</div>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Org Unit</label>
          <select
            required
            value={value.orgUnitId}
            onChange={(e) => setValue((v) => ({ ...v, orgUnitId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {orgUnits.length === 0 && <option value="">No org units yet</option>}
            {orgUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Job (optional)</label>
          <select
            value={value.jobId}
            onChange={(e) => setValue((v) => ({ ...v, jobId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">— No job yet —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Title {value.jobId ? "(optional — defaults from job)" : ""}</label>
          <input
            value={value.positionTitle}
            onChange={(e) => setValue((v) => ({ ...v, positionTitle: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Headcount FTE</label>
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={value.headcountFte}
            onChange={(e) => setValue((v) => ({ ...v, headcountFte: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">Code (optional)</label>
        <input
          value={value.positionCode}
          onChange={(e) => setValue((v) => ({ ...v, positionCode: e.target.value }))}
          placeholder="e.g. ENG-001"
          className="w-48 rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !value.orgUnitId}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create Position"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AssignControl({
  position,
  employees,
  onCancel,
  onSaved,
}: {
  position: PositionView;
  employees: EmployeeView[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  // Only offer employees not already occupying a DIFFERENT position —
  // assigning them here would silently vacate that one as a side effect
  // (PositionsService.assignEmployee()'s own documented behavior); this
  // is a courtesy so the picker doesn't invite a surprising side effect,
  // not the real guard.
  const available = employees.filter((e) => !e.positionId || e.positionId === position.id);
  const [employeeId, setEmployeeId] = useState(available[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAssign() {
    if (!employeeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.assignPosition(position.id, { employeeId });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap bg-black/5 rounded-lg p-3">
      <select
        value={employeeId}
        onChange={(e) => setEmployeeId(e.target.value)}
        className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
      >
        {available.length === 0 && <option value="">No available employees</option>}
        {available.map((e) => (
          <option key={e.id} value={e.id}>
            {e.firstName} {e.lastName} ({e.employeeNumber})
          </option>
        ))}
      </select>
      <button onClick={handleAssign} disabled={busy || !employeeId} className="text-xs font-semibold text-accent disabled:opacity-50">
        Assign
      </button>
      <button onClick={onCancel} className="text-xs text-label-tertiary">
        Cancel
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

function PositionRow({
  position,
  orgUnitName,
  jobTitle,
  employees,
  canManage,
  onChanged,
}: {
  position: PositionView;
  orgUnitName: string;
  jobTitle: string | null;
  employees: EmployeeView[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"none" | "assign">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const occupant = employees.find((e) => e.positionId === position.id);

  async function runAction(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 py-2.5 border-b border-black/5 hover:bg-black/[0.02] flex-wrap">
        <span className="font-medium text-sm">{position.positionTitle}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{orgUnitName}</span>
        {jobTitle && <span className="text-xs text-label-tertiary">{jobTitle}</span>}
        {position.positionCode && <span className="text-xs font-mono text-label-tertiary">{position.positionCode}</span>}
        <span className="text-xs text-label-tertiary">{position.headcountFte} FTE</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(position.status)}`}>
          {STATUS_LABELS[position.status]}
        </span>
        {occupant && (
          <span className="text-xs text-label-secondary">
            — {occupant.firstName} {occupant.lastName}
          </span>
        )}

        <div className="ml-auto flex gap-3 shrink-0 text-xs">
          {/* Organization Management Phase 9 — the "View" link into
            PositionDetailPage, ungated by `canManage` for the same reason
            OrgHierarchyPage's own "View" link is (see that file's comment). */}
          <Link to={`/app/organization/positions/${position.id}`} className="font-medium text-label-secondary hover:underline">
            View
          </Link>
          {canManage && (
            <>
              {position.status === "vacant" && (
                <button onClick={() => setMode(mode === "assign" ? "none" : "assign")} className="font-semibold text-accent hover:underline">
                  Assign
                </button>
              )}
              {position.status === "filled" && (
                <button onClick={() => runAction(() => api.unassignPosition(position.id))} disabled={busy} className="font-semibold text-accent hover:underline disabled:opacity-50">
                  Unassign
                </button>
              )}
              {position.status === "vacant" && (
                <button onClick={() => runAction(() => api.freezePosition(position.id))} disabled={busy} className="font-medium text-label-secondary hover:underline disabled:opacity-50">
                  Freeze
                </button>
              )}
              {position.status === "frozen" && (
                <button onClick={() => runAction(() => api.unfreezePosition(position.id))} disabled={busy} className="font-medium text-label-secondary hover:underline disabled:opacity-50">
                  Unfreeze
                </button>
              )}
              {(position.status === "vacant" || position.status === "frozen") && (
                <button onClick={() => runAction(() => api.abolishPosition(position.id))} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
                  Abolish
                </button>
              )}
              {position.status === "abolished" && (
                <button onClick={() => runAction(() => api.reactivatePosition(position.id))} disabled={busy} className="font-medium text-label-tertiary hover:text-accent disabled:opacity-50">
                  Reactivate
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-danger py-1">{error}</div>}

      {mode === "assign" && (
        <div className="py-2">
          <AssignControl
            position={position}
            employees={employees}
            onCancel={() => setMode("none")}
            onSaved={() => {
              setMode("none");
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Organization Management, Phase 2 — the Position Workbench: list/filter
 * every seat in the company, create one against an org unit (+ optional
 * job), and drive its lifecycle (assign/unassign, freeze/unfreeze,
 * abolish/reactivate) — every action here is a thin wrapper over
 * PositionsService's own state-transition methods, which are the real
 * gate (this page's `canManage` is a courtesy, same as every other portal
 * screen). Deliberately NOT registered in Configuration Center — Position
 * is operational/transactional data, not setup data (see
 * 0070_configuration_center_job.sql's own header comment); this
 * standalone page is its only home.
 */
export function PositionWorkbenchPage() {
  const { identity } = useAuth();
  // Organization Management Phase 9 addendum — the Hierarchy tree's own
  // "+ Position" shortcut on each org unit row lands here with
  // `?orgUnitId=<id>`: pre-filters the list to that unit AND auto-opens
  // the create form defaulted to it, so the shortcut is a real one-click
  // path from "I'm looking at this department" to "creating a position in
  // it," not just a bookmark to this same generic screen. Arriving here
  // directly from the nav (no query param) behaves exactly as before.
  const [searchParams] = useSearchParams();
  const initialOrgUnitId = searchParams.get("orgUnitId") ?? "";
  const [positions, setPositions] = useState<PositionView[] | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(Boolean(initialOrgUnitId));
  const [statusFilter, setStatusFilter] = useState<PositionStatus | "">("");
  const [orgUnitFilter, setOrgUnitFilter] = useState<string>(initialOrgUnitId);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    api
      .listPositions({ status: statusFilter || undefined, orgUnitId: orgUnitFilter || undefined })
      .then(setPositions)
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, [statusFilter, orgUnitFilter]);

  useEffect(() => {
    api.listOrgUnits().then(setOrgUnits).catch(() => undefined);
    api.listJobs().then(setJobs).catch(() => undefined);
    // Employees may be forbidden for a caller who can manage positions but
    // not employee records directly — the occupant name/assign picker is
    // then simply omitted rather than failing the whole page.
    api.listEmployees().then(setEmployees).catch(() => undefined);
  }, []);

  const orgUnitById = useMemo(() => new Map(orgUnits.map((u) => [u.id, u.name])), [orgUnits]);
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j.title])), [jobs]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Position Workbench</h1>
          <p className="text-sm text-label-tertiary mt-1">
            Every seat in the company — a vacant position is a normal, valid state, not a gap to fill immediately.
          </p>
        </div>
        {canManage && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Position
          </button>
        )}
      </div>

      {creating && (
        <div className="mb-4">
          <CreatePositionForm
            orgUnits={orgUnits}
            jobs={jobs}
            initialOrgUnitId={initialOrgUnitId || undefined}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      <div className="flex gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PositionStatus | "")}
          className="rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={orgUnitFilter}
          onChange={(e) => setOrgUnitFilter(e.target.value)}
          className="rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All org units</option>
          {orgUnits.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>

      {!positions && <div className="text-label-tertiary text-sm">Loading…</div>}

      {positions && positions.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No positions match these filters.{" "}
          {canManage && !statusFilter && !orgUnitFilter ? "Create the first one above." : ""}
        </div>
      )}

      {positions && positions.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {positions.map((p) => (
            <PositionRow
              key={p.id}
              position={p}
              orgUnitName={orgUnitById.get(p.orgUnitId) ?? "Unknown unit"}
              jobTitle={p.jobId ? jobById.get(p.jobId) ?? null : null}
              employees={employees}
              canManage={canManage}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
