import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CompetencyView, EmployeeView, FeedbackRequestView, FeedbackView, FeedbackVisibility } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ErrorNote, Field, errorText, formatDate, inputCls, primaryBtn } from "./perfUi";
import { formatDay, localDayKey } from "../shared/dates";

type Mine = FeedbackRequestView & { subjectName: string };

/** TAL-06: continuous feedback and recognition, feedback about a person, and the multi-rater requests addressed to me. */
export function FeedbackPanel() {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];
  const canSeeOthers = roleKeys.includes("hr_admin") || roleKeys.includes("line_manager");

  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [competencies, setCompetencies] = useState<CompetencyView[]>([]);
  const [subject, setSubject] = useState(identity?.employeeId ?? "");
  const [about, setAbout] = useState<{ items: FeedbackView[]; withheldAnonymousCount: number } | null>(null);
  const [given, setGiven] = useState<FeedbackView[]>([]);
  const [mine, setMine] = useState<Mine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [responding, setResponding] = useState<Mine | null>(null);
  const [form, setForm] = useState({ subjectEmployeeId: "", body: "", feedbackType: "continuous" as "continuous" | "recognition", visibility: "subject" as FeedbackVisibility, competencyId: "", evidenceLabel: "", evidenceUrl: "" });
  const [reply, setReply] = useState({ body: "", ratings: {} as Record<string, string> });

  const nameOf = useCallback((id: string | null | undefined) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : "Someone";
  }, [employees]);

  const reload = useCallback(async () => {
    try {
      const [g, m] = await Promise.all([api.listFeedbackGiven(), api.listMyFeedbackRequests()]);
      setGiven(g);
      setMine(m);
      if (subject) setAbout(await api.listFeedbackAbout(subject));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load feedback"));
    }
  }, [subject]);

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => undefined);
    api.listCompetencies().then(setCompetencies).catch(() => undefined);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function give(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.giveFeedback({
        subjectEmployeeId: form.subjectEmployeeId,
        body: form.body,
        feedbackType: form.feedbackType,
        visibility: form.visibility,
        competencyId: form.competencyId || undefined,
        evidence: form.evidenceUrl ? [{ label: form.evidenceLabel || "Evidence", url: form.evidenceUrl }] : undefined,
      });
      setForm({ ...form, body: "", evidenceLabel: "", evidenceUrl: "" });
      await reload();
    } catch (err) {
      setError(errorText(err, "Could not send the feedback"));
    } finally {
      setBusy(false);
    }
  }

  async function respond(e: FormEvent) {
    e.preventDefault();
    if (!responding) return;
    setBusy(true);
    try {
      await api.respondToFeedbackRequest(responding.id, {
        body: reply.body,
        competencyRatings: Object.entries(reply.ratings).filter(([, v]) => v).map(([competencyId, v]) => ({ competencyId, rating: Number(v) })),
      });
      setResponding(null);
      setReply({ body: "", ratings: {} });
      await reload();
    } catch (err) {
      setError(errorText(err, "Could not submit your feedback"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ErrorNote message={error} />

      <section className="space-y-2">
        <h3 className="font-semibold">Feedback requested from you</h3>
        {mine.length === 0 ? (
          <p className="text-sm text-label-tertiary">Nobody is waiting on you.</p>
        ) : (
          <ul className="bg-card rounded-card shadow-sm divide-y divide-black/5">
            {mine.map((r) => (
              <li key={r.id} className="p-3 flex items-center justify-between gap-3 text-sm">
                <span>
                  About <strong>{r.subjectName}</strong>{r.dueDate ? ` · due ${formatDate(r.dueDate)}` : ""}{r.isAnonymous ? " · your name will not be shown" : ""}
                </span>
                <span className="flex gap-3">
                  <button className="text-accent text-xs font-medium" onClick={() => setResponding(r)}>Respond</button>
                  <button className="text-label-secondary text-xs" onClick={() => api.declineFeedbackRequest(r.id).then(reload).catch((err) => setError(errorText(err, "Could not decline")))}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {responding && (
          <form onSubmit={respond} className="bg-black/5 rounded-lg p-4 space-y-3">
            <h4 className="font-medium text-sm">Feedback about {responding.subjectName}</h4>
            <Field label="Your feedback"><textarea required rows={3} className={inputCls} value={reply.body} onChange={(e) => setReply({ ...reply, body: e.target.value })} /></Field>
            {competencies.length > 0 && (
              <div className="space-y-2">
                <span className="block text-sm font-medium">Rate on competencies (optional)</span>
                {competencies.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>{c.name}</span>
                    <select aria-label={`Rating for ${c.name}`} className="rounded border border-black/20 px-2 py-1" value={reply.ratings[c.id] ?? ""} onChange={(e) => setReply({ ...reply, ratings: { ...reply.ratings, [c.id]: e.target.value } })}>
                      <option value="">—</option>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} / 5</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-3">
              <button type="submit" disabled={busy} className={primaryBtn}>Submit</button>
              <button type="button" onClick={() => setResponding(null)} className="text-sm font-medium text-label-secondary">Cancel</button>
            </div>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Give feedback or recognition</h3>
        <form onSubmit={give} className="bg-black/5 rounded-lg p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="To">
              <select required className={inputCls} value={form.subjectEmployeeId} onChange={(e) => setForm({ ...form, subjectEmployeeId: e.target.value })}>
                <option value="">Choose a colleague…</option>
                {employees.filter((x) => x.id !== identity?.employeeId).map((x) => <option key={x.id} value={x.id}>{x.firstName} {x.lastName} ({x.employeeNumber})</option>)}
              </select>
            </Field>
            <Field label="Type">
              <select className={inputCls} value={form.feedbackType} onChange={(e) => setForm({ ...form, feedbackType: e.target.value as "continuous" | "recognition" })}>
                <option value="continuous">Feedback</option>
                <option value="recognition">Recognition</option>
              </select>
            </Field>
            <Field label="Who can see it">
              <select className={inputCls} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as FeedbackVisibility })}>
                <option value="subject">The employee, their manager and HR</option>
                <option value="manager_only">Their manager and HR only</option>
                <option value="hr_only">HR only</option>
              </select>
            </Field>
          </div>
          <Field label="Message"><textarea required rows={3} className={inputCls} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Competency (optional)">
              <select className={inputCls} value={form.competencyId} onChange={(e) => setForm({ ...form, competencyId: e.target.value })}>
                <option value="">None</option>
                {competencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Evidence label"><input className={inputCls} value={form.evidenceLabel} onChange={(e) => setForm({ ...form, evidenceLabel: e.target.value })} /></Field>
            <Field label="Evidence link"><input type="url" placeholder="https://" className={inputCls} value={form.evidenceUrl} onChange={(e) => setForm({ ...form, evidenceUrl: e.target.value })} /></Field>
          </div>
          <button type="submit" disabled={busy} className={primaryBtn}>Send</button>
        </form>
      </section>

      <section className="space-y-2">
        <div className="flex items-end gap-3 flex-wrap">
          <h3 className="font-semibold">Feedback about</h3>
          {(canSeeOthers || identity?.employeeId) && (
            <select aria-label="Feedback about" className="rounded-lg border border-black/10 px-3 py-1.5 text-sm" value={subject} onChange={(e) => setSubject(e.target.value)}>
              {canSeeOthers ? <option value="">Choose…</option> : null}
              {(canSeeOthers ? employees : employees.filter((x) => x.id === identity?.employeeId)).map((x) => (
                <option key={x.id} value={x.id}>{x.id === identity?.employeeId ? "Me" : `${x.firstName} ${x.lastName} (${x.employeeNumber})`}</option>
              ))}
            </select>
          )}
        </div>
        {about && about.items.length === 0 && <p className="text-sm text-label-tertiary">Nothing to show yet.</p>}
        {about && about.items.length > 0 && (
          <ul className="bg-card rounded-card shadow-sm divide-y divide-black/5">
            {about.items.map((f) => (
              <li key={f.id} className="p-3 text-sm space-y-1">
                <div className="text-xs text-label-tertiary">
                  {f.feedbackType.replace("_", "-")} · {formatDay(localDayKey(f.createdAt))} · {f.authorEmployeeId ? nameOf(f.authorEmployeeId) : "Anonymous"}
                  {f.visibility !== "subject" && ` · ${f.visibility === "hr_only" ? "HR only" : "manager and HR only"}`}
                </div>
                <div>{f.body}</div>
                {f.evidence.map((ev) => <a key={ev.id} href={ev.url} target="_blank" rel="noreferrer noopener" className="text-accent text-xs underline mr-3">{ev.label}</a>)}
              </li>
            ))}
          </ul>
        )}
        {about && about.withheldAnonymousCount > 0 && (
          <p className="text-xs text-label-tertiary">{about.withheldAnonymousCount} anonymous response(s) are hidden until enough people have responded.</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Feedback I have given</h3>
        {given.length === 0 ? <p className="text-sm text-label-tertiary">None yet.</p> : (
          <ul className="bg-card rounded-card shadow-sm divide-y divide-black/5 text-sm">
            {given.map((f) => <li key={f.id} className="p-3"><span className="text-xs text-label-tertiary">To {nameOf(f.subjectEmployeeId)} · {formatDay(localDayKey(f.createdAt))}</span><div>{f.body}</div></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
