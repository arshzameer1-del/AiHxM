import type { CourseEnrollmentView } from "@aihxm/shared-types";

export type TeamMemberLearning = {
  employeeId: string;
  name: string;
  employeeNumber: string | null;
  enrollments: CourseEnrollmentView[];
  completed: number;
  overdue: number;
  averageProgress: number;
};

/** One row per person on the manager's team (the manager's own courses are not part of it), people with overdue courses first. */
export function groupTeamLearning(rows: readonly CourseEnrollmentView[], myEmployeeId: string | null | undefined): TeamMemberLearning[] {
  const by = new Map<string, TeamMemberLearning>();
  for (const e of rows) {
    if (myEmployeeId && e.employeeId === myEmployeeId) continue;
    let m = by.get(e.employeeId);
    if (!m) {
      m = { employeeId: e.employeeId, name: e.employeeName ?? "Team member", employeeNumber: e.employeeNumber, enrollments: [], completed: 0, overdue: 0, averageProgress: 0 };
      by.set(e.employeeId, m);
    }
    m.enrollments.push(e);
    if (e.status === "completed") m.completed++;
    if (e.status === "overdue") m.overdue++;
  }
  for (const m of by.values()) {
    m.averageProgress = Math.round(m.enrollments.reduce((n, e) => n + e.progressPercent, 0) / m.enrollments.length);
  }
  return [...by.values()].sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name));
}
