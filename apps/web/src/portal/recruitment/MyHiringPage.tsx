import { FormEvent, useCallback, useEffect, useState } from "react";
import type { InterviewRecommendation, InterviewView, MyRequisitionView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError, fmtDateTime, inputCls, label, linkBtn, primaryBtn } from "./recruitUi";
import { PIPELINE_STAGES, REQUISITION_STATUS_LABELS, REQUISITION_STATUS_STYLES, STAGE_LABELS } from "./requisitionLabels";

const RECOMMENDATIONS: InterviewRecommendation[] = ["strong_yes", "yes", "no", "strong_no"];

/**
 * "My Hiring" (parked B3): what a hiring manager or interviewer needs without the whole Recruitment module. The
 * requisitions they are the hiring manager of (counts per stage only) and the interviews they are on, with feedback.
 */
export function MyHiringPage() {
  const [reqs, setReqs] = useState<MyRequisitionView[] | null>(null);
  const [interviews, setInterviews] = useState<InterviewView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<InterviewView | null>(null);
  const [fb, setFb] = useState({ overallRating: "3", recommendation: "yes" as InterviewRecommendation, strengths: "", concerns: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, i] = await Promise.all([api.listMyRequisitions(), api.listMyInterviews()]);
      setReqs(r);
      setInterviews(i);
    } catch (err) {
      setError(describeError(err, "Your hiring work could not be loaded."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div data-testid="my-hiring">
      <BackLink to="/app">Back to Home</BackLink>
      <PageHeader title="My Hiring" subtitle="The roles you are hiring for and the interviews you are on." />
      {error && <p role="alert" className="text-sm text-danger mb-3">{error}</p>}
      {!reqs || !interviews ? (
        !error && <LoadingNote what="your hiring work" />
      ) : (
        <div className="space-y-8">
          <section aria-label="Requisitions I am hiring for">
            <h2 className="text-sm font-semibold text-label-secondary mb-2">Roles I am hiring for ({reqs.length})</h2>
            {reqs.length === 0 ? (
              <p className="text-sm text-label-secondary">You are not named as hiring manager on any requisition.</p>
            ) : (
              <div className="space-y-3">
                {reqs.map(({ requisition: r, applicationCounts }) => (
                  <article key={r.id} className="bg-white rounded-md shadow-sm p-4" data-testid="my-requisition">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <h3 className="font-semibold text-sm">{r.title}</h3>
                        <p className="text-xs text-label-tertiary">
                          {[r.department, `${r.filledHeadcount} of ${r.headcount} filled`].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${REQUISITION_STATUS_STYLES[r.status]}`}>{REQUISITION_STATUS_LABELS[r.status]}</span>
                    </div>
                    <ul className="mt-3 flex flex-wrap gap-2" aria-label="Applications by stage">
                      {PIPELINE_STAGES.map((s) => (
                        <li key={s} className="rounded-md bg-black/5 px-2.5 py-1 text-xs tabular-nums">
                          {STAGE_LABELS[s]} <strong>{applicationCounts[s]}</strong>
                        </li>
                      ))}
                      {applicationCounts.rejected > 0 && <li className="rounded-md bg-black/5 px-2.5 py-1 text-xs tabular-nums">Rejected <strong>{applicationCounts.rejected}</strong></li>}
                    </ul>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section aria-label="My interviews">
            <h2 className="text-sm font-semibold text-label-secondary mb-2">My interviews ({interviews.length})</h2>
            {interviews.length === 0 ? (
              <p className="text-sm text-label-secondary">You are not on any interview.</p>
            ) : (
              <ul className="space-y-2">
                {interviews.map((i) => (
                  <li key={i.id} className="bg-white rounded-md shadow-sm p-4 flex items-center justify-between gap-3 flex-wrap" data-testid="my-interview">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {i.candidateName ?? "Candidate"} <span className="font-normal text-label-tertiary">for {i.requisitionTitle ?? "a role"}</span>
                      </p>
                      <p className="text-xs text-label-secondary">
                        Round {i.roundNo} · {label(i.interviewType)} · {fmtDateTime(i.scheduledStart)} · {label(i.status)}
                      </p>
                    </div>
                    {i.status !== "cancelled" && i.feedback.length === 0 && (
                      <button className={linkBtn} onClick={() => setFeedbackFor(i)}>Add feedback</button>
                    )}
                    {i.feedback.length > 0 && <span className="text-xs text-green-700">Feedback sent</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {feedbackFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={() => setFeedbackFor(null)}>
          <form onSubmit={sendFeedback} onClick={(e) => e.stopPropagation()} className="bg-card rounded-card p-6 shadow-lg max-w-md w-full space-y-3">
            <h2 className="font-bold text-lg">Feedback: {feedbackFor.candidateName ?? "Candidate"}, round {feedbackFor.roundNo}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="mh-r">Overall</label>
                <select id="mh-r" className={inputCls} value={fb.overallRating} onChange={(e) => setFb({ ...fb, overallRating: e.target.value })}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} / 5</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="mh-rec">Recommendation</label>
                <select id="mh-rec" className={inputCls} value={fb.recommendation} onChange={(e) => setFb({ ...fb, recommendation: e.target.value as InterviewRecommendation })}>
                  {RECOMMENDATIONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="mh-s">Strengths</label>
              <textarea id="mh-s" rows={2} className={inputCls} value={fb.strengths} onChange={(e) => setFb({ ...fb, strengths: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="mh-c">Concerns</label>
              <textarea id="mh-c" rows={2} className={inputCls} value={fb.concerns} onChange={(e) => setFb({ ...fb, concerns: e.target.value })} />
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={busy} className={primaryBtn}>Submit feedback</button>
              <button type="button" onClick={() => setFeedbackFor(null)} className="text-sm font-medium text-label-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
