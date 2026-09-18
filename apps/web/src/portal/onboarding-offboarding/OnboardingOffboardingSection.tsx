import { FormEvent, useEffect, useState } from "react";
import type { EmployeeOffboardingView, EmployeeOnboardingView, EmploymentStatus, OffboardingReason } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { ChecklistItemsList } from "./ChecklistItems";

const OFFBOARDING_REASONS: OffboardingReason[] = ["resignation", "termination", "retirement", "end_of_contract", "other"];
const OFFBOARDING_REASON_LABELS: Record<OffboardingReason, string> = {
  resignation: "Resignation",
  termination: "Termination",
  retirement: "Retirement",
  end_of_contract: "End of contract",
  other: "Other",
};

function OnboardingSubsection({
  employeeId,
  employmentStatus,
  canManage,
}: {
  employeeId: string;
  employmentStatus: EmploymentStatus;
  canManage: boolean;
}) {
  // undefined = still loading; null = module/permission denied (hide
  // this subsection entirely, the same silent-omit convention
  // Configuration Center's own dispatch loop uses); otherwise the real
  // view, or `false` meaning "no onboarding on record for this employee".
  const [onboarding, setOnboarding] = useState<EmployeeOnboardingView | null | false | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .getOnboardingForEmployee(employeeId)
      .then((v) => setOnboarding(v ?? false))
      .catch(() => setOnboarding(null));
  }

  useEffect(load, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleStart() {
    setError(null);
    setStarting(true);
    try {
      const created = await api.initiateOnboarding(employeeId);
      setOnboarding(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start onboarding for this employee.");
    } finally {
      setStarting(false);
    }
  }

  if (onboarding === undefined) return null;
  if (onboarding === null) return null; // module not enabled, or not permitted to view — nothing to show
  if (onboarding === false && !canManage) return null; // never started, and this viewer can't start one — nothing worth showing

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Onboarding</h2>
        {onboarding && (
          <span className="text-xs text-label-tertiary capitalize">
            {onboarding.status.replace("_", " ")} · started {onboarding.startedAt.slice(0, 10)}
          </span>
        )}
      </div>

      {!onboarding && (
        <>
          {canManage && employmentStatus !== "terminated" ? (
            <button
              onClick={handleStart}
              disabled={starting}
              className="text-sm font-semibold text-accent hover:underline disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start onboarding"}
            </button>
          ) : (
            <p className="text-sm text-label-tertiary">No onboarding on record for this employee.</p>
          )}
        </>
      )}

      {error && <div className="text-danger text-sm mt-2">{error}</div>}

      {onboarding && (
        <ChecklistItemsList
          items={onboarding.items}
          onUpdate={async (itemId, status) => {
            await api.updateOnboardingItem(itemId, { status });
            load();
          }}
        />
      )}
    </section>
  );
}

