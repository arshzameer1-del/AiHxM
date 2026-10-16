/** An open clock-in older than this is almost certainly a forgotten clock-out. */
export const STALE_CLOCK_IN_HOURS = 16;

/** Whole hours a clock-in has been open, or null if it is not stale yet (LIVE-13). */
export function staleClockInHours(clockInAt: string, now: Date = new Date()): number | null {
  const started = new Date(clockInAt).getTime();
  if (Number.isNaN(started)) return null;
  const hours = Math.floor((now.getTime() - started) / 3600000);
  return hours >= STALE_CLOCK_IN_HOURS ? hours : null;
}

export function staleClockInMessage(hours: number): string {
  const days = Math.floor(hours / 24);
  const length = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${hours} hours`;
  return `You have been clocked in for ${length}. If you already left, clock out and ask for a correction so your hours are right.`;
}
