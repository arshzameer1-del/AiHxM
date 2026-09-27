import { FormEvent, ReactNode, useEffect, useState } from "react";
import type { EmployeeView, LocationView, OrgUnitView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * Core Employee Enterprise Phase 10's frontend catch-up (2026-09-27) —
 * `EmployeeLifecycleController`'s 9 explicit transactions
 * (transfer/promote/demote/second/act/change-manager/change-location/
 * terminate/reactivate) had no UI at all; `EmployeesController`'s generic
 * `PATCH /employees/:id` (the Edit form on the Overview tab) is what this
 * screen's own "Edit" link still uses for everything else. These 9 are
 * kept as a single accordion-style list — one action open at a time,
 * matching `LoginSection`'s own inline-reveal pattern elsewhere on this
 * page — rather than 9 separate always-visible forms, since only one is
 * ever used at a time and an HR Admin picks the transaction by name, the
 * same way the spec's own Section 26 names each one individually rather
 * than presenting them as fields on one big form.
 */

type ActionKey = "transfer" | "promote" | "demote" | "second" | "act" | "change-manager" | "change-location" | "terminate" | "reactivate";

const ACTIONS: { key: ActionKey; label: string }[] = [
  { key: "transfer", label: "Transfer" },
  { key: "promote", label: "Promote" },
  { key: "demote", label: "Demote" },
  { key: "second", label: "Second (temporary posting)" },
  { key: "act", label: "Assign acting role" },
  { key: "change-manager", label: "Change manager" },
  { key: "change-location", label: "Change location" },
  { key: "terminate", label: "Terminate" },
  { key: "reactivate", label: "Reactivate" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

export function LifecycleActionsPanel({
  employee,
  onChanged,
}: {
  employee: EmployeeView;
  onChanged: (employee: EmployeeView) => void;
}) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [locations, setLocations] = useState<LocationView[]>([]);
  const [colleagues, setColleagues] = useState<EmployeeView[]>([]);
  const [result, setResult] = useState<{ action: ActionKey; note: string } | null>(null);

  useEffect(() => {
    api.listOrgUnits().then(setOrgUnits).catch(() => setOrgUnits([]));
    api.listLocations().then(setLocations).catch(() => setLocations([]));
    api.listEmployees().then((rows) => setColleagues(rows.filter((r) => r.id !== employee.id))).catch(() => setColleagues([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id]);

  if (employee.employmentStatus === "terminated") {
    return (
      <section className="bg-card rounded-card p-5 shadow-sm mb-6">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Lifecycle actions</h2>
        <p className="text-sm text-label-secondary">
          This employee is terminated. Only <span className="font-medium">Reactivate</span> is available.
        </p>
        <div className="mt-3">
          <button
            onClick={() => setOpen(open === "reactivate" ? null : "reactivate")}
            className={`text-xs font-semibold rounded-full px-3 py-1.5 ${
              open === "reactivate" ? "bg-accent text-white" : "bg-accent/10 text-accent hover:bg-accent/20"
            }`}
          >
            Reactivate
          </button>
          {open === "reactivate" && (
            <div className="mt-3">
              <ActionForm
                actionKey="reactivate"
                employee={employee}
                orgUnits={orgUnits}
                locations={locations}
                colleagues={colleagues}
                onCancel={() => setOpen(null)}
                onDone={(note) => {
                  setResult({ action: "reactivate", note });
                  setOpen(null);
                }}
                onChanged={onChanged}
              />
            </div>
          )}
        </div>
        {result && <ResultBanner result={result} />}
      </section>
    );
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Lifecycle actions</h2>
      <div className="flex flex-wrap gap-2 mb-3">
        {ACTIONS.filter((a) => a.key !== "reactivate").map((a) => (
          <button
            key={a.key}
            onClick={() => setOpen(open === a.key ? null : a.key)}
            className={`text-xs font-semibold rounded-full px-3 py-1.5 ${
              open === a.key ? "bg-accent text-white" : "bg-accent/10 text-accent hover:bg-accent/20"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {open && (
        <ActionForm
          actionKey={open}
          employee={employee}
          orgUnits={orgUnits}
          locations={locations}
          colleagues={colleagues}
          onCancel={() => setOpen(null)}
          onDone={(note) => {
            setResult({ action: open, note });
            setOpen(null);
          }}
          onChanged={onChanged}
        />
      )}

      {result && <ResultBanner result={result} />}
    </section>
  );
}

function ResultBanner({ result }: { result: { action: ActionKey; note: string } }) {
  return (
    <div className="mt-3 bg-success/10 border border-success/20 rounded-lg p-3 text-xs text-label-secondary">{result.note}</div>
  );
}

function ActionForm({
  actionKey,
  employee,
  orgUnits,
  locations,
  colleagues,
  onCancel,
  onDone,
  onChanged,
}: {
  actionKey: ActionKey;
  employee: EmployeeView;
  orgUnits: OrgUnitView[];
  locations: LocationView[];
  colleagues: EmployeeView[];
  onCancel: () => void;
  onDone: (note: string) => void;
  onChanged: (e: EmployeeView) => void;
}) {
  const [orgUnitId, setOrgUnitId] = useState("");
  const [locationId, setLocationId] = useState(employee.locationId ?? "");
  const [designation, setDesignation] = useState(employee.designation ?? "");
  const [salaryBand, setSalaryBand] = useState(employee.salaryBand ?? "");
  const [managerId, setManagerId] = useState(employee.managerId ?? "");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [terminationDate, setTerminationDate] = useState(todayIso());
  const [terminationReason, setTerminationReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      let result;
      switch (actionKey) {
        case "transfer":
          result = await api.transferEmployee(employee.id, {
            orgUnitId: orgUnitId || undefined,
            locationId: locationId || undefined,
            effectiveDate,
            notes: notes || undefined,
          });
          break;
        case "promote":
          result = await api.promoteEmployee(employee.id, {
            designation,
            salaryBand: salaryBand || undefined,
            effectiveDate,
            notes: notes || undefined,
          });
          break;
        case "demote":
          result = await api.demoteEmployee(employee.id, {
            designation,
            salaryBand: salaryBand || undefined,
            effectiveDate,
            notes: notes || undefined,
          });
          break;
        case "second":
          result = await api.secondEmployee(employee.id, {
            orgUnitId: orgUnitId || undefined,
            designation: designation || undefined,
            locationId: locationId || undefined,
            effectiveDate,
            endDate,
            notes: notes || undefined,
          });
          break;
        case "act":
          result = await api.assignEmployeeActingRole(employee.id, {
            designation,
            orgUnitId: orgUnitId || undefined,
            effectiveDate,
            endDate,
            notes: notes || undefined,
          });
          break;
        case "change-manager":
          result = await api.changeEmployeeManager(employee.id, { managerId, effectiveDate, notes: notes || undefined });
          break;
        case "change-location":
          result = await api.changeEmployeeLocation(employee.id, { locationId, effectiveDate, notes: notes || undefined });
          break;
        case "terminate":
          result = await api.terminateEmployeeLifecycle(employee.id, {
            terminationDate,
            terminationReason: terminationReason || undefined,
            notes: notes || undefined,
          });
          break;
        case "reactivate":
          result = await api.reactivateEmployee(employee.id, { effectiveDate, notes: notes || undefined });
          break;
      }
      onChanged(result.employee);
      onDone(`${ACTIONS.find((a) => a.key === actionKey)?.label} recorded — ${result.jobHistory.eventType.replace("_", " ")} effective ${result.jobHistory.effectiveDate}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not complete this action.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {(actionKey === "transfer" || actionKey === "second" || actionKey === "act") && (
          <Field label="Org unit">
            <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} className={inputClass}>
              <option value="">— unchanged —</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {(actionKey === "transfer" || actionKey === "second" || actionKey === "change-location") && (
          <Field label={actionKey === "change-location" ? "New location" : "Location"}>
            <select
              required={actionKey === "change-location"}
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className={inputClass}
            >
              <option value="">{actionKey === "change-location" ? "Select…" : "— unchanged —"}</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {(actionKey === "promote" || actionKey === "demote" || actionKey === "act") && (
          <Field label="New designation">
            <input required value={designation} onChange={(e) => setDesignation(e.target.value)} className={inputClass} />
          </Field>
        )}
        {(actionKey === "promote" || actionKey === "demote") && (
          <Field label="Salary band">
            <input value={salaryBand} onChange={(e) => setSalaryBand(e.target.value)} className={inputClass} placeholder="optional" />
          </Field>
        )}
        {actionKey === "change-manager" && (
          <Field label="New manager">
            <select required value={managerId} onChange={(e) => setManagerId(e.target.value)} className={inputClass}>
              <option value="">Select…</option>
              {colleagues.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {actionKey === "terminate" ? (
          <Field label="Termination date">
            <input type="date" required value={terminationDate} onChange={(e) => setTerminationDate(e.target.value)} className={inputClass} />
          </Field>
        ) : (
          <Field label="Effective date">
            <input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputClass} />
          </Field>
        )}
        {(actionKey === "second" || actionKey === "act") && (
          <Field label="Ends on">
            <input type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
          </Field>
        )}
        {actionKey === "terminate" && (
          <Field label="Reason">
            <input value={terminationReason} onChange={(e) => setTerminationReason(e.target.value)} className={inputClass} placeholder="optional" />
          </Field>
        )}
        <div className="col-span-2">
          <Field label="Notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} placeholder="optional" />
          </Field>
        </div>
      </div>

      {error && <div className="text-danger text-xs">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
            actionKey === "terminate" ? "bg-danger text-white" : "bg-accent text-white"
          }`}
        >
          {saving ? "Submitting…" : ACTIONS.find((a) => a.key === actionKey)?.label}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}
