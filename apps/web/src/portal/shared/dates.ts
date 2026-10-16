const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A calendar day coming from the API ("2026-09-01" or "2026-09-01T00:00:00.000Z") shown as "1 Sep 2026".
 * Only the date part is read, so the viewer's time zone can never move the day.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "1 Sep 2026 – 30 Sep 2026" from two API days. */
export function formatPeriod(start: string, end: string): string {
  return `${formatDay(start)} – ${formatDay(end)}`;
}
