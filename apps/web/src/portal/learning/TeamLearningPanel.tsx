import { useEffect, useState } from "react";
import type { CourseEnrollmentView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { ENROLLMENT_STATUS_LABELS, ENROLLMENT_STATUS_STYLES } from "./learningLabels";
import { groupTeamLearning } from "./teamLearning";

/** A Line Manager's view of their team's learning: read only, one block per person (the server already limits it to their reports). */
export function TeamLearningPanel({ myEmployeeId }: { myEmployeeId: string | null | undefined }) {
  const [rows, setRows] = useState<CourseEnrollmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listCourseEnrollments()
      .then(setRows)
      .catch(() => setError("The team's learning could not be loaded."));
  }, []);
  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!rows) return <LoadingNote what="your team's learning" />;
  const team = groupTeamLearning(rows, myEmployeeId);
  return (
    <div data-testid="team-learning">
      <h2 className="text-lg font-semibold mb-4">My Team</h2>
      {team.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No one in your team has learning assigned yet.</div>
      ) : (
        <div className="space-y-3">
          {team.map((m) => (
            <section key={m.employeeId} className="bg-card rounded-card p-4 shadow-sm" aria-label={m.name}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h3 className="font-semibold text-sm">
                  {m.name} {m.employeeNumber && <span className="text-xs font-normal text-label-tertiary">({m.employeeNumber})</span>}
                </h3>
                <p className="text-xs text-label-secondary tabular-nums">
                  {m.completed} of {m.enrollments.length} completed · average {m.averageProgress}%{m.overdue > 0 ? ` · ${m.overdue} overdue` : ""}
                </p>
              </div>
              <ul className="mt-2 divide-y divide-black/5">
                {m.enrollments.map((e) => (
                  <li key={e.id} className="py-1.5 flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{e.course.title}</span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-xs tabular-nums text-label-tertiary">{e.progressPercent}%</span>
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ENROLLMENT_STATUS_STYLES[e.status]}`}>{ENROLLMENT_STATUS_LABELS[e.status]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
