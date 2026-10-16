/**
 * Runs the given steps one after another and returns their results in order.
 *
 * Use this instead of Promise.all when the steps are queries on ONE transaction client: a pg client runs a single
 * query at a time, and calling query() while another is still running is deprecated (it logs a warning today and is
 * removed in pg 9). Promise.all is still right for work that uses its own connection (for example RbacService.can).
 */
export async function sequentially<T extends readonly (() => Promise<unknown>)[]>(
  steps: readonly [...T]
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const step of steps) out.push(await step());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
