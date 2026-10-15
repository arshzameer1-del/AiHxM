import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ApplicationView, CandidateView, EmployeeView, InterviewRecommendation, InterviewType, InterviewView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ReasonModal } from "../../components/ReasonModal";
import { describeError, fmtDateTime, inputCls, label, linkBtn, localToIso, primaryBtn } from "./recruitUi";

const TYPES: InterviewType[] = ["phone", "video", "onsite", "technical", "hr", "panel", "other"];
const RECOMMENDATIONS: InterviewRecommendation[] = ["strong_yes", "yes", "no", "strong_no"];

const STATUS_STYLES: Record<InterviewView["status"], string> = {
  scheduled: "bg-accent/10 text-accent-dark",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-black/5 text-label-tertiary",
  no_show: "bg-danger/15 text-red-700",
};

/** TAL-02: schedule interviews (with a clash check for the interviewers), record feedback and see the recommendation per round. */
export function InterviewsPanel() {
  const [interviews, setInterviews] = useState<InterviewView[] | null>(null);
  const [applications, setApplications] = useState<ApplicationView[]>([]);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<InterviewView | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<InterviewView | null>(null);
  const [form, setForm] = useState({ applicationId: "", interviewType: "video" as InterviewType, start: "", end: "", locationText: "", meetingLink: "", interviewers: [] as string[], notes: "" });
  const [fb, setFb] = useState({ overallRating: "3", recommendation: "yes" as InterviewRecommendation, strengths: "", concerns: "" });

  const load = useCallback(async () => {
    try {
      setInterviews(await api.listInterviews());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    api.listApplications().then(setApplications).catch(() => undefined);
    api.listCandidates().then(setCandidates).catch(() => undefined);
    api.listEmployees().then(setEmployees).catch(() => undefined);
  }, [load]);

  const appName = useMemo(() => {
    const byCand = new Map(candidates.map((c) => [c.id, c]));
    const byApp = new Map(applications.map((a) => [a.id, a]));
    return (applicationId: string) => {
      const c = byCand.get(byApp.get(applicationId)?.candidateId ?? "");
      return c ? `${c.firstName} ${c.lastName}` : "Candidate";
    };
  }, [applications, candidates]);
  const empName = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : "Interviewer";
  };

  const openApplications = applications.filter((a) => a.stage !== "rejected" && a.stage !== "hired");

  async function schedule(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.scheduleInterview({
        applicationId: form.applicationId,
        interviewType: form.interviewType,
        scheduledStart: localToIso(form.start),
        scheduledEnd: localToIso(form.end),
        locationText: form.locationText || undefined,
        meetingLink: form.meetingLink || undefined,
        interviewerEmployeeIds: form.interviewers,
        notes: form.notes || undefined,
      });
      setScheduling(false);
      setForm({ ...form, start: "", end: "", notes: "", interviewers: [] });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(i: InterviewView, status: InterviewView["status"], cancelReason?: string) {
    try {
      await api.updateInterview(i.id, { status, cancelReason });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function sendFeedback(e: FormEvent) {
    e.preventDefault();
    if (!feedbackFor) return;
    setBusy(true);
    try {
      await api.submitInterviewFeedback(feedbackFor.id, {
        overallRating: Number(fb.overallRating),
        recommendation: fb.recommendation,
        strengths: fb.strengths || undefined,
        concerns: fb.concerns || undefined,
      });
      setFeedbackFor(null);
      setFb({ overallRating: "3", recommendation: "yes", strengths: "", concerns: "" });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!interviews) return error ? <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div> : <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}
      {!scheduling ? (
        <button onClick={() => setScheduling(true)} className={primaryBtn}>Schedule interview</button>
      ) : (
        <form onSubmit={schedule} className="bg-card rounded-card shadow-sm p-5 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="iv-app">Application</label>
              <select id="iv-app" required className={inputCls} value={form.applicationId} onChange={(e) => setForm({ ...form, applicationId: e.target.value })}>
                <option value="">Choose…</option>
                {openApplications.map((a) => <option key={a.id} value={a.id}>{appName(a.id)} · {label(a.stage)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="iv-type">Type</label>
              <select id="iv-type" className={inputCls} value={form.interviewType} onChange={(e) => setForm({ ...form, interviewType: e.target.value as InterviewType })}>
                {TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="iv-start">Starts</label>
              <input id="iv-start" required type="datetime-local" className={inputCls} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="iv-end">Ends</label>
              <input id="iv-end" required type="datetime-local" className={inputCls} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="iv-loc">Location</label>
              <input id="iv-loc" className={inputCls} value={form.locationText} onChange={(e) => setForm({ ...form, locationText: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="iv-link">Meeting link</label>
              <input id="iv-link" type="url" placeholder="https://" className={inputCls} value={form.meetingLink} onChange={(e) => setForm({ ...form, meetingLink: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="iv-who">Interviewers (hold Ctrl or Cmd to pick several)</label>
            <select id="iv-who" required multiple className={`${inputCls} h-32`} value={form.interviewers} onChange={(e) => setForm({ ...form, interviewers: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
              {employees.map((x) => <option key={x.id} value={x.id}>{x.firstName} {x.lastName} ({x.employeeNumber})</option>)}
            </select>
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={busy || form.interviewers.length === 0} className={primaryBtn}>Schedule</button>
            <button type="button" onClick={() => setScheduling(false)} className="text-sm font-medium text-label-secondary">Cancel</button>
          </div>
        </form>
      )}

      {interviews.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No interviews scheduled yet.</div>
      ) : (
        <div className="space-y-3">
          {interviews.map((i) => (
            <div key={i.id} className="bg-card rounded-card shadow-sm p-4 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold text-sm">{appName(i.applicationId)} · round {i.roundNo} · {label(i.interviewType)}</div>
                  <div className="text-xs text-label-tertiary">
                    {fmtDateTime(i.scheduledStart)} – {fmtDateTime(i.scheduledEnd)}
                    {i.locationText ? ` · ${i.locationText}` : ""}
                  </div>
                  <div className="text-xs text-label-tertiary">With {i.interviewerEmployeeIds.map(empName).join(", ")}</div>
                  {i.meetingLink && <a className="text-xs text-accent underline" href={i.meetingLink} target="_blank" rel="noreferrer noopener">Meeting link</a>}
                  {i.cancelReason && <div className="text-xs text-label-tertiary">Reason: {i.cancelReason}</div>}
                </div>
                <span className={`px-2 py-1 text-xs font-semibold rounded ${STATUS_STYLES[i.status]}`}>{label(i.status)}</span>
              </div>
              {i.feedback.length > 0 && (
                <ul className="text-sm border-t border-black/5 pt-2 space-y-1">
                  {i.feedback.map((f) => (
                    <li key={f.id}>
                      <strong>{empName(f.employeeId)}</strong>: {f.overallRating}/5, {label(f.recommendation)}
                      {f.strengths ? ` · strengths: ${f.strengths}` : ""}
                      {f.concerns ? ` · concerns: ${f.concerns}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {i.status === "scheduled" && (
                <div className="flex gap-4">
                  <button className={linkBtn} onClick={() => setStatus(i, "completed")}>Mark completed</button>
                  <button className={linkBtn} onClick={() => setStatus(i, "no_show")}>No-show</button>
                  <button className="text-danger text-xs font-medium hover:underline" onClick={() => setCancelling(i)}>Cancel</button>
                </div>
              )}
              {(i.status === "scheduled" || i.status === "completed") && (
                <button className={linkBtn} onClick={() => setFeedbackFor(i)}>Add feedback</button>
              )}
            </div>
          ))}
        </div>
      )}

      {feedbackFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={() => setFeedbackFor(null)}>
          <form onSubmit={sendFeedback} onClick={(e) => e.stopPropagation()} className="bg-card rounded-card p-6 shadow-lg max-w-md w-full space-y-3">
            <h2 className="font-bold text-lg">Feedback: {appName(feedbackFor.applicationId)}, round {feedbackFor.roundNo}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="fb-r">Overall</label>
                <select id="fb-r" className={inputCls} value={fb.overallRating} onChange={(e) => setFb({ ...fb, overallRating: e.target.value })}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} / 5</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="fb-rec">Recommendation</label>
                <select id="fb-rec" className={inputCls} value={fb.recommendation} onChange={(e) => setFb({ ...fb, recommendation: e.target.value as InterviewRecommendation })}>
                  {RECOMMENDATIONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="fb-s">Strengths</label>
              <textarea id="fb-s" rows={2} className={inputCls} value={fb.strengths} onChange={(e) => setFb({ ...fb, strengths: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="fb-c">Concerns</label>
              <textarea id="fb-c" rows={2} className={inputCls} value={fb.concerns} onChange={(e) => setFb({ ...fb, concerns: e.target.value })} />
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={busy} className={primaryBtn}>Submit feedback</button>
              <button type="button" onClick={() => setFeedbackFor(null)} className="text-sm font-medium text-label-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {cancelling && (
        <ReasonModal
          title="Cancel this interview"
          confirmLabel="Cancel interview"
          danger
          onCancel={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.updateInterview(cancelling.id, { status: "cancelled", cancelReason: reason });
            setCancelling(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
