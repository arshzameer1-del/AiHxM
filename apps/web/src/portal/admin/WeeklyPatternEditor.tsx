import { useEffect, useState } from "react";
import type { SetWeeklyPatternRequest, WorkScheduleDayView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type BreakDraft = { startTime: string; endTime: string; isPaid: boolean };

type DayDraft = {
  dayOfWeek: number;
  isWorking: boolean;
  startTime: string;
  endTime: string;
  breaks: BreakDraft[];
};

function toDrafts(days: WorkScheduleDayView[]): DayDraft[] {
  return [...days]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => ({
      dayOfWeek: d.dayOfWeek,
      isWorking: d.isWorking,
      startTime: d.startTime?.slice(0, 5) ?? "09:00",
      endTime: d.endTime?.slice(0, 5) ?? "17:00",
      breaks: d.breaks.map((b) => ({ startTime: b.startTime.slice(0, 5), endTime: b.endTime.slice(0, 5), isPaid: b.isPaid })),
    }));
}

function toRequest(drafts: DayDraft[]): SetWeeklyPatternRequest {
  return {
    days: drafts.map((d) => ({
      dayOfWeek: d.dayOfWeek,
      isWorking: d.isWorking,
      startTime: d.isWorking ? d.startTime : undefined,
      endTime: d.isWorking ? d.endTime : undefined,
      breaks: d.isWorking ? d.breaks : [],
    })),
  };
}

/**
 * Section 7/8's weekly working pattern editor (WS-022, "Work Schedule
 * Builder") — the one piece of the Work Schedule Architecture's first
 * increment (shipped 2026-09-18) that had a real, tested, live-verified
 * API (`GET/PUT /shifts/:id/weekly-pattern`) but no screen. Replace-all-7-
 * days in one PUT, matching `ShiftsService.setWeeklyPattern`'s own "Copy
 * Week" bulk-edit shape rather than exposing granular per-day endpoints
 * this form would have to fake anyway.
 */
export function WeeklyPatternEditor({ shiftId }: { shiftId: string }) {
  const [drafts, setDrafts] = useState<DayDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getWeeklyPattern(shiftId)
      .then((days) => setDrafts(toDrafts(days)))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the weekly pattern."));
  }, [shiftId]);

  function updateDay(dayOfWeek: number, patch: Partial<DayDraft>) {
    setSaved(false);
    setDrafts((ds) => ds && ds.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)));
  }

  function addBreak(dayOfWeek: number) {
    setSaved(false);
    setDrafts(
      (ds) =>
        ds &&
        ds.map((d) =>
          d.dayOfWeek === dayOfWeek ? { ...d, breaks: [...d.breaks, { startTime: "13:00", endTime: "14:00", isPaid: false }] } : d
        )
    );
  }

  function updateBreak(dayOfWeek: number, index: number, patch: Partial<BreakDraft>) {
    setSaved(false);
    setDrafts(
      (ds) =>
        ds &&
        ds.map((d) =>
          d.dayOfWeek === dayOfWeek ? { ...d, breaks: d.breaks.map((b, i) => (i === index ? { ...b, ...patch } : b)) } : d
        )
    );
  }

  function removeBreak(dayOfWeek: number, index: number) {
    setSaved(false);
    setDrafts(
      (ds) => ds && ds.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, breaks: d.breaks.filter((_, i) => i !== index) } : d))
    );
  }

  async function handleSave() {
    if (!drafts) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await api.setWeeklyPattern(shiftId, toRequest(drafts));
      setDrafts(toDrafts(updated));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the weekly pattern.");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="text-danger text-sm mt-2">{error}</div>;
  if (!drafts) return <div className="text-label-tertiary text-sm mt-2">Loading weekly pattern…</div>;

  return (
    <div className="mt-3 pt-3 border-t border-black/5 space-y-2">
      {drafts.map((day) => (
        <div key={day.dayOfWeek} className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 w-32 shrink-0">
            <input
              type="checkbox"
              checked={day.isWorking}
              onChange={(e) => updateDay(day.dayOfWeek, { isWorking: e.target.checked })}
              className="rounded border-black/20"
            />
            {DAY_NAMES[day.dayOfWeek]}
          </label>

          {day.isWorking ? (
            <>
              <input
                type="time"
                value={day.startTime}
                onChange={(e) => updateDay(day.dayOfWeek, { startTime: e.target.value })}
                className="rounded-lg border border-black/10 px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <span className="text-label-tertiary">–</span>
              <input
                type="time"
                value={day.endTime}
                onChange={(e) => updateDay(day.dayOfWeek, { endTime: e.target.value })}
                className="rounded-lg border border-black/10 px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              />

              {day.breaks.map((b, i) => (
                <span key={i} className="flex items-center gap-1 bg-black/5 rounded-lg px-2 py-1">
                  <input
                    type="time"
                    value={b.startTime}
                    onChange={(e) => updateBreak(day.dayOfWeek, i, { startTime: e.target.value })}
                    className="w-20 bg-transparent text-xs font-mono focus:outline-none"
                  />
                  <span className="text-label-tertiary text-xs">–</span>
                  <input
                    type="time"
                    value={b.endTime}
                    onChange={(e) => updateBreak(day.dayOfWeek, i, { endTime: e.target.value })}
                    className="w-20 bg-transparent text-xs font-mono focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeBreak(day.dayOfWeek, i)}
                    aria-label="Remove break"
                    className="text-label-tertiary hover:text-danger text-xs px-0.5"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => addBreak(day.dayOfWeek)}
                className="text-xs font-semibold text-accent hover:underline"
              >
                + Break
              </button>
            </>
          ) : (
            <span className="text-label-tertiary text-xs">Off</span>
          )}
        </div>
      ))}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save weekly pattern"}
        </button>
        {saved && <span className="text-success text-xs">Saved.</span>}
      </div>
    </div>
  );
}
