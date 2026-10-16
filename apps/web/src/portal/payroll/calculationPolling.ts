import type { PayrollRunView } from "@aihxm/shared-types";

/** A browser or proxy gave up waiting (504, 502, 503, or a dropped connection) while the server may still be working. */
export function isGatewayTimeout(status: number | undefined): boolean {
  return status === 502 || status === 503 || status === 504 || status === 0 || status === undefined;
}

/**
 * Asks for the run until it is no longer "calculating" and has moved off the status it had before the click
 * (LIVE-10: a long Calculate used to show "Request failed (504)" although it finished in the background).
 * Returns the last run seen, or null if it still looked unchanged when the time was up.
 */
export async function waitForRunToSettle(
  getRun: () => Promise<PayrollRunView>,
  startedFrom: PayrollRunView["status"],
  opts: { intervalMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; onTick?: (run: PayrollRunView) => void } = {}
): Promise<PayrollRunView | null> {
  const interval = opts.intervalMs ?? 4000;
  const max = opts.maxMs ?? 180000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  let last: PayrollRunView | null = null;
  let sawCalculating = false;
  while (waited <= max) {
    try {
      const run = await getRun();
      last = run;
      opts.onTick?.(run);
      if (run.status === "calculating") sawCalculating = true;
      else if (run.status !== startedFrom || sawCalculating) return run;
    } catch {
      /* the next tick tries again */
    }
    await sleep(interval);
    waited += interval;
  }
  return last && last.status !== startedFrom && last.status !== "calculating" ? last : null;
}
