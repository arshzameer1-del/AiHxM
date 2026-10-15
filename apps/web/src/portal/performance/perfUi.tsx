import type { ReactNode } from "react";
import type { GoalStatus } from "@aihxm/shared-types";

export const inputCls =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
export const primaryBtn = "bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50";
export const linkBtn = "text-accent hover:underline text-xs font-medium";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="block font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-label-tertiary mt-1">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">
      {message}
    </div>
  );
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Not started",
  in_progress: "In progress",
  at_risk: "At risk",
  overdue: "Overdue",
  completed: "Completed",
  cancelled: "Cancelled",
};

const GOAL_STATUS_STYLES: Record<GoalStatus, string> = {
  active: "bg-black/5 text-label-primary",
  in_progress: "bg-accent/10 text-accent-dark",
  at_risk: "bg-amber-100 text-amber-800",
  overdue: "bg-danger/15 text-red-700",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-black/5 text-label-tertiary",
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return <span className={`inline-block px-2 py-1 text-xs font-semibold rounded ${GOAL_STATUS_STYLES[status]}`}>{GOAL_STATUS_LABELS[status]}</span>;
}

export function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2 min-w-[7rem]">
      <div className="h-2 flex-1 rounded-full bg-black/10 overflow-hidden" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent" style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs tabular-nums text-label-secondary w-10 text-right">{Math.round(clamped)}%</span>
    </div>
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
