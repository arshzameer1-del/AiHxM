import { FormEvent, useEffect, useState } from "react";
import type { CandidateView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Recruitment module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type FormValue = { firstName: string; lastName: string; email: string; phone: string };

function emptyForm(): FormValue {
  return { firstName: "", lastName: "", email: "", phone: "" };
}

function CandidateForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (c: CandidateView) => void }) {
  const [value, setValue] = useState<FormValue>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const saved = await api.createCandidate({
        firstName: value.firstName,
        lastName: value.lastName,
        email: value.email || undefined,
        phone: value.phone || undefined,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this candidate.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">First name</label>
          <input
            required
            value={value.firstName}
            onChange={(e) => setValue((v) => ({ ...v, firstName: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Last name</label>
          <input
            required
            value={value.lastName}
            onChange={(e) => setValue((v) => ({ ...v, lastName: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Email (optional)</label>
          <input
            type="email"
            value={value.email}
            onChange={(e) => setValue((v) => ({ ...v, email: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Phone (optional)</label>
          <input
            value={value.phone}
            onChange={(e) => setValue((v) => ({ ...v, phone: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Adding…" : "Add candidate"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Task #51 — Recruitment, tab two. Candidates are a company-wide pool
 * with no requisition tie until an Application links the two (see
 * PipelinePanel) — candidates deliberately have no login/session of
 * their own (Decision #10), so this is purely an HR-side roster.
 */
export function CandidatesPanel() {
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listCandidates().then(setCandidates).catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!candidates) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Add candidates to the pool, then attach them to an approved requisition from the Pipeline tab.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            Add Candidate
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <CandidateForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {candidates.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No candidates yet. Add one to start building the pool.
        </div>
      )}

      {candidates.length > 0 && (
        <div className="bg-card rounded-card shadow-sm divide-y divide-black/5">
          {candidates.map((c) => (
            <div key={c.id} className="p-4 flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm">
                  {c.firstName} {c.lastName}
                </div>
                <div className="text-xs text-label-tertiary">
                  {c.email ?? "No email"} {c.phone ? `· ${c.phone}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
