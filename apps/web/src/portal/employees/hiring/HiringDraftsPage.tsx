import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { HireProcessView } from "@aihxm/shared-types";
import { api, ApiError } from "../../../api/client";

/**
 * Core Employee Enterprise Phase 2's Hiring Wizard entry point
 * (2026-09-27) — `/app/employees/hire`. Lists in-progress drafts
 * (`listHiringDrafts`, which the backend already scopes to non-terminal
 * `HireProcessView`s) and lets HR start a brand-new one
 * (`startHireProcess`), then navigates into `HiringWizardPage` by the
 * new/selected process id.
 */
export function HiringDraftsPage() {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<HireProcessView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  function load() {
    api
      .listHiringDrafts()
      .then(setDrafts)
      .catch(() => setError("Could not load in-progress hires."));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleStartNew() {
    setStarting(true);
    setError(null);
    try {
      const process = await api.startHireProcess();
      navigate(`/app/employees/hire/${process.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a new hire.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold tracking-tight">Hire an employee</h1>
        <button
          onClick={handleStartNew}
          disabled={starting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {starting ? "Starting…" : "+ Start new hire"}
        </button>
      </div>
      <p className="text-label-tertiary text-sm mb-6">
        Walk through the hiring wizard card by card. In-progress hires are saved automatically as you go — come back any
        time to pick up where you left off.
      </p>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {drafts === null && <div className="text-sm text-label-tertiary">Loading…</div>}
      {drafts && drafts.length === 0 && <div className="text-sm text-label-tertiary">No hires in progress.</div>}

      {drafts && drafts.length > 0 && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">In progress</h2>
          <div className="divide-y divide-black/5">
            {drafts.map((d) => {
              const total = d.cards.filter((c) => c.definition.isEnabled).length;
              const done = d.cards.filter((c) => c.definition.isEnabled && c.status === "complete").length;
              return (
                <button
                  key={d.id}
                  onClick={() => navigate(`/app/employees/hire/${d.id}`)}
                  className="w-full flex items-center justify-between py-3 text-left hover:bg-black/5 rounded-lg px-2 -mx-2"
                >
                  <div>
                    <div className="text-sm font-medium capitalize">{d.status.replace(/_/g, " ")}</div>
                    <div className="text-xs text-label-tertiary">
                      Started {new Date(d.createdAt).toLocaleDateString()} · {done}/{total} cards complete
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-accent">Continue →</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
