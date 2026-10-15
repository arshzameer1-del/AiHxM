import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CompetencyView, EmployeeView, FeedbackRequestView, PerformanceReviewView, RatingSource, ReviewScorecardView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ErrorNote, Field, errorText, inputCls, primaryBtn } from "./perfUi";

const SOURCE_LABELS: Record<RatingSource, string> = {
  self: "Self",
  manager: "Manager",
  peer: "Peers",
  upward: "Upward",
  skip_level: "Skip-level",
  calibration: "Calibration",
};

type RatingSourceInput = "self" | "manager" | "calibration";

/**
 * TAL-06: per-goal and per-competency ratings, the scorecard that combines the sources, and the multi-rater (360) requests
 * for one review. What each viewer sees is decided by the API: the employee never sees calibration, and anonymous
 * multi-rater input stays hidden until the tenant's minimum number of raters has responded.
 */
export function ScorecardSection({ review, employeeName }: { review: PerformanceReviewView; employeeName: string }) {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];
  const isHr = roleKeys.includes("hr_admin");
  const isManager = roleKeys.includes("line_manager");
  const isSelf = identity?.employeeId === review.employeeId;

  const [card, setCard] = useState<ReviewScorecardView | null>(null);
  const [competencies, setCompetencies] = useState<CompetencyView[]>([]);
  const [requests, setRequests] = useState<FeedbackRequestView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<RatingSourceInput>(isSelf ? "self" : isHr && !isManager ? "calibration" : "manager");
  const [draft, setDraft] = useState<Record<string, { rating: string; comment: string }>>({});
  const [busy, setBusy] = useState(false);
  const [raters, setRaters] = useState<string[]>([]);
  const [raterType, setRaterType] = useState<"peer" | "upward" | "skip_level" | "other">("peer");
  const [anonymous, setAnonymous] = useState(true);
  const [dueDate, setDueDate] = useState("");

  const canRequest = isHr || isManager;
  const canRate = review.status !== "released" && (isSelf || isManager || isHr);

  const load = useCallback(async () => {
    try {
      setCard(await api.getReviewScorecard(review.id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load the scorecard"));
    }
    if (canRequest) api.listFeedbackRequestsForReview(review.id).then(setRequests).catch(() => undefined);
  }, [review.id, canRequest]);

  useEffect(() => {
    void load();
    api.listCompetencies().then(setCompetencies).catch(() => undefined);
    if (canRequest) api.listEmployees().then(setEmployees).catch(() => undefined);
  }, [load, canRequest]);

  async function saveRatings(e: FormEvent) {
    e.preventDefault();
    const ratings = Object.entries(draft)
      .filter(([, v]) => v.rating)
      .map(([key, v]) => {
        const [kind, id] = key.split(":");
        return { ...(kind === "goal" ? { goalId: id } : { competencyId: id }), rating: Number(v.rating), comment: v.comment || undefined };
      });
    if (ratings.length === 0) {
      setError("Pick at least one rating first.");
      return;
    }
    setBusy(true);
    try {
      await api.setReviewRatings(review.id, { source, ratings });
      setDraft({});
      await load();
    } catch (err) {
      setError(errorText(err, "Could not save the ratings"));
    } finally {
      setBusy(false);
    }
  }

  async function askForFeedback(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.requestFeedback(review.id, { raterEmployeeIds: raters, raterType, isAnonymous: anonymous, dueDate: dueDate || undefined });
      setRaters([]);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not send the requests"));
    } finally {
      setBusy(false);
    }
  }

  const setDraftFor = (key: string, patch: Partial<{ rating: string; comment: string }>) =>
    setDraft((d) => ({ ...d, [key]: { rating: d[key]?.rating ?? "", comment: d[key]?.comment ?? "", ...patch } }));

  const sources = (Object.keys(SOURCE_LABELS) as RatingSource[]).filter(
    (s) => card && (card.goals.some((g) => g.ratings[s] !== undefined) || card.competencies.some((c) => c.ratings[s] !== undefined))
  );

  return (
    <div className="space-y-5 border-t border-black/10 pt-5 mt-5">
      <h4 className="font-semibold">Ratings and scorecard — {employeeName}</h4>
      <ErrorNote message={error} />

      {card && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left">
                <th className="py-2 pr-3 font-semibold">Goal / competency</th>
                <th className="py-2 pr-3 font-semibold">Weight</th>
                {sources.map((s) => (
                  <th key={s} className="py-2 pr-3 font-semibold">{SOURCE_LABELS[s]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {card.goals.map((g) => (
                <tr key={g.goalId} className="border-b border-black/5">
                  <td className="py-2 pr-3">{g.title} <span className="text-xs text-label-tertiary">({Math.round(g.progressPct)}% done)</span></td>
                  <td className="py-2 pr-3 tabular-nums">{g.weight ?? "-"}</td>
                  {sources.map((s) => (
                    <td key={s} className="py-2 pr-3 tabular-nums">{g.ratings[s] ?? "-"}</td>
                  ))}
                </tr>
              ))}
              {card.competencies.map((c) => (
                <tr key={c.competencyId} className="border-b border-black/5">
                  <td className="py-2 pr-3">{c.name}</td>
                  <td className="py-2 pr-3">-</td>
                  {sources.map((s) => (
                    <td key={s} className="py-2 pr-3 tabular-nums">
                      {c.ratings[s] ? `${c.ratings[s]!.average} (${c.ratings[s]!.count})` : "-"}
                    </td>
                  ))}
                </tr>
              ))}
              {Object.keys(card.weightedGoalScore).length > 0 && (
                <tr className="font-semibold">
                  <td className="py-2 pr-3">Weighted goal score</td>
                  <td />
                  {sources.map((s) => (
                    <td key={s} className="py-2 pr-3 tabular-nums">{card.weightedGoalScore[s] ?? "-"}</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          {card.withheldAnonymousCount > 0 && (
            <p className="text-xs text-label-tertiary mt-2">
              {card.withheldAnonymousCount} anonymous response(s) are hidden until enough people have responded to protect their identity.
            </p>
          )}
          {card.goals.length === 0 && card.competencies.length === 0 && <p className="text-sm text-label-tertiary">No ratings yet.</p>}
        </div>
      )}

      {canRate && card && (
        <form onSubmit={saveRatings} className="bg-black/5 rounded-lg p-4 space-y-3">
          <div className="flex items-end gap-4 flex-wrap">
            <Field label="Rate as">
              <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value as RatingSourceInput)}>
                {isSelf && <option value="self">Self</option>}
                {(isManager || isHr) && !isSelf && <option value="manager">Manager</option>}
                {isHr && <option value="calibration">Calibration (HR only, never shown to the employee)</option>}
              </select>
            </Field>
          </div>
          <div className="space-y-2">
            {card.goals.map((g) => (
              <RatingRow key={g.goalId} label={g.title} value={draft[`goal:${g.goalId}`]} onChange={(p) => setDraftFor(`goal:${g.goalId}`, p)} />
            ))}
            {competencies.map((c) => (
              <RatingRow key={c.id} label={`${c.name}${c.category ? ` · ${c.category}` : ""}`} value={draft[`competency:${c.id}`]} onChange={(p) => setDraftFor(`competency:${c.id}`, p)} />
            ))}
          </div>
          <button type="submit" disabled={busy} className={primaryBtn}>Save ratings</button>
        </form>
      )}

      {canRequest && review.status !== "released" && (
        <div className="space-y-3">
          <h5 className="font-medium text-sm">360° feedback requests</h5>
          {requests.length > 0 && (
            <ul className="text-sm divide-y divide-black/5">
              {requests.map((r) => {
                const emp = employees.find((x) => x.id === r.raterEmployeeId);
                return (
                  <li key={r.id} className="py-2 flex items-center justify-between gap-3">
                    <span>{emp ? `${emp.firstName} ${emp.lastName}` : r.raterEmployeeId} · {r.raterType.replace("_", "-")}{r.isAnonymous ? " · anonymous" : ""}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs capitalize text-label-secondary">{r.status}</span>
                      {r.status === "requested" && (
                        <button type="button" className="text-xs text-danger" onClick={() => api.cancelFeedbackRequest(r.id).then(load).catch((err) => setError(errorText(err, "Could not cancel")))}>Cancel</button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <form onSubmit={askForFeedback} className="bg-black/5 rounded-lg p-4 space-y-3">
            <Field label="Ask these people">
              <select multiple className={`${inputCls} h-32`} value={raters} onChange={(e) => setRaters(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {employees.filter((x) => x.id !== review.employeeId).map((x) => (
                  <option key={x.id} value={x.id}>{x.firstName} {x.lastName} ({x.employeeNumber})</option>
                ))}
              </select>
            </Field>
            <div className="flex flex-wrap gap-4 items-end">
              <Field label="They are the employee's">
                <select className={inputCls} value={raterType} onChange={(e) => setRaterType(e.target.value as typeof raterType)}>
                  <option value="peer">Peers</option>
                  <option value="upward">Direct reports (upward)</option>
                  <option value="skip_level">Skip-level managers</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="Due"><input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Keep responses anonymous</label>
            </div>
            <button type="submit" disabled={busy || raters.length === 0} className={primaryBtn}>Send requests</button>
          </form>
        </div>
      )}
    </div>
  );
}

function RatingRow({ label, value, onChange }: { label: string; value?: { rating: string; comment: string }; onChange: (patch: Partial<{ rating: string; comment: string }>) => void }) {
  return (
    <div className="grid grid-cols-[1fr_6rem] sm:grid-cols-[1fr_6rem_1fr] gap-2 items-center">
      <span className="text-sm">{label}</span>
      <select aria-label={`Rating for ${label}`} className={inputCls} value={value?.rating ?? ""} onChange={(e) => onChange({ rating: e.target.value })}>
        <option value="">—</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>{n} / 5</option>
        ))}
      </select>
      <input aria-label={`Comment for ${label}`} className={`${inputCls} col-span-2 sm:col-span-1`} placeholder="Comment (optional)" value={value?.comment ?? ""} onChange={(e) => onChange({ comment: e.target.value })} />
    </div>
  );
}
