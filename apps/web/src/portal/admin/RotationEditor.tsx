import { FormEvent, useEffect, useState } from "react";
import type { ShiftRotationView, ShiftView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { todayIso } from "../shared/dates";

/**
 * The cycle of a rotating schedule: week 1 is one shift, week 2 another, then it repeats. Employees are assigned the rotating schedule
 * itself (Assign an employee to a shift), and attendance uses whichever member shift the cycle puts on each date.
 */
export function RotationEditor({ shift, allShifts }: { shift: ShiftView; allShifts: ShiftView[] }) {
  const members = allShifts.filter((s) => s.id !== shift.id && s.scheduleType !== "rotating");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<ShiftRotationView | null>(null);
  const [cycleWeeks, setCycleWeeks] = useState(2);
  const [anchorDate, setAnchorDate] = useState(() => todayIso());
  const [weeks, setWeeks] = useState<string[]>(["", ""]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const idp = `rot-${shift.id}`;

  useEffect(() => {
    api.getShiftRotation(shift.id).then((r) => {
      if (r) {
        setSaved(r);
        setCycleWeeks(r.cycleWeeks);
        setAnchorDate(r.anchorDate);
        setWeeks(r.weeks.map((w) => w.memberShiftId));
      }
      setLoaded(true);
    }).catch((err) => { setError(err instanceof ApiError ? err.message : "Could not load the rotation."); setLoaded(true); });
  }, [shift.id]);

  function changeCycle(n: number) {
    setCycleWeeks(n);
    setWeeks((w) => Array.from({ length: n }, (_, i) => w[i] ?? ""));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    try {
      const view = await api.saveShiftRotation(shift.id, { cycleWeeks, anchorDate, weeks: weeks.map((memberShiftId, i) => ({ weekNo: i + 1, memberShiftId })) });
      setSaved(view);
      setNote("Rotation saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the rotation.");
    }
  }

  async function remove() {
    setError(null);
    try {
      await api.removeShiftRotation(shift.id);
      setSaved(null);
      setNote("Rotation removed.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the rotation.");
    }
  }

  if (!loaded) return <LoadingNote />;
  return (
    <form onSubmit={save} className="mt-4 border-t border-black/5 pt-4 space-y-3" aria-label={`Rotation for ${shift.name}`}>
      <h4 className="text-sm font-semibold">Rotation</h4>
      {members.length === 0 && <p className="text-xs text-label-tertiary">Create the ordinary shifts to rotate between first (for example Morning and Evening).</p>}
      {error && <div role="alert" className="text-danger text-sm">{error}</div>}
      {note && <div className="text-success text-sm">{note}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-n`}>Repeats every (weeks)</label>
          <select id={`${idp}-n`} value={cycleWeeks} onChange={(e) => changeCycle(Number(e.target.value))} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
            {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-a`}>Week 1 starts on</label>
          <input id={`${idp}-a`} type="date" required value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {weeks.map((w, i) => (
          <div key={i}>
            <label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-w${i + 1}`}>Week {i + 1}</label>
            <select id={`${idp}-w${i + 1}`} required value={w} onChange={(e) => setWeeks((x) => x.map((v, j) => (j === i ? e.target.value : v)))} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
              <option value="" disabled>Choose a shift…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={members.length === 0} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">Save rotation</button>
        {saved && <button type="button" onClick={remove} className="px-4 py-2 text-sm font-medium rounded-lg border border-black/10">Remove rotation</button>}
      </div>
    </form>
  );
}
