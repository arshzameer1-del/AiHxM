import { useEffect, useState } from "react";
import type { HolidayView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { formatDay, todayIso } from "../shared/dates";

/**
 * Holiday Management — `holiday.view.all` is granted broadly to every
 * real role (0031_holiday_management_seed.sql's own comment on why:
 * non-sensitive, company-wide data, unlike shift assignments or leave
 * requests), so this card renders for anyone with a session, not gated
 * on any role check the way MyLeaveCard/PendingCorrectionsSection are.
 * Filters client-side to today-or-later since the endpoint itself has no
 * "upcoming" concept, only an optional ?year= — fine at the scale a
 * single company's calendar actually reaches.
 */
export function UpcomingHolidaysCard() {
  const [holidays, setHolidays] = useState<HolidayView[] | null>(null);

  useEffect(() => {
    api
      .listHolidays()
      .then(setHolidays)
      .catch(() => setHolidays([]));
  }, []);

  if (holidays === null) return null;
  const today = todayIso();
  const upcoming = holidays.filter((h) => h.holidayDate >= today).slice(0, 5);
  if (upcoming.length === 0) return null;

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Upcoming Holidays</h2>
      <div className="space-y-1.5">
        {upcoming.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-label-secondary">
              {h.name}
              {h.isOptional && <span className="text-xs text-label-tertiary"> (optional)</span>}
            </span>
            <span className="font-mono text-xs text-label-tertiary shrink-0">{formatDay(h.holidayDate)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
