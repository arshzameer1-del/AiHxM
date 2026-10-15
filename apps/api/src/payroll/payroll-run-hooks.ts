import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Hooks a payroll run's finalisation and reversal call inside the SAME transaction. Services that must react to a run
 * (scheme ledgers, final settlements; later journals and domain events) register under a unique key; registering the
 * same key again replaces the earlier hook, so a re-created service never runs twice. A hook that throws rolls the
 * finalisation or reversal back.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RunRow = Record<string, any>;
export type PayrollRunHook = {
  onFinalized?(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void>;
  onReversed?(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void>;
};

const hooks = new Map<string, PayrollRunHook>();

export const payrollRunHooks = {
  register(key: string, hook: PayrollRunHook): void {
    hooks.set(key, hook);
  },
  async finalized(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    for (const h of hooks.values()) if (h.onFinalized) await h.onFinalized(client, claims, run);
  },
  async reversed(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    for (const h of hooks.values()) if (h.onReversed) await h.onReversed(client, claims, run);
  },
};
