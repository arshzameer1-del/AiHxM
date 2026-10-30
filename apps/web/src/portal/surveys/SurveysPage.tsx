import { FormEvent, useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import type { MySurveyView, SurveyQuestionView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";

const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const choice = "px-3 py-1.5 rounded-lg border border-black/10 text-sm font-medium min-w-[2.25rem]";

type Answer = { value?: number | boolean; text?: string };

/** Employees: surveys HR has asked me to answer. Answers are anonymous; this page never sends my name with them. */
export function SurveysPage() {
  const [items, setItems] = useState<MySurveyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listMySurveys().then(setItems).catch((err) => { setItems([]); setError(err instanceof ApiError ? err.message : "Could not load the surveys."); });
  }, []);
  useEffect(load, [load]);

  return (
    <div data-testid="surveys">
      <PageHeader title="Surveys" subtitle="Short surveys from HR. Your answers are anonymous: HR sees totals only, and only once enough people have answered." />
      {notice && <div className="text-sm text-accent mb-3" role="status">{notice}</div>}
      {error && <div className="text-sm text-danger mb-3" role="alert">{error}</div>}
      {items === null ? (
        <LoadingNote what="surveys" />
      ) : items.length === 0 ? (
        <p className="text-sm text-label-tertiary" data-testid="no-surveys">There are no surveys waiting for you.</p>
      ) : (
        <div className="space-y-4">
          {items.map((s) => (
            <SurveyForm key={s.id} survey={s} onDone={() => { setNotice("Thank you. Your answers were sent without your name."); load(); }} onError={setError} />
          ))}
        </div>
      )}
    </div>
  );
}

function SurveyForm({ survey, onDone, onError }: { survey: MySurveyView; onDone: () => void; onError: (m: string | null) => void }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const set = (q: SurveyQuestionView, a: Answer) => setAnswers((x) => ({ ...x, [q.id]: a }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    onError(null);
    const missing = survey.questions.find((q) => q.required && (q.kind === "text" ? !answers[q.id]?.text?.trim() : answers[q.id]?.value === undefined));
    if (missing) return onError(`Please answer: ${missing.prompt}`);
    setBusy(true);
    try {
      await api.respondToSurvey(survey.id, { answers: survey.questions.filter((q) => answers[q.id]).map((q) => ({ questionId: q.id, ...answers[q.id] })) });
      onDone();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not send your answers.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-card rounded-card p-5 shadow-sm space-y-4" aria-label={survey.title} data-testid="survey-form">
      <div>
        <h2 className="font-semibold flex items-center gap-2"><ClipboardCheck size={16} className="text-accent" /> {survey.title}</h2>
        {survey.description && <p className="text-sm text-label-secondary mt-1 whitespace-pre-wrap">{survey.description}</p>}
        <p className="text-xs text-label-tertiary mt-1">Anonymous{survey.closesOn ? ` · open until ${formatDay(survey.closesOn)}` : ""}</p>
      </div>
      {survey.questions.map((q) => {
        const id = `sq-${q.id}`;
        const a = answers[q.id];
        return (
          <fieldset key={q.id} className="space-y-1.5">
            <legend id={id} className="text-sm font-medium">{q.position}. {q.prompt}{q.required ? "" : " (optional)"}</legend>
            {q.kind === "text" ? (
              <textarea aria-labelledby={id} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" rows={3} maxLength={2000} value={a?.text ?? ""} onChange={(e) => set(q, { text: e.target.value })} />
            ) : q.kind === "yes_no" ? (
              <div className="flex gap-2" role="radiogroup" aria-labelledby={id}>
                {[true, false].map((v) => (
                  <button type="button" key={String(v)} role="radio" aria-checked={a?.value === v} className={`${choice} ${a?.value === v ? "bg-accent text-white" : ""}`} onClick={() => set(q, { value: v })}>{v ? "Yes" : "No"}</button>
                ))}
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={id}>
                  {Array.from({ length: q.kind === "rating" ? 5 : 11 }, (_, i) => (q.kind === "rating" ? i + 1 : i)).map((n) => (
                    <button type="button" key={n} role="radio" aria-checked={a?.value === n} aria-label={String(n)} className={`${choice} ${a?.value === n ? "bg-accent text-white" : ""}`} onClick={() => set(q, { value: n })}>{n}</button>
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-label-tertiary mt-1 max-w-sm">
                  <span>{q.kind === "rating" ? "1 = strongly disagree" : "0 = not at all likely"}</span>
                  <span>{q.kind === "rating" ? "5 = strongly agree" : "10 = extremely likely"}</span>
                </div>
              </div>
            )}
          </fieldset>
        );
      })}
      <p className="text-xs text-label-tertiary">Written comments are shown to HR word for word, so leave out names and details that would point to you.</p>
      <button type="submit" className={btn} disabled={busy}>{busy ? "Sending…" : "Send my answers"}</button>
    </form>
  );
}
