import { useEffect, useState } from "react";
import type { StarterSetupItem, StarterSetupStatus } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const STATE_LABEL: Record<StarterSetupItem["state"], string> = {
  ready: "In place",
  missing: "Missing",
  unavailable: "Not available",
  attention: "Needs a decision",
};
const STATE_CLASS: Record<StarterSetupItem["state"], string> = {
  ready: "bg-green-100 text-green-800",
  missing: "bg-amber-100 text-amber-800",
  unavailable: "bg-black/5 text-label-tertiary",
  attention: "bg-blue-100 text-blue-800",
};
const GROUP_LABEL: Record<StarterSetupItem["group"], string> = {
  approvals: "Approval routes",
  calendar: "Calendar",
  leave: "Leave",
  attendance: "Attendance",
  payroll: "Payroll",
};

/**
 * What a company needs on its first day, and a button that adds what is missing. Shown only to people the
 * server lets read it; a 403 simply hides the panel (the Configuration Center is useful without it).
 */
export function StarterSetupPanel() {
  const [status, setStatus] = useState<StarterSetupStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getStarterSetup()
      .then(setStatus)
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setHidden(true);
        else setError("Could not load the starter setup.");
      });
  }, []);

  async function apply() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.applyStarterSetup();
      setStatus(result.status);
      setMessage(
        result.created.length
          ? `Added ${result.created.length} item${result.created.length === 1 ? "" : "s"}. You can edit every one of them in its own screen.`
          : "Nothing to add: everything the starter setup covers is already there.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not apply the starter setup.");
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!status && !error) return null;

  const open = status ? status.items.filter((i) => i.state !== "ready").length : 0;

  return (
    <section aria-labelledby="starter-setup-title" className="bg-card rounded-card p-5 shadow-sm mb-6" data-testid="starter-setup">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="max-w-2xl">
          <h2 id="starter-setup-title" className="font-semibold">Starter setup</h2>
          <p className="text-xs text-label-tertiary mt-1">
            The first things a new company needs before people can request leave, claim expenses or run payroll: approval routes, Pakistan's
            fixed-date public holidays, a standard leave policy and a general shift. Everything it adds is an ordinary record you edit later.
          </p>
        </div>
        {status?.canApply && (
          <button
            type="button"
            onClick={apply}
            disabled={busy}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add the missing items"}
          </button>
        )}
      </div>

      {message && <p role="status" className="text-sm text-green-700 mt-3">{message}</p>}
      {error && <p role="alert" className="text-sm text-danger mt-3">{error}</p>}

      {status && (
        <>
          {open === 0 && !message && <p className="text-sm text-green-700 mt-3">Everything the starter setup covers is in place.</p>}
          <ul className="mt-4 divide-y divide-black/5">
            {status.items.map((item) => (
              <li key={item.key} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {item.label} <span className="text-xs font-normal text-label-tertiary">· {GROUP_LABEL[item.group]}</span>
                  </div>
                  <div className="text-xs text-label-secondary mt-0.5">{item.detail}</div>
                </div>
                <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATE_CLASS[item.state]}`}>{STATE_LABEL[item.state]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
