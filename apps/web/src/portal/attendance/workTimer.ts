import type { TimesheetEntryInput, TimesheetEntryView } from "@aihxm/shared-types";

/**
 * The work timer: press Start on the timesheet, work, press Stop, and the minutes land on today in the timesheet (the One exD
 * "Start" button and the running time in the top bar). The running timer is kept in this browser, so it survives a reload.
 */
export type WorkTimer = { employeeId: string; startedAt: string; label: string };

export const TIMER_KEY = "aihxm.workTimer";
export const TIMER_EVENT = "aihxm:work-timer";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The timer running for this person, or null. A timer from someone else's login on the same browser is ignored. */
export function readTimer(employeeId: string, store: Store | null = browserStore()): WorkTimer | null {
  try {
    const raw = store?.getItem(TIMER_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Partial<WorkTimer>;
    if (t.employeeId !== employeeId || typeof t.startedAt !== "string" || Number.isNaN(new Date(t.startedAt).getTime())) return null;
    return { employeeId: t.employeeId, startedAt: t.startedAt, label: typeof t.label === "string" ? t.label : "" };
  } catch {
    return null;
  }
}

function announce(): void {
  try {
    window.dispatchEvent(new Event(TIMER_EVENT));
  } catch {
    // no window (tests)
  }
}

export function startTimer(employeeId: string, label: string, now: Date = new Date(), store: Store | null = browserStore()): WorkTimer {
  const timer: WorkTimer = { employeeId, startedAt: now.toISOString(), label: label.trim().slice(0, 120) };
  try {
    store?.setItem(TIMER_KEY, JSON.stringify(timer));
  } catch {
    // storage full or blocked: the timer then lives only until the page closes
  }
  announce();
  return timer;
}

export function clearTimer(store: Store | null = browserStore()): void {
  try {
    store?.removeItem(TIMER_KEY);
  } catch {
    // nothing to clear
  }
  announce();
}

export function elapsedSeconds(timer: WorkTimer, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(timer.startedAt).getTime()) / 1000));
}

/** "0:05:09" for the clock face. */
export function timerText(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Whole minutes to put on the timesheet: nothing for a slip under half a minute, never less than one minute otherwise. */
export function minutesToLog(seconds: number): number {
  return seconds < 30 ? 0 : Math.max(1, Math.round(seconds / 60));
}

/**
 * The sheet's entries with `minutes` added to `workDate` on the line for this task (the timer's label is the task). An existing entry for
 * that day and task is topped up, otherwise a new one is added; every other entry stays exactly as it is.
 */
export function mergeIntoDay(entries: TimesheetEntryView[], workDate: string, minutes: number, label: string): TimesheetEntryInput[] {
  const task = label.trim() || null;
  const out: TimesheetEntryInput[] = entries.map((e) => ({
    workDate: e.workDate.slice(0, 10),
    minutes: e.minutes,
    costCenterId: e.costCenterId,
    taskRef: e.taskRef,
    description: e.description,
  }));
  const target = out.find((o) => o.workDate === workDate && (o.taskRef?.trim() || null) === task);
  if (target) target.minutes += minutes;
  else out.push({ workDate, minutes, taskRef: task });
  return out;
}
