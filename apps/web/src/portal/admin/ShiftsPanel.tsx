import { FormEvent, useEffect, useState } from "react";
import type { EmployeeView, ShiftView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { WeeklyPatternEditor } from "./WeeklyPatternEditor";
import { WorkScheduleAssignmentRulesPanel } from "./WorkScheduleAssignmentRulesPanel";
import { SchedulePreview } from "./SchedulePreview";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type ShiftFormValue = {
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  graceMinutesLate: string;
  graceMinutesEarly: string;
  isDefault: boolean;
};

function emptyForm(initial?: ShiftView): ShiftFormValue {
  return {
    name: initial?.name ?? "",
    startTime: initial?.startTime?.slice(0, 5) ?? "09:00",
    endTime: initial?.endTime?.slice(0, 5) ?? "17:00",
    crossesMidnight: initial?.crossesMidnight ?? false,
    graceMinutesLate: String(initial?.graceMinutesLate ?? 0),
    graceMinutesEarly: String(initial?.graceMinutesEarly ?? 0),
    isDefault: initial?.isDefault ?? false,
  };
}

function ShiftForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: ShiftView;
  onCancel: () => void;
  onSaved: (shift: ShiftView) => void;
}) {
  const [value, setValue] = useState<ShiftFormValue>(() => emptyForm(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: value.name,
        startTime: value.startTime,
        endTime: value.endTime,
        crossesMidnight: value.crossesMidnight,
        graceMinutesLate: Number(value.graceMinutesLate) || 0,
        graceMinutesEarly: Number(value.graceMinutesEarly) || 0,
        isDefault: value.isDefault,
      };
      const saved = initial ? await api.updateShift(initial.id, payload) : await api.createShift(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this shift.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <input
          required
          value={value.name}
          onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Start time</label>
          <input
            type="time"
            required
            value={value.startTime}
            onChange={(e) => setValue((v) => ({ ...v, startTime: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">End time</label>
          <input
            type="time"
            required
            value={value.endTime}
            onChange={(e) => setValue((v) => ({ ...v, endTime: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Grace period, late (minutes)</label>
          <input
            type="number"
            min={0}
            value={value.graceMinutesLate}
            onChange={(e) => setValue((v) => ({ ...v, graceMinutesLate: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Grace period, early departure (minutes)</label>
          <input
            type="number"
            min={0}
            value={value.graceMinutesEarly}
            onChange={(e) => setValue((v) => ({ ...v, graceMinutesEarly: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.crossesMidnight}
          onChange={(e) => setValue((v) => ({ ...v, crossesMidnight: e.target.checked }))}
          className="rounded border-black/20"
        />
        This shift crosses midnight (e.g. a night shift)
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.isDefault}
          onChange={(e) => setValue((v) => ({ ...v, isDefault: e.target.checked }))}
          className="rounded border-black/20"
        />
        Make this the company default (applies to any employee with no explicit assignment)
      </label>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create shift"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ShiftRow({ shift, onChanged }: { shift: ShiftView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [showPattern, setShowPattern] = useState(false);

  if (editing) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm">
        <ShiftForm
          initial={shift}
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
    <div className="bg-card rounded-card p-5 shadow-sm">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{shift.name}</h3>
          {shift.isDefault && (
            <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent">
              Company default
            </span>
          )}
          {shift.crossesMidnight && (
            <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary">
              Crosses midnight
            </span>
          )}
        </div>
        <div className="flex gap-3 shrink-0">
          <button onClick={() => setShowPattern((s) => !s)} className="text-xs font-semibold text-accent hover:underline">
            {showPattern ? "Hide weekly pattern" : "Weekly pattern"}
          </button>
          <button onClick={() => setEditing(true)} className="text-xs font-semibold text-accent hover:underline">
            Edit
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Hours</div>
          <div className="font-mono">
            {shift.startTime.slice(0, 5)}–{shift.endTime.slice(0, 5)}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Grace, late</div>
          <div className="font-mono">{shift.graceMinutesLate} min</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Grace, early departure</div>
          <div className="font-mono">{shift.graceMinutesEarly} min</div>
        </div>
      </div>
      {showPattern && <WeeklyPatternEditor shiftId={shift.id} />}
    </div>
  );
}

function AssignShiftForm({ shifts, onAssigned }: { shifts: ShiftView[]; onAssigned: () => void }) {
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const assignment = await api.assignShift({ employeeId, shiftId, effectiveFrom });
      setSuccess(`${assignment.employeeName} assigned to ${assignment.shiftName}, effective ${assignment.effectiveFrom}.`);
      onAssigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not assign this shift.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <h3 className="font-semibold">Assign an employee to a shift</h3>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Employee</label>
          <select
            required
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="" disabled>
              Select an employee…
            </option>
            {(employees ?? []).map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Shift</label>
          <select
            required
            value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="" disabled>
              Select a shift…
            </option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Effective from</label>
          <input
            type="date"
            required
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}
      {success && <div className="text-success text-sm">{success}</div>}

      <button
        type="submit"
        disabled={submitting || shifts.length === 0}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? "Assigning…" : "Assign shift"}
      </button>
      {shifts.length === 0 && (
        <p className="text-xs text-label-tertiary">Create at least one shift above before assigning one.</p>
      )}
    </form>
  );
}

/**
 * Core HR gap #1 from claude/aihxm-master-audit-and-roadmap.md's Part 3 —
 * Attendance previously had no concept of a "supposed to start at" time.
 * Shift definitions + a direct per-employee, effective-dated assignment
 * below (same shape as LeavePoliciesPanel's definitions-then-assignment
 * split).
 *
 * Extended 2026-09-18 with the Work Schedule Architecture's own
 * Configuration UI (WS-022–024) — each shift row can expand into its
 * weekly pattern editor, and this panel now also hosts the company-wide
 * Rules-Engine-backed Assignment Rules list and a Schedule Preview tool,
 * closing the "real, tested, live-verified API with no screen" gap that
 * increment's own write-up left open. WS-025 (Conflict Detection across
 * rules) remains deliberately not built — see SchedulePreview's own doc
 * comment for why.
 */
export function ShiftsPanel() {
  const [shifts, setShifts] = useState<ShiftView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listShifts().then(setShifts).catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!shifts) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Define shifts once, then assign employees to them — Attendance uses this to tell on-time from late.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Shift
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <ShiftForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {shifts.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No shifts yet. Create one and mark it as the company default so attendance has something to measure
          against even before you assign anyone explicitly.
        </div>
      )}

      {shifts.map((shift) => (
        <ShiftRow key={shift.id} shift={shift} onChanged={load} />
      ))}

      <AssignShiftForm shifts={shifts} onAssigned={load} />

      <WorkScheduleAssignmentRulesPanel shifts={shifts} />

      <SchedulePreview />
    </div>
  );
}
