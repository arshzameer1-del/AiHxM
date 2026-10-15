import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CandidateView, RecruitmentCalendarEntry, RecruitmentEventType, RecruitmentEventView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { describeError, fmtDateTime, inputCls, label, linkBtn, primaryBtn } from "./recruitUi";

const TYPES: RecruitmentEventType[] = ["career_fair", "campus_drive", "walk_in_drive", "interview_day", "info_session", "job_posting", "other"];

/** TAL-04: career fairs, campus and walk-in drives, with the candidates who attend, plus a calendar of the next 30 days. */
export function EventsPanel() {
  const [events, setEvents] = useState<RecruitmentEventView[] | null>(null);
  const [calendar, setCalendar] = useState<RecruitmentCalendarEntry[]>([]);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", eventType: "career_fair" as RecruitmentEventType, startsAt: "", endsAt: "", locationText: "", capacity: "", notes: "" });
  const [attendee, setAttendee] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setEvents(await api.listRecruitmentEvents());
      const from = new Date();
      const to = new Date(Date.now() + 30 * 86400000);
      setCalendar(await api.getRecruitmentCalendar(from.toISOString(), to.toISOString()));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    api.listCandidates().then(setCandidates).catch(() => undefined);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createRecruitmentEvent({
        title: form.title,
        eventType: form.eventType,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined,
        locationText: form.locationText || undefined,
        capacity: form.capacity ? Number(form.capacity) : undefined,
        notes: form.notes || undefined,
      });
      setCreating(false);
      setForm({ ...form, title: "", startsAt: "", endsAt: "", notes: "" });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function setStatus(ev: RecruitmentEventView, status: "planned" | "completed" | "cancelled") {
    try {
      await api.updateRecruitmentEvent(ev.id, { title: ev.title, eventType: ev.eventType, startsAt: ev.startsAt, endsAt: ev.endsAt ?? undefined, locationText: ev.locationText ?? undefined, capacity: ev.capacity ?? undefined, notes: ev.notes ?? undefined, status });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function addAttendee(ev: RecruitmentEventView) {
    const candidateId = attendee[ev.id];
    if (!candidateId) return;
    try {
      await api.addRecruitmentEventAttendee(ev.id, candidateId);
      setAttendee({ ...attendee, [ev.id]: "" });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (!events) return error ? <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div> : <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-5">
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      <section className="bg-card rounded-card shadow-sm p-5 space-y-2">
        <h3 className="font-semibold">Next 30 days</h3>
        {calendar.length === 0 ? <p className="text-sm text-label-tertiary">No interviews or events in the next 30 days.</p> : (
          <ul className="divide-y divide-black/5 text-sm">
            {calendar.map((c) => (
              <li key={`${c.kind}-${c.id}`} className="py-2 flex gap-3">
                <span className="text-xs text-label-tertiary w-40 shrink-0">{fmtDateTime(c.start)}</span>
                <span><span className="text-xs bg-black/5 rounded px-1.5 py-0.5 mr-2">{label(c.kind)}</span>{c.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!creating ? <button className={primaryBtn} onClick={() => setCreating(true)}>New event</button> : (
        <form onSubmit={create} className="bg-card rounded-card shadow-sm p-5 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium mb-1" htmlFor="ev-title">Title</label><input id="ev-title" required className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="ev-type">Type</label>
              <select id="ev-type" className={inputCls} value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value as RecruitmentEventType })}>
                {TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </div>
            <div><label className="block text-sm font-medium mb-1" htmlFor="ev-start">Starts</label><input id="ev-start" required type="datetime-local" className={inputCls} value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></div>
            <div><label className="block text-sm font-medium mb-1" htmlFor="ev-end">Ends</label><input id="ev-end" type="datetime-local" className={inputCls} value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></div>
            <div><label className="block text-sm font-medium mb-1" htmlFor="ev-loc">Venue</label><input id="ev-loc" className={inputCls} value={form.locationText} onChange={(e) => setForm({ ...form, locationText: e.target.value })} /></div>
            <div><label className="block text-sm font-medium mb-1" htmlFor="ev-cap">Capacity</label><input id="ev-cap" type="number" min={1} className={inputCls} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></div>
          </div>
          <div><label className="block text-sm font-medium mb-1" htmlFor="ev-notes">Notes</label><textarea id="ev-notes" rows={2} className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div className="flex gap-3">
            <button type="submit" className={primaryBtn}>Create event</button>
            <button type="button" onClick={() => setCreating(false)} className="text-sm font-medium text-label-secondary">Cancel</button>
          </div>
        </form>
      )}

      {events.length === 0 ? <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No recruitment events yet.</div> : (
        <div className="space-y-3">
          {events.map((ev) => (
            <div key={ev.id} className="bg-card rounded-card shadow-sm p-4 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold text-sm">{ev.title}</div>
                  <div className="text-xs text-label-tertiary">
                    {label(ev.eventType)} · {fmtDateTime(ev.startsAt)}{ev.locationText ? ` · ${ev.locationText}` : ""} · {ev.attendeeCount}{ev.capacity ? ` of ${ev.capacity}` : ""} registered
                  </div>
                  {ev.notes && <div className="text-xs text-label-secondary">{ev.notes}</div>}
                </div>
                <select aria-label={`Status of ${ev.title}`} className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={ev.status} onChange={(e) => setStatus(ev, e.target.value as "planned" | "completed" | "cancelled")}>
                  <option value="planned">Planned</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select aria-label={`Add attendee to ${ev.title}`} className={`${inputCls} max-w-xs`} value={attendee[ev.id] ?? ""} onChange={(e) => setAttendee({ ...attendee, [ev.id]: e.target.value })}>
                  <option value="">Add a candidate…</option>
                  {candidates.filter((c) => !c.anonymisedAt).map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>)}
                </select>
                <button className={linkBtn} onClick={() => addAttendee(ev)}>Register</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
