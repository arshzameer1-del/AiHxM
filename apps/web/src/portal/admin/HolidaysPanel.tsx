import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type { HolidayCalendarView, HolidayView, LocationView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatDay, todayIso } from "../shared/dates";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type HolidayFormValue = {
  name: string;
  holidayDate: string;
  isOptional: boolean;
  isGazetted: boolean;
  dateBasis: "fixed" | "lunar";
  calendarId: string;
};

function emptyForm(initial?: HolidayView, calendarId?: string): HolidayFormValue {
  return {
    name: initial?.name ?? "",
    holidayDate: initial?.holidayDate ?? todayIso(),
    isOptional: initial?.isOptional ?? false,
    isGazetted: initial?.isGazetted ?? false,
    dateBasis: initial?.dateBasis ?? "fixed",
    calendarId: initial ? (initial.calendarId ?? "") : (calendarId ?? ""),
  };
}

function HolidayForm({
  initial,
  calendars,
  defaultCalendarId,
  onCancel,
  onSaved,
}: {
  initial?: HolidayView;
  calendars: HolidayCalendarView[];
  defaultCalendarId?: string;
  onCancel: () => void;
  onSaved: (holiday: HolidayView) => void;
}) {
  const [value, setValue] = useState<HolidayFormValue>(() => emptyForm(initial, defaultCalendarId));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: value.name,
        holidayDate: value.holidayDate,
        isOptional: value.isOptional,
        isGazetted: value.isGazetted,
        dateBasis: value.dateBasis,
        calendarId: value.calendarId || null,
      };
      const saved = initial ? await api.updateHoliday(initial.id, payload) : await api.createHoliday(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this holiday.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="hol-name" className="block text-sm font-medium mb-1">Name</label>
          <input
            id="hol-name"
            required
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            placeholder="e.g. Independence Day"
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label htmlFor="hol-date" className="block text-sm font-medium mb-1">Date</label>
          <input
            id="hol-date"
            type="date"
            required
            value={value.holidayDate}
            onChange={(e) => setValue((v) => ({ ...v, holidayDate: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label htmlFor="hol-cal" className="block text-sm font-medium mb-1">Calendar</label>
          <select
            id="hol-cal"
            value={value.calendarId}
            onChange={(e) => setValue((v) => ({ ...v, calendarId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
          >
            <option value="">Company-wide (everyone)</option>
            {calendars.filter((c) => c.status === "active").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="hol-basis" className="block text-sm font-medium mb-1">Date is set by</label>
          <select
            id="hol-basis"
            value={value.dateBasis}
            onChange={(e) => setValue((v) => ({ ...v, dateBasis: e.target.value as "fixed" | "lunar" }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
          >
            <option value="fixed">The calendar (same date every year)</option>
            <option value="lunar">The moon (moves each year — Eid, Muharram…)</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.isOptional}
            onChange={(e) => setValue((v) => ({ ...v, isOptional: e.target.checked }))}
            className="rounded border-black/20"
          />
          Optional (employees may choose whether to take it)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.isGazetted}
            onChange={(e) => setValue((v) => ({ ...v, isGazetted: e.target.checked }))}
            className="rounded border-black/20"
          />
          Gazetted (notified by the government)
        </label>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Add holiday"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function HolidayRow({
  holiday,
  calendars,
  onChanged,
}: {
  holiday: HolidayView;
  calendars: HolidayCalendarView[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const calendarName = holiday.calendarId ? calendars.find((c) => c.id === holiday.calendarId)?.name : null;

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      await api.deleteHoliday(holiday.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this holiday.");
      setDeleting(false);
    }
  }

  if (editing) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm">
        <HolidayForm
          initial={holiday}
          calendars={calendars}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      </div>
    );
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 flex-wrap min-w-0">
        <div className="font-mono text-sm text-label-tertiary w-28 shrink-0">{formatDay(holiday.holidayDate)}</div>
        <div className="font-semibold text-sm">{holiday.name}</div>
        {calendarName && <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent">{calendarName}</span>}
        {holiday.isGazetted && <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary">Gazetted</span>}
        {holiday.isOptional && (
          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary">
            Optional
          </span>
        )}
        {holiday.isTentative && (
          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warning/10 text-warning">
            Date to be confirmed
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {error && <span className="text-xs text-danger">{error}</span>}
        <button onClick={() => setEditing(true)} className="text-xs font-semibold text-accent hover:underline">
          {holiday.isTentative ? "Confirm date" : "Edit"}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
        >
          {deleting ? "Removing…" : "Remove"}
        </button>
      </div>
    </div>
  );
}

function CalendarForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [locations, setLocations] = useState<LocationView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createHolidayCalendar({ name, locationIds: selected });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the calendar.");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div>
        <label htmlFor="cal-name" className="block text-sm font-medium mb-1">Calendar name</label>
        <input
          id="cal-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sindh provincial"
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <div className="text-sm font-medium mb-1">Applies to</div>
        {locations.length === 0 ? (
          <p className="text-xs text-label-tertiary">No locations are set up, so this calendar will apply to everyone.</p>
        ) : (
          <>
            <p className="text-xs text-label-tertiary mb-2">Choose the locations it covers (their sub-locations too). Leave all unticked for everyone.</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {locations.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(l.id)}
                    onChange={(e) => setSelected((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))}
                  />
                  {l.name}
                </label>
              ))}
            </div>
          </>
        )}
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">Create calendar</button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">Cancel</button>
      </div>
    </form>
  );
}

/**
 * Holiday calendars (TLM-10). Company-wide holidays apply to everyone; a named calendar (for
 * example "Sindh provincial") adds holidays for the locations it covers. Moon-dependent holidays
 * are marked as such, so rolling a year forward copies them as "date to be confirmed" and HR moves
 * each to the announced date.
 */
export function HolidaysPanel() {
  const thisYear = new Date().getFullYear();
  const [holidays, setHolidays] = useState<HolidayView[] | null>(null);
  const [calendars, setCalendars] = useState<HolidayCalendarView[]>([]);
  const [filter, setFilter] = useState<string>(""); // "" = all, "company" = company-wide, else a calendar id
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingCalendar, setCreatingCalendar] = useState(false);
  const [rollNote, setRollNote] = useState<string | null>(null);

  function load() {
    api.listHolidays(undefined, filter || undefined).then(setHolidays).catch((err) => setError(describeError(err)));
    api.listHolidayCalendars(true).then(setCalendars).catch(() => undefined);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [filter]);

  async function rollForward() {
    setRollNote(null);
    try {
      const r = await api.rollHolidaysForward({ fromYear: thisYear, toYear: thisYear + 1, calendarId: filter && filter !== "company" ? filter : null });
      setRollNote(
        `${r.created} holiday${r.created === 1 ? "" : "s"} copied to ${thisYear + 1}` +
          (r.tentative ? ` — ${r.tentative} moon-dependent date${r.tentative === 1 ? "" : "s"} to confirm` : "") +
          (r.skipped ? `, ${r.skipped} already there` : "") +
          "."
      );
      load();
    } catch (err) {
      setRollNote(err instanceof ApiError ? err.message : "Could not copy the holidays.");
    }
  }

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!holidays) return <LoadingNote />;

  const activeCalendars = calendars.filter((c) => c.status === "active");

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-sm text-label-tertiary max-w-2xl">
          Company-wide holidays apply to everyone. A calendar adds holidays for the locations it covers.
        </p>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => setCreatingCalendar((v) => !v)} className="text-sm font-semibold text-accent hover:underline">
            {creatingCalendar ? "Close" : "New calendar"}
          </button>
          {!creating && (
            <button onClick={() => setCreating(true)} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">
              Add Holiday
            </button>
          )}
        </div>
      </div>

      {creatingCalendar && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <CalendarForm onCancel={() => setCreatingCalendar(false)} onSaved={() => { setCreatingCalendar(false); load(); }} />
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label htmlFor="hol-filter" className="text-sm text-label-secondary">Show</label>
          <select id="hol-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border border-black/10 px-2 py-1.5 text-sm">
            <option value="">All holidays</option>
            <option value="company">Company-wide only</option>
            {activeCalendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <button onClick={rollForward} className="text-sm font-semibold text-accent hover:underline">
          Copy {thisYear} holidays to {thisYear + 1}
        </button>
      </div>
      {rollNote && <p className="text-sm text-label-secondary">{rollNote}</p>}

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <HolidayForm
            calendars={calendars}
            defaultCalendarId={filter && filter !== "company" ? filter : undefined}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {holidays.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No holidays entered yet. Add the company's public holidays so everyone can see them here.
        </div>
      )}

      {holidays.map((holiday) => (
        <HolidayRow key={holiday.id} holiday={holiday} calendars={calendars} onChanged={load} />
      ))}
    </div>
  );
}
