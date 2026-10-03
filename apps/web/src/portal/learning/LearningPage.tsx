import { FormEvent, useEffect, useState } from "react";
import { BookOpen, GraduationCap, PlayCircle } from "lucide-react";
import type { CourseCategory, CourseEnrollmentView, CourseView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { COURSE_CATEGORIES, COURSE_CATEGORY_LABELS, ENROLLMENT_STATUS_LABELS, ENROLLMENT_STATUS_STYLES } from "./learningLabels";

type Tab = "my-learning" | "browse" | "progress";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Learning & Development isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-black/5 overflow-hidden">
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * "Continue Learning card with progress and resume action" — Part 2's
 * own spec. Picks the most recently touched not-yet-completed enrollment
 * (in_progress first, falling back to the oldest still-assigned one) —
 * same "pick the one thing most worth surfacing" judgment
 * QuickActionsRow/UpcomingAndRecentLeave on the Home page already make.
 */
function ContinueLearningCard({ enrollment, onChanged }: { enrollment: CourseEnrollmentView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      const next = Math.min(100, enrollment.progressPercent + 25 || 25);
      await api.updateCourseEnrollmentProgress(enrollment.id, { progressPercent: next });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update progress.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Continue Learning</h2>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="font-medium text-sm">{enrollment.course.title}</div>
          <div className="text-xs text-label-tertiary mt-0.5">
            {COURSE_CATEGORY_LABELS[enrollment.course.category]} · {enrollment.course.durationMinutes} min
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1">
              <ProgressBar percent={enrollment.progressPercent} />
            </div>
            <span className="text-xs tabular-nums text-label-tertiary">{enrollment.progressPercent}%</span>
          </div>
        </div>
        <button
          onClick={resume}
          disabled={busy}
          className="shrink-0 flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-1.5 bg-accent text-white disabled:opacity-50"
        >
          <PlayCircle size={14} /> {enrollment.progressPercent === 0 ? "Start" : "Resume"}
        </button>
      </div>
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </section>
  );
}

function EnrollmentRow({ enrollment, onChanged }: { enrollment: CourseEnrollmentView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markComplete() {
    setBusy(true);
    setError(null);
    try {
      await api.updateCourseEnrollmentProgress(enrollment.id, { progressPercent: 100 });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark this complete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{enrollment.course.title}</div>
          <div className="text-sm text-label-secondary mt-0.5">
            {COURSE_CATEGORY_LABELS[enrollment.course.category]} · {enrollment.course.durationMinutes} min
            {enrollment.dueDate && ` · due ${enrollment.dueDate}`}
            {enrollment.isOnBehalf && <span className="text-xs text-label-tertiary"> (assigned by HR)</span>}
          </div>
          {enrollment.status !== "completed" && (
            <div className="mt-2 max-w-xs">
              <ProgressBar percent={enrollment.progressPercent} />
            </div>
          )}
        </div>
        <span
          className={`shrink-0 inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${ENROLLMENT_STATUS_STYLES[enrollment.status]}`}
        >
          {ENROLLMENT_STATUS_LABELS[enrollment.status]}
        </span>
      </div>
      {enrollment.status !== "completed" && (
        <div className="mt-3 pt-3 border-t border-black/5 flex items-center gap-4">
          <button onClick={markComplete} disabled={busy} className="text-xs font-semibold text-green-700 hover:underline">
            Mark complete
          </button>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
      {enrollment.status === "completed" && enrollment.completedAt && (
        <div className="mt-2 text-xs text-label-tertiary">Completed {enrollment.completedAt.slice(0, 10)}</div>
      )}
    </div>
  );
}

function AddCourseForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<CourseCategory>("compliance");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const duration = Number(durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) {
      setError("Enter a duration greater than zero.");
      return;
    }
    setSubmitting(true);
    try {
      await api.createCourse({ title, category, durationMinutes: duration, description: description || undefined });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this course.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4 mb-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1">
          <label className="block text-xs font-medium mb-1">Title</label>
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as CourseCategory)}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {COURSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {COURSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Duration (minutes)</label>
          <input
            type="number"
            min="1"
            required
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Add course"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function CourseCard({
  course,
  enrollment,
  canEnroll,
  canManageCatalog,
  onChanged,
}: {
  course: CourseView;
  enrollment: CourseEnrollmentView | undefined;
  canEnroll: boolean;
  canManageCatalog: boolean;
  employeeId?: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { identity } = useAuth();

  async function handleEnroll() {
    if (!identity?.employeeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.enrollInCourse({ employeeId: identity.employeeId, courseId: course.id });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not enroll in this course.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    setBusy(true);
    setError(null);
    try {
      await api.setCourseActive(course.id, false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not deactivate this course.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm flex flex-col gap-2">
      <div className="font-medium text-sm">{course.title}</div>
      <div className="text-xs text-label-tertiary">
        {COURSE_CATEGORY_LABELS[course.category]} · {course.durationMinutes} min
      </div>
      {course.description && <div className="text-xs text-label-secondary">{course.description}</div>}
      <div className="mt-auto pt-2 flex items-center justify-between gap-2">
        {enrollment ? (
          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ENROLLMENT_STATUS_STYLES[enrollment.status]}`}>
            {ENROLLMENT_STATUS_LABELS[enrollment.status]}
          </span>
        ) : canEnroll ? (
          <button onClick={handleEnroll} disabled={busy} className="text-xs font-semibold text-accent hover:underline disabled:opacity-50">
            Enroll
          </button>
        ) : (
          <span className="text-xs text-label-tertiary">Not enrolled</span>
        )}
        {canManageCatalog && (
          <button onClick={handleDeactivate} disabled={busy} className="text-xs text-label-tertiary hover:text-danger">
            Deactivate
          </button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * Learning & Development — Part 2 category 7, built end to end per
 * kumail's "develop ESS end to end as per documentation" instruction
 * (2026-10). Unlike Leave/Expense Management, Part 2 scopes this
 * category to the Employee/ESS persona only (its own category table),
 * so — unlike LeavePage/ExpensesPage — there's no manager/HR "everyone's
 * progress" view here; the one HR-only affordance is managing the
 * catalog itself (course.manage.all), since that has to live somewhere
 * and no separate admin screen was asked for.
 */
export function LearningPage() {
  const { identity } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("my-learning");
  const [courses, setCourses] = useState<CourseView[] | null>(null);
  const [enrollments, setEnrollments] = useState<CourseEnrollmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const roleKeys = identity?.roleKeys ?? [];
  const canManageCatalog = roleKeys.includes("hr_admin");
  const canEnroll = roleKeys.includes("employee_self_service") && Boolean(identity?.employeeId);

  useEffect(() => {
    Promise.all([api.listCourses(), identity?.employeeId ? api.listCourseEnrollments(identity.employeeId) : Promise.resolve([])])
      .then(([courseRows, enrollmentRows]) => {
        setCourses(courseRows);
        setEnrollments(enrollmentRows);
      })
      .catch((err) => setError(describeError(err)));
  }, [refreshKey, identity?.employeeId]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!courses || !enrollments) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const enrollmentByCourseId = new Map(enrollments.map((e) => [e.courseId, e]));
  const active = enrollments.filter((e) => e.status !== "completed");
  const completed = enrollments.filter((e) => e.status === "completed");
  const continueLearning =
    active.find((e) => e.status === "in_progress" || e.status === "overdue") ?? active[0] ?? null;

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Learning & Development</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Assigned learning, your progress, and the courses available to you.
      </p>

      <div className="border-b border-black/10 mb-6">
        <nav className="flex gap-1 -mb-px" role="tablist">
          {(
            [
              ["my-learning", "My Learning", GraduationCap],
              ["browse", "Browse Courses", BookOpen],
              ["progress", "My Progress", PlayCircle],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={activeTab === key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? "border-accent text-accent"
                  : "border-transparent text-label-secondary hover:text-label-primary hover:border-black/20"
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === "my-learning" && (
        <div>
          {continueLearning && <ContinueLearningCard enrollment={continueLearning} onChanged={bump} />}
          <h2 className="text-lg font-semibold mb-4">My Learning</h2>
          {active.length === 0 ? (
            <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
              Nothing assigned right now — browse the catalog to get started.
            </div>
          ) : (
            <div className="space-y-3">
              {active.map((e) => (
                <EnrollmentRow key={e.id} enrollment={e} onChanged={bump} />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "browse" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Browse Courses</h2>
            {canManageCatalog && !showAddCourse && (
              <button onClick={() => setShowAddCourse(true)} className="text-sm font-semibold rounded-lg px-3 py-1.5 bg-accent text-white">
                Add Course
              </button>
            )}
          </div>
          {showAddCourse && (
            <AddCourseForm
              onCancel={() => setShowAddCourse(false)}
              onCreated={() => {
                setShowAddCourse(false);
                bump();
              }}
            />
          )}
          {courses.length === 0 ? (
            <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No courses available yet.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {courses.map((c) => (
                <CourseCard
                  key={c.id}
                  course={c}
                  enrollment={enrollmentByCourseId.get(c.id)}
                  canEnroll={canEnroll}
                  canManageCatalog={canManageCatalog}
                  onChanged={bump}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "progress" && (
        <div>
          <h2 className="text-lg font-semibold mb-4">My Progress</h2>
          {enrollments.length === 0 ? (
            <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No learning history yet.</div>
          ) : (
            <div className="space-y-3">
              {enrollments.map((e) => (
                <EnrollmentRow key={e.id} enrollment={e} onChanged={bump} />
              ))}
            </div>
          )}
          {completed.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">Certificates</h3>
              <div className="space-y-1.5">
                {completed.map((e) => (
                  <div key={e.id} className="flex items-center justify-between text-sm bg-card rounded-card p-3 shadow-sm">
                    <span>{e.course.title}</span>
                    <span className="text-xs text-label-tertiary tabular-nums">{e.completedAt?.slice(0, 10)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
