import { FormEvent, useEffect, useState } from "react";
import { REVIEW_PHASE_KEYS } from "@aihxm/shared-types";
import type { ReviewCycleView, ReviewPhaseKey } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ErrorNote, errorText, inputCls, primaryBtn } from "./perfUi";

const LABELS: Record<ReviewPhaseKey, string> = {
  goal_setting: "Goal setting",
  self_assessment: "Self assessment",
  manager_assessment: "Manager assessment (and peer feedback)",
  calibration: "Calibration",
  release: "Release",
};

/** TAL-07: a deadline window per review phase. Leave both dates empty to leave a phase unrestricted. */
export function PhasesModal({ cycle, onClose, onSaved }: { cycle: ReviewCycleView; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<Record<ReviewPhaseKey, { startsOn: string; endsOn: string }>>(
    () => Object.fromEntries(REVIEW_PHASE_KEYS.map((k) => [k, { startsOn: "", endsOn: "" }])) as Record<ReviewPhaseKey, { startsOn: string; endsOn: string }>
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getReviewCyclePhases(cycle.id).then(({ phases }) => {
      setRows((prev) => {
        const next = { ...prev };
        for (const p of phases) next[p.phaseKey] = { startsOn: p.startsOn, endsOn: p.endsOn };
        return next;
      });
    }).catch((err) => setError(errorText(err, "Could not load the phases")));
  }, [cycle.id]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const phases = REVIEW_PHASE_KEYS.filter((k) => rows[k].startsOn || rows[k].endsOn).map((k) => ({ phaseKey: k, startsOn: rows[k].startsOn, endsOn: rows[k].endsOn }));
    if (phases.some((p) => !p.startsOn || !p.endsOn)) {
      setError("Give both a start and an end date for every phase you use.");
      return;
    }
    setBusy(true);
    try {
      await api.setReviewCyclePhases(cycle.id, { phases });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, "Could not save the phases"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="bg-card rounded-card p-6 shadow-lg max-w-xl w-full space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="font-bold text-lg">Phases for {cycle.name}</h2>
        <p className="text-sm text-label-secondary">
          Employees and managers can only act inside a phase&apos;s window. HR can always act, and a phase without dates is not restricted. Each later phase may not start or end before the one above it.
        </p>
        <ErrorNote message={error} />
        <div className="space-y-3">
          {REVIEW_PHASE_KEYS.map((k) => (
            <div key={k} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
              <span className="text-sm font-medium">{LABELS[k]}</span>
              <input aria-label={`${LABELS[k]} starts`} type="date" className={inputCls} value={rows[k].startsOn} onChange={(e) => setRows({ ...rows, [k]: { ...rows[k], startsOn: e.target.value } })} />
              <input aria-label={`${LABELS[k]} ends`} type="date" className={inputCls} value={rows[k].endsOn} onChange={(e) => setRows({ ...rows, [k]: { ...rows[k], endsOn: e.target.value } })} />
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button type="submit" disabled={busy} className={primaryBtn}>Save phases</button>
          <button type="button" onClick={onClose} className="text-sm font-medium text-label-secondary">Cancel</button>
        </div>
      </form>
    </div>
  );
}
