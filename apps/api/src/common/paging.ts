import type { Response } from "express";

/** The most rows any list answers in one go. Far above a Pakistan SMB's real size; it exists so one call can never return an unbounded table. */
export const MAX_PAGE_SIZE = 5000;

/**
 * Optional `?limit=&offset=` for list endpoints that used to return everything. Nobody who sends neither parameter sees a change
 * (up to MAX_PAGE_SIZE rows); `X-Total-Count` always carries the full size so a caller can tell a page from the whole.
 */
export function pageOf<T>(items: T[], limit: string | undefined, offset: string | undefined, res: Response): T[] {
  const parsedLimit = Number.parseInt(limit ?? "", 10);
  const parsedOffset = Number.parseInt(offset ?? "", 10);
  const take = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
  const skip = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  res.setHeader("X-Total-Count", String(items.length));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
  return items.slice(skip, skip + take);
}
