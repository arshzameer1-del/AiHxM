/**
 * "Today" as a yyyy-mm-dd date in the business time zone, not in UTC. Pakistan is UTC+5, so between 00:00 and 05:00 local
 * time `new Date().toISOString().slice(0, 10)` still answers with yesterday. The default is Asia/Karachi (override with
 * DEFAULT_TIMEZONE); callers that know the company's own zone pass it in.
 */
export const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "Asia/Karachi";

export function localToday(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
