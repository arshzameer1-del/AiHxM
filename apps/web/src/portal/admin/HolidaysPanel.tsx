import { FormEvent, useEffect, useState } from "react";
import type { HolidayView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

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
};

function emptyForm(initial?: HolidayView): HolidayFormValue {
  return {
    name: initial?.name ?? "",
    holidayDate: initial?.holidayDate ?? new Date().toISOString().slice(0, 10),
    isOptional: initial?.isOptional ?? false,
  };
}

function HolidayForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: HolidayView;
  onCancel: () => void;
  onSaved: (holiday: HolidayView) => void;
}) {
  const [value, setValue] = useState<HolidayFormValue>(() => emptyForm(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = { name: value.name, holidayDate: value.holidayDate, isOptional: value.isOptional };
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
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            required
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            placeholder="e.g. Independence Day"
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Date</label>
          <input
            type="date"
            required
            value={value.holidayDate}
            onChange={(e) => setValue((v) => ({ ...v, holidayDate: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.isOptional}
          onChange={(e) => setValue((v) => ({ ...v, isOptional: e.target.checked }))}
          className="rounded border-black/20"
        />
        Optional (employees may choose whether to take it)
      </label>

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

function HolidayRow({ holiday, onChanged }: { holiday: HolidayView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="bg-card rounded-card p-4 shadow-sm flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="font-mono text-sm text-label-tertiary w-28 shrink-0">{holiday.holidayDate}</div>
        <div className="font-semibold text-sm">{holiday.name}</div>
        {holiday.isOptional && (
          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary">
            Optional
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {error && <span className="text-xs text-danger">{error}</span>}
        <button onClick={() => setEditing(true)} className="text-xs font-semibold text-accent hover:underline">
          Edit
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

/**
 * Core HR gap #3 from claude/aihxm-master-audit-and-roadmap.md's Part 3 —
 * the calendar foundation Attendance Corrections' own scope note deferred
 * ("absence reporting needs a working-days/holiday calendar first"). This
 * panel is deliberately CRUD-only, no assignment sub-form (unlike
 * ShiftsPanel): a holiday isn't assigned per-employee, it's one shared
 * company calendar everyone reads.
 */
export function HolidaysPanel() {
  const [holidays, setHolidays] = useState<HolidayView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listHolidays().then(setHolidays).catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!holidays) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          The company holiday calendar — visible to every employee, managed here by HR.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            Add Holiday
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <HolidayForm
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
        <HolidayRow key={holiday.id} holiday={holiday} onChanged={load} />
      ))}
    </div>
  );
}