function OffboardingSubsection({
  employeeId,
  employmentStatus,
  canManage,
  onEmployeeTerminated,
}: {
  employeeId: string;
  employmentStatus: EmploymentStatus;
  canManage: boolean;
  onEmployeeTerminated?: () => void;
}) {
  const [offboarding, setOffboarding] = useState<EmployeeOffboardingView | null | false | undefined>(undefined);
  const [startingForm, setStartingForm] = useState(false);
  const [reason, setReason] = useState<OffboardingReason>("resignation");
  const [lastWorkingDay, setLastWorkingDay] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .getOffboardingForEmployee(employeeId)
      .then((v) => setOffboarding(v ?? false))
      .catch(() => setOffboarding(null));
  }

  useEffect(load, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleInitiate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await api.initiateOffboarding(employeeId, { reason, lastWorkingDay, notes: notes || undefined });
      setOffboarding(created);
      setStartingForm(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start offboarding for this employee.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize() {
    setError(null);
    setBusy(true);
    try {
      const updated = await api.completeOffboarding(employeeId);
      setOffboarding(updated);
      onEmployeeTerminated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not finalize this offboarding.");
    } finally {
      setBusy(false);
    }
  }

  if (offboarding === undefined) return null;
  if (offboarding === null) return null;
  if (offboarding === false && !canManage) return null;

  const pendingCount = offboarding ? offboarding.items.filter((i) => i.status === "pending").length : 0;

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Offboarding</h2>
        {offboarding && (
          <span className="text-xs text-label-tertiary capitalize">
            {offboarding.status.replace("_", " ")} · last day {offboarding.lastWorkingDay}
          </span>
        )}
      </div>

      {!offboarding && (
        <>
          {canManage && employmentStatus !== "terminated" ? (
            startingForm ? (
              <form onSubmit={handleInitiate} className="space-y-3 bg-black/5 rounded-lg p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">Reason</label>
                    <select
                      value={reason}
                      onChange={(e) => setReason(e.target.value as OffboardingReason)}
                      className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      {OFFBOARDING_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {OFFBOARDING_REASON_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Last working day</label>
                    <input
                      type="date"
                      required
                      value={lastWorkingDay}
                      onChange={(e) => setLastWorkingDay(e.target.value)}
                      className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Notes (optional)</label>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                {error && <div className="text-danger text-xs">{error}</div>}
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={busy}
                    className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  >
                    {busy ? "Starting…" : "Start offboarding"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStartingForm(false)}
                    className="text-sm font-medium text-label-tertiary hover:text-label-primary"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button onClick={() => setStartingForm(true)} className="text-sm font-semibold text-accent hover:underline">
                Start offboarding
              </button>
            )
          ) : (
            <p className="text-sm text-label-tertiary">No offboarding on record for this employee.</p>
          )}
        </>
      )}

      {offboarding && (
        <>
          {offboarding.notes && <p className="text-sm text-label-secondary mb-3">{offboarding.notes}</p>}
          <ChecklistItemsList
            items={offboarding.items}
            onUpdate={async (itemId, status) => {
              await api.updateOffboardingItem(itemId, { status });
              load();
            }}
          />
          {canManage && offboarding.status === "in_progress" && (
            <div className="mt-4 pt-4 border-t border-black/5">
              {error && <div className="text-danger text-sm mb-2">{error}</div>}
              <button
                onClick={handleFinalize}
                disabled={busy || pendingCount > 0}
                className="bg-danger text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                title={pendingCount > 0 ? `${pendingCount} item(s) still pending` : undefined}
              >
                {busy ? "Finalizing…" : "Finalize offboarding (terminates employee)"}
              </button>
              {pendingCount > 0 && (
                <span className="ml-3 text-xs text-label-tertiary">
                  {pendingCount} checklist item{pendingCount === 1 ? "" : "s"} still pending
                </span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The HR/manager-facing half of Onboarding & Offboarding's own increment
 * write-up ("a real, near-term frontend follow-on"): initiating a
 * checklist for a specific employee, and ticking its items off, lives
 * here on that employee's own detail page rather than a separate
 * dashboard route — the natural place an HR Admin or line manager
 * already goes to act on one employee. `ChecklistsPanel` (Admin Center)
 * covers the company-wide template configuration and the read-only
 * "who's mid-checklist right now" roll-up instead.
 */
export function OnboardingOffboardingSection({
  employeeId,
  employmentStatus,
  canManage,
  onEmployeeTerminated,
}: {
  employeeId: string;
  employmentStatus: EmploymentStatus;
  canManage: boolean;
  onEmployeeTerminated?: () => void;
}) {
  return (
    <>
      <OnboardingSubsection employeeId={employeeId} employmentStatus={employmentStatus} canManage={canManage} />
      <OffboardingSubsection
        employeeId={employeeId}
        employmentStatus={employmentStatus}
        canManage={canManage}
        onEmployeeTerminated={onEmployeeTerminated}
      />
    </>
  );
}
