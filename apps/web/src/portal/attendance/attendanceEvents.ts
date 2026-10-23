/** Fired after a clock-in or clock-out succeeds, so anything showing today's status (the top-bar pill) can read it again. */
export const ATTENDANCE_CHANGED_EVENT = "aihxm:attendance-changed";

export function announceAttendanceChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ATTENDANCE_CHANGED_EVENT));
}
