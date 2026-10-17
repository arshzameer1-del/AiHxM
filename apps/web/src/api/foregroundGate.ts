/**
 * Lets the background warm-up step aside for the screen the person is looking at (LIVE-02).
 *
 * The app loads many screens' data in the background after sign-in and every minute. Those reads share the same slow
 * server as the page the person just opened, so a page's own calls used to queue behind them. Calls made for the page in
 * front of the person are counted here; the background lanes wait until none are in flight (for at most `maxWaitMs`, so
 * warming is delayed, never starved).
 */
export function createForegroundGate(opts: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const pollMs = opts.pollMs ?? 80;
  const maxWaitMs = opts.maxWaitMs ?? 6000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let inFlight = 0;
  return {
    /** Counts one call made for the page itself. */
    async track<T>(fn: () => Promise<T>): Promise<T> {
      inFlight++;
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    },
    /** Resolves when no page call is in flight, or after `maxWaitMs`. */
    async idle(): Promise<void> {
      let waited = 0;
      while (inFlight > 0 && waited < maxWaitMs) {
        await sleep(pollMs);
        waited += pollMs;
      }
    },
    pending: () => inFlight,
  };
}
