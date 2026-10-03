import type { CourseCategory, CourseEnrollmentStatus } from "@aihxm/shared-types";

/**
 * Matches CreateCourseDto's own `@IsIn(COURSE_CATEGORIES)` list — kept
 * explicit rather than derived so this file fails to compile the day the
 * backend's allowed set changes, same discipline leaveLabels.ts/
 * expenseLabels.ts already follow.
 */
export const COURSE_CATEGORIES: CourseCategory[] = ["compliance", "technical", "soft_skills", "leadership", "other"];

export const COURSE_CATEGORY_LABELS: Record<CourseCategory, string> = {
  compliance: "Compliance",
  technical: "Technical",
  soft_skills: "Soft Skills",
  leadership: "Leadership",
  other: "Other",
};

// Part 2's own four status chips: "Assigned, In Progress, Completed,
// Overdue." Same semantic-color mapping leaveLabels/expenseLabels use.
export const ENROLLMENT_STATUS_STYLES: Record<CourseEnrollmentStatus, string> = {
  assigned: "bg-black/5 text-label-tertiary",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-success/15 text-green-700",
  overdue: "bg-danger/15 text-red-700",
};

export const ENROLLMENT_STATUS_LABELS: Record<CourseEnrollmentStatus, string> = {
  assigned: "Assigned",
  in_progress: "In Progress",
  completed: "Completed",
  overdue: "Overdue",
};
