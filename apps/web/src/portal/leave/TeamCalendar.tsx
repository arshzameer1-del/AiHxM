import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { TeamLeaveEntryView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { covers, dayKind, eachDate, formatDisplayDate, monthWindow, shiftWindow, weekWindow, weekdayLabels } from "./leaveCalendar";
import { todayIso } from "../shared/dates";

/**
 * The "Team" panel on a request's detail view: which colleagues (people under the same manager) are off,
 * for one week or one month. The server only returns dates and a pending/approved status, never the leave
 * type or the reason, and only people who actually have leave in the window, so a colleague who is not off
 * simply has no row.
 */
export function TeamCalendar({
  employeeId,
  holidays,
  weekend,
  initialDate,
}: {
  employeeId: string;
  holidays: ReadonlyMap<string, string>;
  weekend: readonly number[];
  /** The window opens on the week/month that holds this date (the request's own start date). */
  initialDate: string;
}) {
  const [mode, setMode] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(initialDate);
  const [entries, setEntries] = useState<TeamLeaveEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const range = mode === "week" ? weekWindow(anchor, 1) : monthWindow(anchor);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    api
      .getTeamLeaveCalendar(range.from, range.to, employeeId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load the team calendar.");
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, employeeId]);

  const days = useMemo(() => eachDate(range.from, range.to), [range.from, range.to]);

  const people = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; number: string; entries: TeamLeaveEntryView[] }>();
    for (const e of entries ?? []) {
      const person = byId.get(e.employeeId) ?? { id: e.employeeId, name: e.employeeName, number: e.employeeNumber, entries: [] };
      person.entries.push(e);
      byId.set(e.employeeId, person);
    }
    const needle = search.trim().toLowerCase();
    return [...byId.values()]
      .filter((p) => needle === "" || `${p.name} ${p.number}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries, search]);

  const label = mode === "week" ? `${formatDisplayDate(range.from)} – ${formatDisplayDate(range.to)}` : monthLabel(range.from);
  const compact = mode === "month";

  return (
    <section aria-labelledby="team-calendar-heading" data-testid="team-calendar">
      <h3 id="team-calendar-heading" className="text-sm font-semibold mb-2">
        Team
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-label-tertiary" aria-hidden />
          <input
            aria-label="Search colleagues"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7 pr-2 py-1 text-xs rounded-lg border border-black/10 w-40 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div role="radiogroup" aria-label="Calendar range" className="inline-flex rounded-lg border border-black/10 overflow-hidden text-xs">
          {(
            [
              ["week", "1 Week"],
              ["month", "1 Month"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={`px-2.5 py-1 font-medium ${mode === value ? "bg-accent text-white" : "bg-surface text-label-secondary"}`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2 text-xs">
        <button type="button" aria-label="Previous" onClick={() => setAnchor(shiftWindow(anchor, mode, -1))} className="p-1 text-accent">
          <ChevronLeft size={16} />
        </button>
        <button type="button" onClick={() => setAnchor(todayIso())} className="font-semibold text-accent">
          Today
        </button>
        <button type="button" aria-label="Next" onClick={() => setAnchor(shiftWindow(anchor, mode, 1))} className="p-1 text-accent">
          <ChevronRight size={16} />
        </button>
        <span className="font-semibold text-accent tabular-nums">{label}</span>
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      <div className="overflow-x-auto">
        <div className="min-w-[420px]">
          <div className="grid" style={{ gridTemplateColumns: `140px repeat(${days.length}, minmax(${compact ? 14 : 36}px, 1fr))` }}>
            <div />
            {days.map((d, i) => (
              <div key={d} className="text-center text-[11px] text-label-tertiary pb-1">
                {!compact && <div>{weekdayLabels(1)[i % 7]}</div>}
                <div className="tabular-nums">{Number(d.slice(8))}</div>
              </div>
            ))}
            {entries === null && !error && <div className="col-span-full text-xs text-label-tertiary py-3">Loading…</div>}
            {entries !== null && people.length === 0 && (
              <div className="col-span-full text-xs text-label-tertiary py-3">No colleague is off in this period.</div>
            )}
            {people.map((p) => (
              <PersonRow key={p.id} person={p} days={days} holidays={holidays} weekend={weekend} />
            ))}
          </div>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-label-secondary" aria-label="Team calendar legend">
        <li className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-green-300" aria-hidden /> Approved
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-amber-300" aria-hidden /> Pending
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-black/10" aria-hidden /> Non-working day
        </li>
      </ul>
    </section>
  );
}

function PersonRow({
  person,
  days,
  holidays,
  weekend,
}: {
  person: { id: string; name: string; number: string; entries: TeamLeaveEntryView[] };
  days: string[];
  holidays: ReadonlyMap<string, string>;
  weekend: readonly number[];
}) {
  return (
    <>
      <div className="py-1.5 pr-2 text-xs border-t border-black/5 flex items-center gap-1.5 min-w-0" title={`${person.name} (${person.number})`}>
        <EmployeeAvatar employeeId={person.id} name={person.name} size="xs" />
        <span className="truncate">{person.name}</span>
      </div>
      {days.map((d) => {
        const hit = person.entries.find((e) => covers(e.startDate, e.endDate, d));
        const off = dayKind(d, holidays, weekend) !== "working";
        const half = hit && hit.dayPart !== "full";
        let tone = off ? "bg-black/[0.06]" : "";
        if (hit) tone = hit.status === "approved" ? "bg-green-300" : "bg-amber-300";
        const title = hit ? `${person.name}: ${formatDisplayDate(hit.startDate)}${hit.startDate === hit.endDate ? "" : ` – ${formatDisplayDate(hit.endDate)}`}, ${hit.status === "approved" ? "Approved" : "Pending"}${half ? " (half day)" : ""}` : undefined;
        return (
          <div key={d} className="border-t border-black/5 py-1" title={title}>
            <div className={`h-5 mx-px rounded-sm ${tone} ${half ? "opacity-60" : ""}`} aria-label={title} />
          </div>
        );
      })}
    </>
  );
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}
