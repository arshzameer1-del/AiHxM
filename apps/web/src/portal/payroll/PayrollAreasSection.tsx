import { FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import type {
  CostCenterView,
  DataScopeType,
  EmployeeView,
  LocationView,
  OrgUnitView,
  PayrollAreaScopeLinkView,
  PayrollAreaView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-xs font-medium mb-1";

const SCOPE_TYPES: DataScopeType[] = ["org_unit", "location", "cost_center"];
const SCOPE_TYPE_LABELS: Record<DataScopeType, string> = {
  org_unit: "Org unit",
  location: "Location",
  cost_center: "Cost center",
};

/** Loading the list: a bare 404 is the module-entitlement check
 * (PayrollAreasService.requireModule), same mapping PayrollPage uses. */
function describeLoadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Payroll module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view payroll areas.";
    return err.message;
  }
  return "Something went wrong loading payroll areas.";
}

/** Acting on an area: the server's own message is the useful one here
 * ("A payroll area with code … already exists", "Cannot assign employees
 * to an inactive payroll area", …). */
function describeError(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

/** id -> display name for each Data Scope dimension, so a scope link
 * (a bare `scopeEntityId`, same generic shape as `data_scope_assignments`)
 * reads as "Location: Karachi Branch" rather than a UUID. */
type ScopeCatalog = Record<DataScopeType, { id: string; label: string }[]>;

function entityLabel(entity: { name: string; code: string | null }): string {
  return entity.code ? `${entity.name} (${entity.code})` : entity.name;
}

function buildCatalog(orgUnits: OrgUnitView[], locations: LocationView[], costCenters: CostCenterView[]): ScopeCatalog {
  return {
    org_unit: orgUnits.map((u) => ({ id: u.id, label: entityLabel(u) })),
    location: locations.map((l) => ({ id: l.id, label: entityLabel(l) })),
    cost_center: costCenters.map((c) => ({ id: c.id, label: entityLabel(c) })),
  };
}

function scopeLinkLabel(catalog: ScopeCatalog, link: PayrollAreaScopeLinkView): string {
  return catalog[link.scopeType].find((e) => e.id === link.scopeEntityId)?.label ?? "Unknown";
}

function statusBadgeClass(isActive: boolean): string {
  return isActive ? "bg-success/15 text-green-700" : "bg-black/10 text-label-tertiary";
}

// --- Create / edit ---------------------------------------------------------

function CreateAreaForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (area: PayrollAreaView) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createPayrollArea({
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || null,
      });
      onCreated(created);
    } catch (err) {
      setError(describeError(err, "Could not create this payroll area."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">
        A new area starts with no employees and no scope links — assign employees and link the org units, locations
        or cost centers it covers once it's created.
      </div>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className={labelClass}>Code</label>
          <input
            required
            maxLength={50}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="KHI-M"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div className="col-span-3">
          <label className={labelClass}>Name</label>
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Karachi Monthly"
            className={inputClass}
          />
        </div>
        <div className="col-span-4">
          <label className={labelClass}>Description (optional)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !code.trim() || !name.trim()}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create area"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** `code` is the area's stable key (UpdatePayrollAreaDto has no `code`),
 * so it's shown read-only here; name, description and active are the
 * only editable fields. */
function EditAreaForm({
  area,
  onCancel,
  onSaved,
}: {
  area: PayrollAreaView;
  onCancel: () => void;
  onSaved: (area: PayrollAreaView) => void;
}) {
  const [name, setName] = useState(area.name);
  const [description, setDescription] = useState(area.description ?? "");
  const [isActive, setIsActive] = useState(area.isActive);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (area.isActive && !isActive && area.employeeCount > 0) {
      const ok = window.confirm(
        `Deactivate ${area.name}? Its ${area.employeeCount} employee(s) keep this area until reassigned, but no new runs or employees can be added to it.`
      );
      if (!ok) return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const updated = await api.updatePayrollArea(area.id, {
        name: name.trim(),
        description: description.trim() || null,
        isActive,
      });
      onSaved(updated);
    } catch (err) {
      setError(describeError(err, "Could not save this payroll area."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className={labelClass}>Code</label>
          <input value={area.code} disabled className={`${inputClass} font-mono bg-black/5 text-label-tertiary`} />
        </div>
        <div className="col-span-3">
          <label className={labelClass}>Name</label>
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </div>
        <div className="col-span-4">
          <label className={labelClass}>Description (optional)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="rounded border-black/20"
        />
        Active
        <span className="text-xs text-label-tertiary">
          — an inactive area can't receive new payroll runs or new employees
        </span>
      </label>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Scope links -------------------------------------------------------------

/**
 * An area's scope links are what decide which regional (`.scoped`)
 * payroll users can see and run it — so, exactly like the server
 * (`PayrollAreasService.addScopeLink/removeScopeLink` require `.all`),
 * only a `payroll_area.manage.all` holder gets the add/remove controls;
 * everyone else sees the list read-only.
 */
function ScopeLinksEditor({
  area,
  catalog,
  canManage,
  onChanged,
}: {
  area: PayrollAreaView;
  catalog: ScopeCatalog;
  canManage: boolean;
  onChanged: (area: PayrollAreaView) => void;
}) {
  const [scopeType, setScopeType] = useState<DataScopeType>("org_unit");
  const [scopeEntityId, setScopeEntityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkedIds = useMemo(
    () => new Set(area.scopeLinks.filter((l) => l.scopeType === scopeType).map((l) => l.scopeEntityId)),
    [area.scopeLinks, scopeType]
  );
  const options = catalog[scopeType].filter((e) => !linkedIds.has(e.id));

  useEffect(() => {
    setScopeEntityId("");
  }, [scopeType]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!scopeEntityId) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.addPayrollAreaScopeLink(area.id, { scopeType, scopeEntityId }));
      setScopeEntityId("");
    } catch (err) {
      setError(describeError(err, "Could not add this scope link."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(link: PayrollAreaScopeLinkView) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.removePayrollAreaScopeLink(area.id, link.id));
    } catch (err) {
      setError(describeError(err, "Could not remove this scope link."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">
        Regional payroll users whose data scope covers any of these org units, locations or cost centers (org units
        and locations include everything beneath them) can see and run this area. With no links, only company-wide
        payroll staff can.
      </div>

      {area.scopeLinks.length === 0 ? (
        <div className="text-sm text-label-tertiary">No scope links yet.</div>
      ) : (
        <div className="bg-card rounded-lg px-3">
          {area.scopeLinks.map((link) => (
            <div key={link.id} className="flex items-center gap-2 py-2 border-b border-black/5 last:border-b-0 text-sm">
              <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">
                {SCOPE_TYPE_LABELS[link.scopeType]}
              </span>
              <span className="font-medium">{scopeLinkLabel(catalog, link)}</span>
              {canManage && (
                <button
                  onClick={() => handleRemove(link)}
                  disabled={busy}
                  className="ml-auto text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <form onSubmit={handleAdd} className="grid grid-cols-[10rem_1fr_auto] gap-2 items-end">
          <div>
            <label className={labelClass}>Scope type</label>
            <select
              value={scopeType}
              onChange={(e) => setScopeType(e.target.value as DataScopeType)}
              className={inputClass}
            >
              {SCOPE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SCOPE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>{SCOPE_TYPE_LABELS[scopeType]}</label>
            <select value={scopeEntityId} onChange={(e) => setScopeEntityId(e.target.value)} className={inputClass}>
              <option value="">
                {options.length === 0 ? `No more ${SCOPE_TYPE_LABELS[scopeType].toLowerCase()}s to link` : "Select…"}
              </option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy || !scopeEntityId}
            className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            Add link
          </button>
        </form>
      )}

      {error && <div className="text-danger text-xs">{error}</div>}
    </div>
  );
}

function ScopeSummary({ area, catalog }: { area: PayrollAreaView; catalog: ScopeCatalog }) {
  if (area.scopeLinks.length === 0) {
    return <span className="text-xs text-label-tertiary">Company-wide staff only</span>;
  }
  const shown = area.scopeLinks.slice(0, 2);
  const rest = area.scopeLinks.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((link) => (
        <span key={link.id} className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary whitespace-nowrap">
          {SCOPE_TYPE_LABELS[link.scopeType]}: {scopeLinkLabel(catalog, link)}
        </span>
      ))}
      {rest > 0 && <span className="text-xs text-label-tertiary px-1 py-0.5">+{rest} more</span>}
    </div>
  );
}

// --- Employee assignment -----------------------------------------------------

/**
 * Sets `employees.payroll_area_id` via POST /payroll/areas/employee-
 * assignments — the only writer of that column (PayrollAreasService's own
 * doc comment). Lives here rather than on EmployeeDetailPage because
 * `EmployeeView` doesn't carry `payrollAreaId`, so the employee page
 * couldn't show the current value next to the control; this panel is
 * framed as "place/move an employee", the same pick-employee-then-act
 * shape as the Assignment Workbench.
 */
function AssignEmployeeForm({
  areas,
  initialAreaId,
  onCancel,
  onAssigned,
}: {
  areas: PayrollAreaView[];
  initialAreaId?: string;
  onCancel: () => void;
  onAssigned: (message: string) => void;
}) {
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [search, setSearch] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  // Opened from the section header (no area chosen yet), default to the
  // first active area rather than "no area" — removal is the rarer,
  // explicit choice, never the accidental default.
  const [payrollAreaId, setPayrollAreaId] = useState(initialAreaId ?? areas.find((a) => a.isActive)?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listEmployees()
      .then((list) => setEmployees(list.filter((e) => e.employmentStatus !== "terminated")))
      .catch((err) => setError(describeError(err, "Could not load employees.")));
  }, []);

  const activeAreas = areas.filter((a) => a.isActive);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!employees) return [];
    if (!q) return employees;
    return employees.filter((e) =>
      `${e.firstName} ${e.lastName} ${e.employeeNumber}`.toLowerCase().includes(q)
    );
  }, [employees, search]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!employeeId) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.assignEmployeePayrollArea({ employeeId, payrollAreaId: payrollAreaId || null });
      const employee = employees?.find((x) => x.id === employeeId);
      const who = employee ? `${employee.firstName} ${employee.lastName}` : "Employee";
      const area = areas.find((a) => a.id === payrollAreaId);
      onAssigned(area ? `${who} assigned to ${area.name}.` : `${who} removed from their payroll area.`);
    } catch (err) {
      setError(describeError(err, "Could not assign this employee."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">
        Assigning replaces whatever payroll area the employee is currently in. An employee with no area is only
        included in company-wide runs.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Employee</label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name or employee #"
            className={`${inputClass} mb-2`}
          />
          <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputClass}>
            <option value="">
              {!employees ? "Loading employees…" : filtered.length === 0 ? "No matching employees" : "Select an employee…"}
            </option>
            {filtered.map((e) => (
              <option key={e.id} value={e.id}>
                {e.firstName} {e.lastName} ({e.employeeNumber})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Payroll area</label>
          <select value={payrollAreaId} onChange={(e) => setPayrollAreaId(e.target.value)} className={inputClass}>
            <option value="">— No payroll area (company-wide only) —</option>
            {activeAreas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !employeeId}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : payrollAreaId ? "Assign" : "Remove from area"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Section -----------------------------------------------------------------

type RowMode = "none" | "edit" | "scope";

function AreaRow({
  area,
  catalog,
  canManage,
  onUpdated,
  onAssign,
}: {
  area: PayrollAreaView;
  catalog: ScopeCatalog;
  canManage: boolean;
  onUpdated: (area: PayrollAreaView) => void;
  onAssign: (areaId: string) => void;
}) {
  const [mode, setMode] = useState<RowMode>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggleActive() {
    if (area.isActive) {
      const detail =
        area.employeeCount > 0
          ? ` Its ${area.employeeCount} employee(s) keep this area until reassigned, but no new runs or employees can be added to it.`
          : "";
      if (!window.confirm(`Deactivate ${area.name}?${detail}`)) return;
    }
    setBusy(true);
    setError(null);
    try {
      onUpdated(
        area.isActive ? await api.deactivatePayrollArea(area.id) : await api.updatePayrollArea(area.id, { isActive: true })
      );
    } catch (err) {
      setError(describeError(err, "Could not change this area's status."));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (next: RowMode) => setMode((m) => (m === next ? "none" : next));

  return (
    <Fragment>
      <tr className="hover:bg-black/[0.02] align-top">
        <td className="px-4 py-3 font-mono text-xs">{area.code}</td>
        <td className="px-4 py-3 min-w-[10rem]">
          <div className="font-medium">{area.name}</div>
          {area.description && <div className="text-xs text-label-tertiary mt-0.5">{area.description}</div>}
        </td>
        <td className="px-4 py-3 font-mono text-label-secondary">{area.employeeCount}</td>
        <td className="px-4 py-3">
          <ScopeSummary area={area} catalog={catalog} />
        </td>
        <td className="px-4 py-3">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(area.isActive)}`}>
            {area.isActive ? "Active" : "Inactive"}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex gap-3 justify-end text-xs whitespace-nowrap">
            <button onClick={() => toggle("scope")} className="font-semibold text-accent hover:underline">
              {mode === "scope" ? "Hide scope" : "Scope"}
            </button>
            {canManage && (
              <>
                {area.isActive && (
                  <button onClick={() => onAssign(area.id)} className="font-semibold text-accent hover:underline">
                    Assign
                  </button>
                )}
                <button onClick={() => toggle("edit")} className="font-semibold text-accent hover:underline">
                  Edit
                </button>
                <button
                  onClick={handleToggleActive}
                  disabled={busy}
                  className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
                >
                  {area.isActive ? "Deactivate" : "Activate"}
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {(mode !== "none" || error) && (
        <tr>
          <td colSpan={6} className="px-4 pb-3">
            {error && <div className="text-xs text-danger pb-2">{error}</div>}
            {mode === "edit" && (
              <EditAreaForm
                area={area}
                onCancel={() => setMode("none")}
                onSaved={(updated) => {
                  setMode("none");
                  onUpdated(updated);
                }}
              />
            )}
            {mode === "scope" && (
              <ScopeLinksEditor area={area} catalog={catalog} canManage={canManage} onChanged={onUpdated} />
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * Payroll Areas (0101_payroll_areas.sql) — the SAP HCM "Payroll Area"
 * equivalent: named groupings of employees ("Karachi Monthly", "Lahore
 * Weekly") that a payroll run can target instead of the whole company,
 * each optionally scope-linked to org units/locations/cost centers so a
 * regional payroll user's own Data Scope resolves to "which areas can I
 * run".
 *
 * `canManage` is the cosmetic `payroll_area.manage.all` gate — hr_admin
 * is the only role seeded with it (0102_payroll_area_permissions_seed.sql),
 * the same role-key-as-proxy convention every other portal screen uses
 * since `MeResponse` carries role keys, not permission keys. Without it
 * the list (and each area's scope links) is read-only — a Payroll
 * Approver can still see which areas exist and what they cover, since
 * `GET /payroll/areas` is readable by any payroll-staff permission.
 * PayrollAreasService enforces the real boundary server-side regardless.
 */
export function PayrollAreasSection({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const [areas, setAreas] = useState<PayrollAreaView[] | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [catalog, setCatalog] = useState<ScopeCatalog>({ org_unit: [], location: [], cost_center: [] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<{ areaId?: string } | null>(null);

  function load() {
    api
      .listPayrollAreas(includeInactive)
      .then(setAreas)
      .catch((err) => setError(describeLoadError(err)));
  }

  useEffect(load, [includeInactive]);

  useEffect(() => {
    // Name lookups for scope links only — an Organization-module 403/404
    // just leaves links showing "Unknown" rather than failing the section.
    Promise.all([
      api.listOrgUnits().catch(() => [] as OrgUnitView[]),
      api.listLocations().catch(() => [] as LocationView[]),
      api.listCostCenters().catch(() => [] as CostCenterView[]),
    ]).then(([units, locations, costCenters]) => setCatalog(buildCatalog(units, locations, costCenters)));
  }, []);

  function handleUpdated(updated: PayrollAreaView) {
    setAreas((prev) => {
      if (!prev) return prev;
      if (!includeInactive && !updated.isActive) return prev.filter((a) => a.id !== updated.id);
      return prev.map((a) => (a.id === updated.id ? updated : a));
    });
    onChanged();
  }

  if (error) return <div className="text-sm text-label-secondary">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-xs text-label-tertiary max-w-xl">
          Group employees who are paid together — e.g. "Karachi Monthly" or "Lahore Weekly". A payroll run can target
          one area instead of the whole company, and regional payroll staff only see the areas inside their data
          scope.
        </p>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-label-secondary">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="rounded border-black/20"
            />
            Show inactive
          </label>
          {canManage && !assigning && (
            <button onClick={() => setAssigning({})} className="text-sm font-semibold text-accent hover:underline">
              Assign employee
            </button>
          )}
          {canManage && !creating && (
            <button
              onClick={() => setCreating(true)}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
            >
              New area
            </button>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-success">{notice}</p>}

      {creating && (
        <CreateAreaForm
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setAreas((prev) => [...(prev ?? []), created].sort((a, b) => a.code.localeCompare(b.code)));
            setNotice(`Created ${created.name}. Link the org units, locations or cost centers it covers under "Scope".`);
            onChanged();
          }}
        />
      )}

      {assigning && areas && (
        <AssignEmployeeForm
          key={assigning.areaId ?? "any"}
          areas={areas}
          initialAreaId={assigning.areaId}
          onCancel={() => setAssigning(null)}
          onAssigned={(message) => {
            setAssigning(null);
            setNotice(message);
            load();
          }}
        />
      )}

      {!areas ? (
        <div className="text-sm text-label-tertiary">Loading…</div>
      ) : areas.length === 0 ? (
        <div className="bg-black/5 rounded-lg p-4 text-sm text-label-tertiary">
          {includeInactive ? "No payroll areas yet." : "No active payroll areas."} Every run is company-wide until one is
          created.
        </div>
      ) : (
        <div className="rounded-lg border border-black/5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-label-tertiary border-b border-black/5">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Employees</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {areas.map((area) => (
                <AreaRow
                  key={area.id}
                  area={area}
                  catalog={catalog}
                  canManage={canManage}
                  onUpdated={handleUpdated}
                  onAssign={(areaId) => setAssigning({ areaId })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
