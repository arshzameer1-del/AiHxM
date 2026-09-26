import { FormEvent, useEffect, useState } from "react";
import type { CostCenterView, OrgUnitView, ProfitCenterView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong.";
}

function statusBadgeClass(status: CostCenterView["status"] | ProfitCenterView["status"]): string {
  return status === "archived" ? "bg-black/10 text-label-tertiary" : "bg-success/15 text-green-700";
}

type CenterFormValue = {
  name: string;
  code: string;
  orgUnitId: string;
};

const EMPTY_FORM: CenterFormValue = { name: "", code: "", orgUnitId: "" };

/**
 * Shared by both the Cost Center and Profit Center sections below — the
 * two catalogs are structurally identical (name, code, an optional org
 * unit link, status), so one form component parameterized by which
 * create/update call to make avoids hand-duplicating the same fields
 * twice, the way `JobForm` in JobsPage.tsx is the single form for Job's
 * own flat catalog.
 */
function CenterForm({
  kind,
  initial,
  orgUnits,
  onCancel,
  onSaved,
}: {
  kind: "cost" | "profit";
  initial?: CostCenterView | ProfitCenterView;
  orgUnits: OrgUnitView[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<CenterFormValue>(
    initial
      ? { name: initial.name, code: initial.code ?? "", orgUnitId: initial.orgUnitId ?? "" }
      : EMPTY_FORM
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (initial) {
        const patch = {
          name: value.name,
          code: value.code || undefined,
          orgUnitId: value.orgUnitId || null,
        };
        if (kind === "cost") {
          await api.updateCostCenter(initial.id, patch);
        } else {
          await api.updateProfitCenter(initial.id, patch);
        }
      } else {
        const payload = {
          name: value.name,
          code: value.code || undefined,
          orgUnitId: value.orgUnitId || undefined,
        };
        if (kind === "cost") {
          await api.createCostCenter(payload);
        } else {
          await api.createProfitCenter(payload);
        }
      }
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">
        {initial ? `Editing "${initial.name}"` : `New ${kind === "cost" ? "cost" : "profit"} center`}
      </div>
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Name</label>
          <input
            required
            autoFocus={!initial}
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Code (optional)</label>
          <input
            value={value.code}
            onChange={(e) => setValue((v) => ({ ...v, code: e.target.value }))}
            placeholder={kind === "cost" ? "e.g. CC-ENG" : "e.g. PC-ENG"}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Org Unit (optional)</label>
          <select
            value={value.orgUnitId}
            onChange={(e) => setValue((v) => ({ ...v, orgUnitId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">—</option>
            {orgUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function CenterRow({
  kind,
  center,
  orgUnits,
  canManage,
  onChanged,
}: {
  kind: "cost" | "profit";
  center: CostCenterView | ProfitCenterView;
  orgUnits: OrgUnitView[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"none" | "edit">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orgUnitName = center.orgUnitId ? orgUnits.find((u) => u.id === center.orgUnitId)?.name : null;

  async function handleToggleStatus() {
    setBusy(true);
    setError(null);
    try {
      if (center.status === "active") {
        if (kind === "cost") await api.archiveCostCenter(center.id);
        else await api.archiveProfitCenter(center.id);
      } else {
        if (kind === "cost") await api.activateCostCenter(center.id);
        else await api.activateProfitCenter(center.id);
      }
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 py-2.5 border-b border-black/5 hover:bg-black/[0.02]">
        <span className="font-medium text-sm">{center.name}</span>
        {center.code && <span className="text-xs font-mono text-label-tertiary">{center.code}</span>}
        {orgUnitName && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">{orgUnitName}</span>
        )}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(center.status)}`}>
          {center.status}
        </span>

        {canManage && (
          <div className="ml-auto flex gap-3 shrink-0 text-xs">
            <button onClick={() => setMode(mode === "edit" ? "none" : "edit")} className="font-semibold text-accent hover:underline">
              Edit
            </button>
            <button onClick={handleToggleStatus} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
              {center.status === "active" ? "Archive" : "Activate"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="text-xs text-danger py-1">{error}</div>}

      {mode === "edit" && (
        <div className="py-2">
          <CenterForm
            kind={kind}
            initial={center}
            orgUnits={orgUnits}
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

function CenterSection({
  kind,
  title,
  description,
  centers,
  orgUnits,
  canManage,
  onChanged,
}: {
  kind: "cost" | "profit";
  title: string;
  description: string;
  centers: Array<CostCenterView | ProfitCenterView>;
  orgUnits: OrgUnitView[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          <p className="text-sm text-label-tertiary mt-1">{description}</p>
        </div>
        {canManage && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New {kind === "cost" ? "Cost Center" : "Profit Center"}
          </button>
        )}
      </div>

      {creating && (
        <div className="mb-4">
          <CenterForm
            kind={kind}
            orgUnits={orgUnits}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              onChanged();
            }}
          />
        </div>
      )}

      {centers.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No {kind === "cost" ? "cost centers" : "profit centers"} yet.{" "}
          {canManage ? "Create the first one above." : "Ask an HR Admin to set these up."}
        </div>
      )}

      {centers.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {centers.map((center) => (
            <CenterRow key={center.id} kind={kind} center={center} orgUnits={orgUnits} canManage={canManage} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Organization Management, Phase 4's Cost Center / Profit Center setup
 * screen — two flat catalogs (neither has a hierarchy, exactly Job's own
 * shape in JobsPage.tsx), combined into one page since they're tagged onto
 * a position together and a tenant configuring one is almost always about
 * to configure the other. `cost_center.manage.all`/`profit_center.manage.all`
 * are both hr_admin-only server-side (0074's seed); `canManage` here
 * mirrors that as a courtesy, same as every other portal screen — the real
 * gate is CostCentersService's/ProfitCentersService's own RBAC check.
 */
export function FinancialCentersPage() {
  const { identity } = useAuth();
  const [costCenters, setCostCenters] = useState<CostCenterView[] | null>(null);
  const [profitCenters, setProfitCenters] = useState<ProfitCenterView[] | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    Promise.all([api.listCostCenters(), api.listProfitCenters(), api.listOrgUnits()])
      .then(([cost, profit, units]) => {
        setCostCenters(cost);
        setProfitCenters(profit);
        setOrgUnits(units);
      })
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!costCenters || !profitCenters) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Financial Centers</h1>
        <p className="text-sm text-label-tertiary mt-1">
          Cost centers and profit centers — reusable financial dimensions you can tag positions with for reporting.
        </p>
      </div>

      <CenterSection
        kind="cost"
        title="Cost Centers"
        description="Used to tag positions for expense reporting."
        centers={costCenters}
        orgUnits={orgUnits}
        canManage={canManage}
        onChanged={load}
      />

      <CenterSection
        kind="profit"
        title="Profit Centers"
        description="Used to tag positions for revenue/profit reporting."
        centers={profitCenters}
        orgUnits={orgUnits}
        canManage={canManage}
        onChanged={load}
      />
    </div>
  );
}
