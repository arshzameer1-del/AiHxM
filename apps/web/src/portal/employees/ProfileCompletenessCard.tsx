import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import type { ProfileCompleteness } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { completenessLink, completenessTone, missingItems } from "./profileCompleteness";

const BAR = { good: "bg-success", warn: "bg-warning", bad: "bg-danger" } as const;

/**
 * BACKLOG53 - "your profile is 70% complete" and what is missing.
 *  - `employeeId` omitted: the signed-in employee's own record, each missing item links to where it is filled in.
 *  - `hr`: another person's record on the employee page, a plain list for HR to chase.
 *  - `compact`: one line for the launchpad; shows nothing once the profile is complete.
 */
export function ProfileCompletenessCard({ employeeId, hr = false, compact = false }: { employeeId?: string; hr?: boolean; compact?: boolean }) {
  const [data, setData] = useState<ProfileCompleteness | null>(null);
  useEffect(() => {
    const load = employeeId ? api.getEmployeeCompleteness(employeeId) : api.getMyCompleteness();
    load.then(setData).catch(() => setData(null));
  }, [employeeId]);
  if (!data) return null;
  const tone = completenessTone(data.score);
  const missing = missingItems(data.items, compact ? 3 : 20);

  if (compact) {
    if (data.score >= 100) return null;
    return (
      <div className="bg-card rounded-card p-4 shadow-sm mb-5 flex flex-wrap items-center justify-between gap-3" data-testid="completeness-nudge">
        <div className="text-sm">
          <span className="font-semibold">Your profile is {data.score}% complete.</span>{" "}
          <span className="text-label-secondary">Still missing: {missing.map((m) => m.label.toLowerCase()).join(", ")}{data.totalCount - data.doneCount > missing.length ? " and more" : ""}.</span>
        </div>
        <Link to="/app/profile" className="text-sm font-semibold text-accent hover:underline">Complete my profile</Link>
      </div>
    );
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-5" aria-label="Profile completeness" data-testid="completeness-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">{hr ? "Record completeness" : "Profile completeness"}</h2>
        <span className="text-sm font-semibold tabular-nums" data-testid="completeness-score">{data.score}%</span>
      </div>
      <div className="h-2 rounded-full bg-black/10 mt-2 overflow-hidden" role="progressbar" aria-valuenow={data.score} aria-valuemin={0} aria-valuemax={100} aria-label="Profile completeness">
        <div className={`h-full ${BAR[tone]}`} style={{ width: `${data.score}%` }} />
      </div>
      {data.score >= 100 ? (
        <p className="text-sm text-label-secondary mt-3 flex items-center gap-1.5"><CheckCircle2 size={16} className="text-success" aria-hidden="true" /> {hr ? "Nothing is missing." : "Everything HR asks for is on file."}</p>
      ) : (
        <ul className="mt-3 space-y-1.5" data-testid="completeness-missing">
          {missing.map((m) => (
            <li key={m.key} className="text-sm flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{m.label}</span>
              {hr ? <span className="text-label-tertiary">missing</span> : (
                <>
                  <span className="text-label-tertiary">{m.hint}</span>
                  <Link to={completenessLink(m.tab)} className="text-accent font-medium hover:underline">Add it</Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
