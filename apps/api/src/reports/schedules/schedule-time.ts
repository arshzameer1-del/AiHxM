import type { ReportScheduleFrequency } from "@aihxm/shared-types";

export type LocalNow = { date: string; hour: number };
export type ScheduleRule = { frequency: ReportScheduleFrequency; dayOfWeek: number | null; dayOfMonth: number | null; hourLocal: number };

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * The next wall-clock moment a schedule fires, strictly after `now` (both in the company's own time zone, as a calendar date
 * plus hour). Days of the week are 0 = Sunday to 6 = Saturday; days of the month stop at 28 so every month has one.
 * The result is a LOCAL date and hour; the database turns it into an instant with the company's zone, which keeps daylight
 * saving and zone rules out of this file. Pure, so it is unit-tested.
 */
export function nextLocalRun(rule: ScheduleRule, now: LocalNow): { date: string; hour: number } {
  const today = ms(now.date);
  const after = (date: string) => ms(date) > today || now.hour < rule.hourLocal;
  if (rule.frequency === "daily") {
    return { date: now.hour < rule.hourLocal ? now.date : iso(today + DAY), hour: rule.hourLocal };
  }
  if (rule.frequency === "weekly") {
    const want = rule.dayOfWeek ?? 1;
    for (let i = 0; i <= 7; i++) {
      const d = iso(today + i * DAY);
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === want && (i > 0 || now.hour < rule.hourLocal)) return { date: d, hour: rule.hourLocal };
    }
  }
  const dom = rule.dayOfMonth ?? 1;
  const [y, m] = now.date.split("-").map(Number) as [number, number];
  const thisMonth = `${y}-${String(m).padStart(2, "0")}-${String(dom).padStart(2, "0")}`;
  if (after(thisMonth) && ms(thisMonth) >= today && !(thisMonth === now.date && now.hour >= rule.hourLocal)) return { date: thisMonth, hour: rule.hourLocal };
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { date: `${ny}-${String(nm).padStart(2, "0")}-${String(dom).padStart(2, "0")}`, hour: rule.hourLocal };
}

/** A recipient may receive a file generated with the owner's access only if it cannot show them more than they could open. */
export function recipientMayReceive(
  recipient: { id: string; access: { scope: "tenant" | "team" | "scoped"; canExport: boolean } | null },
  ownerId: string
): boolean {
  if (recipient.id === ownerId) return recipient.access !== null && recipient.access.canExport;
  if (!recipient.access || !recipient.access.canExport) return false;
  return recipient.access.scope === "tenant";
}
