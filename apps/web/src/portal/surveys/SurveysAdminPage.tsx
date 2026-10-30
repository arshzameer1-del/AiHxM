import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AnnouncementAudienceType,
  LocationView,
  OrgUnitView,
  SurveyAdminView,
  SurveyQuestionInput,
  SurveyQuestionKind,
  SurveyResultsView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

const KIND_LABEL: Record<SurveyQuestionKind, string> = {
  rating: "Agree scale (1 to 5)",
  nps: "Recommend score (0 to 10, gives eNPS)",
  yes_no: "Yes or no",
  text: "Written comment",
};
const STATUS_STYLE = { draft: "bg-black/5 text-label-secondary", open: "bg-green-100 text-green-800", closed: "bg-amber-100 text-amber-800" } as const;

/** A starting point HR can edit freely. Nothing is added until the button is pressed. */
const ENGAGEMENT_TEMPLATE: SurveyQuestionInput[] = [
  { kind: "nps", prompt: "How likely are you to recommend this company as a place to work?" },
  { kind: "rating", prompt: "My manager supports me in doing my job well." },
  { kind: "rating", prompt: "I know what is expected of me at work." },
  { kind: "rating", prompt: "I have the tools and information I need." },
  { kind: "text", prompt: "What is one thing we should change?", required: false },
];

type Form = { title: string; description: string; audienceType: AnnouncementAudienceType; audienceIds: string[]; closesOn: string; questions: SurveyQuestionInput[] };
const empty: Form = { title: "", description: "", audienceType: "all", audienceIds: [], closesOn: "", questions: [{ kind: "rating", prompt: "", required: true }] };

/** HR: build a survey, open it, close it, and read the anonymous totals. */
export function SurveysAdminPage() {
  const [items, setItems] = useState<SurveyAdminView[] | null>(null);
  const [units, setUnits] = useState<OrgUnitView[]>([]);
  const [places, setPlaces] = useState<LocationView[]>([]);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SurveyResultsView | null>(null);

  const load = useCallback(() => {
    api.listSurveysAdmin().then(setItems).catch((err) => { setItems([]); setError(err instanceof ApiError ? err.message : "Could not load the surveys."); });
  }, []);
  useEffect(() => {
    load();
    api.listOrgUnits().then(setUnits).catch(() => setUnits([]));
    api.listLocations().then(setPlaces).catch(() => setPlaces([]));
  }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setQuestion = (i: number, patch: Partial<SurveyQuestionInput>) => setForm((f) => ({ ...f, questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  const move = (i: number, d: -1 | 1) =>
    setForm((f) => {
      const qs = [...f.questions];
      const j = i + d;
      if (j < 0 || j >= qs.length) return f;
      [qs[i], qs[j]] = [qs[j], qs[i]];
      return { ...f, questions: qs };
    });
  const startNew = () => { setEditing({ id: null }); setForm(empty); setError(null); setNotice(null); setResults(null); };
  const startEdit = (s: SurveyAdminView) => {
    setEditing({ id: s.id });
    setForm({
      title: s.title, description: s.description ?? "", audienceType: s.audienceType, audienceIds: s.audienceIds, closesOn: s.closesOn ?? "",
      questions: s.questions.map((q) => ({ kind: q.kind, prompt: q.prompt, required: q.required })),
    });
    setError(null);
    setNotice(null);
    setResults(null);
  };

  async function save(e: FormEvent, open: boolean) {
    e.preventDefault();
    if (!form.title.trim()) return setError("Give the survey a title.");
    if (form.questions.some((q) => !q.prompt.trim())) return setError("Every question needs some text. Remove the empty ones.");
    setBusy(true);
    setError(null);
    const payload = { ...form, description: form.description.trim() || null, closesOn: form.closesOn || null, open };
    try {
      const saved = editing?.id ? await api.updateSurvey(editing.id, payload) : await api.createSurvey(payload);
      setEditing(null);
      setNotice(open ? `Survey opened for ${saved.audienceCount} people.` : "Saved as a draft. Nobody has been told yet.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the survey.");
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await fn();
      setNotice(done);
      setResults(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not do that.");
    }
  }

  async function showResults(id: string) {
    if (results?.surveyId === id) return setResults(null);
    try {
      setResults(await api.surveyResults(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the results.");
    }
  }

  const choices = form.audienceType === "org_unit" ? units.filter((u) => u.status === "active") : places.filter((l) => l.status === "active");

  return (
    <div data-testid="surveys-admin">
      <PageHeader
        title="Surveys"
        subtitle="Ask people short questions. Answers are anonymous, and totals appear only after at least five people have answered."
        actions={!editing ? <button className={btn} onClick={startNew}>New survey</button> : undefined}
      />
      {notice && <div className="text-sm text-accent mb-3" role="status">{notice}</div>}
      {error && <div className="text-sm text-danger mb-3" role="alert">{error}</div>}

      {editing && (
        <form onSubmit={(e) => save(e, false)} className="bg-card rounded-card p-5 shadow-sm mb-5 space-y-3" aria-label="Survey">
          <h2 className="font-semibold text-sm">{editing.id ? "Edit draft" : "New survey"}</h2>
          <div>
            <label htmlFor="sv-title" className={label}>Title</label>
            <input id="sv-title" className={field} maxLength={200} value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div>
            <label htmlFor="sv-desc" className={label}>Introduction (optional)</label>
            <textarea id="sv-desc" className={field} rows={2} maxLength={2000} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="sv-audience" className={label}>Who should answer?</label>
              <select id="sv-audience" className={field} value={form.audienceType} onChange={(e) => setForm((f) => ({ ...f, audienceType: e.target.value as AnnouncementAudienceType, audienceIds: [] }))}>
                <option value="all">Everyone</option>
                <option value="org_unit">Chosen departments</option>
                <option value="location">Chosen locations</option>
              </select>
            </div>
            <div>
              <label htmlFor="sv-closes" className={label}>Closes on (optional)</label>
              <input id="sv-closes" type="date" className={field} value={form.closesOn} onChange={(e) => set("closesOn", e.target.value)} />
            </div>
          </div>
          {form.audienceType !== "all" && (
            <fieldset className="border border-black/10 rounded-lg p-3">
              <legend className="text-xs font-medium text-label-secondary px-1">{form.audienceType === "org_unit" ? "Departments" : "Locations"}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {choices.length === 0 && <span className="text-xs text-label-tertiary">None set up yet.</span>}
                {choices.map((c) => (
                  <label key={c.id} className="text-sm flex items-center gap-1.5">
                    <input type="checkbox" checked={form.audienceIds.includes(c.id)} onChange={(e) => set("audienceIds", e.target.checked ? [...form.audienceIds, c.id] : form.audienceIds.filter((x) => x !== c.id))} />
                    {c.name}
                  </label>
                ))}
              </div>
              <p className="text-xs text-label-tertiary mt-2">Small groups give weak anonymity. Results stay hidden under five answers either way.</p>
            </fieldset>
          )}

          <div className="space-y-2" aria-label="Questions">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-label-secondary">Questions</span>
              <button type="button" className={quiet} onClick={() => set("questions", ENGAGEMENT_TEMPLATE)}>Start from an engagement template</button>
            </div>
            {form.questions.map((q, i) => (
              <div key={i} className="grid sm:grid-cols-[1fr_14rem_auto] gap-2 items-start" data-testid="survey-question-row">
                <input aria-label={`Question ${i + 1}`} className={field} maxLength={500} placeholder={`Question ${i + 1}`} value={q.prompt} onChange={(e) => setQuestion(i, { prompt: e.target.value })} />
                <select aria-label={`Type of question ${i + 1}`} className={field} value={q.kind} onChange={(e) => setQuestion(i, { kind: e.target.value as SurveyQuestionKind })}>
                  {(Object.keys(KIND_LABEL) as SurveyQuestionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <div className="flex items-center gap-2 text-sm">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={q.required !== false} onChange={(e) => setQuestion(i, { required: e.target.checked })} /> Required</label>
                  <button type="button" className={quiet} aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
                  <button type="button" className={quiet} aria-label={`Move question ${i + 1} down`} disabled={i === form.questions.length - 1} onClick={() => move(i, 1)}>Down</button>
                  <button type="button" className={quiet} aria-label={`Remove question ${i + 1}`} disabled={form.questions.length === 1} onClick={() => set("questions", form.questions.filter((_, j) => j !== i))}>Remove</button>
                </div>
              </div>
            ))}
            <button type="button" className={quiet} disabled={form.questions.length >= 30} onClick={() => set("questions", [...form.questions, { kind: "rating", prompt: "", required: true }])}>Add a question</button>
          </div>

          <p className="text-xs text-label-tertiary">Questions cannot be changed once the survey is open. Nothing is sent to anyone until you press Open now.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={busy} onClick={(e) => save(e as unknown as FormEvent, true)}>{busy ? "Working…" : "Open now"}</button>
            <button type="submit" className={quiet} disabled={busy}>Save as draft</button>
            <button type="button" className={quiet} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      {items === null ? (
        <LoadingNote what="surveys" />
      ) : items.length === 0 ? (
        <p className="text-sm text-label-tertiary" data-testid="no-surveys-admin">No surveys yet.</p>
      ) : (
        <div className="space-y-3">
          {items.map((s) => (
            <div key={s.id} className="bg-card rounded-card p-4 shadow-sm" data-testid="survey-admin-card">
              <div className="text-sm font-semibold flex flex-wrap items-center gap-2">
                {s.title}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_STYLE[s.status]}`}>{s.status === "draft" ? "Draft" : s.status === "open" ? "Open" : "Closed"}</span>
              </div>
              <div className="text-xs text-label-tertiary mt-0.5">
                {s.questions.length} questions · to {s.audienceType === "all" ? "everyone" : s.audienceNames.join(", ")} ({s.audienceCount} people)
                {s.closesOn ? ` · closes ${formatDay(s.closesOn)}` : ""}
              </div>
              {s.status !== "draft" && <div className="text-xs text-label-secondary mt-1">Answered by {s.responseCount} of {s.audienceCount}</div>}
              <div className="flex flex-wrap gap-2 mt-3">
                {s.status === "draft" && <button className={btn} onClick={() => act(() => api.openSurvey(s.id), "Survey opened. People were told in their bell.")}>Open</button>}
                {s.status === "draft" && <button className={quiet} onClick={() => startEdit(s)}>Edit</button>}
                {s.status === "draft" && <button className={quiet} onClick={() => act(() => api.deleteSurvey(s.id), "Draft deleted.")}>Delete</button>}
                {s.status === "open" && <button className={quiet} onClick={() => act(() => api.closeSurvey(s.id), "Survey closed.")}>Close</button>}
                {s.status !== "draft" && <button className={quiet} onClick={() => showResults(s.id)}>{results?.surveyId === s.id ? "Hide results" : "Results"}</button>}
              </div>
              {results?.surveyId === s.id && <Results r={results} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Bar({ label: text, n, total }: { label: string; n: number; total: number }) {
  const pct = total ? Math.round((n / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-6 text-right tabular-nums">{text}</span>
      <div className="flex-1 h-2 rounded bg-black/5"><div className="h-2 rounded bg-accent" style={{ width: `${pct}%` }} /></div>
      <span className="w-14 tabular-nums text-label-secondary">{n} ({pct}%)</span>
    </div>
  );
}

function Results({ r }: { r: SurveyResultsView }) {
  if (!r.visible) {
    return <p className="mt-3 text-sm text-label-secondary border-t border-black/5 pt-3" data-testid="results-hidden">{r.message}</p>;
  }
  return (
    <div className="mt-3 border-t border-black/5 pt-3 space-y-4" data-testid="survey-results">
      <p className="text-xs text-label-tertiary">{r.responseCount} of {r.audienceCount} people answered.</p>
      {r.questions.map((q) => (
        <div key={q.questionId} className="space-y-1.5">
          <div className="text-sm font-medium">{q.position}. {q.prompt} <span className="text-xs text-label-tertiary font-normal">({q.answered} answered)</span></div>
          {q.answered < r.minResponses ? (
            <p className="text-xs text-label-tertiary">Fewer than {r.minResponses} people answered this question, so it is not shown.</p>
          ) : q.kind === "text" ? (
            <ul className="text-sm list-disc pl-5 space-y-1" data-testid="survey-comments">{q.texts?.map((t, i) => <li key={i} className="whitespace-pre-wrap">{t}</li>)}</ul>
          ) : q.kind === "yes_no" ? (
            <div className="space-y-1"><Bar label="Yes" n={q.yes ?? 0} total={q.answered} /><Bar label="No" n={q.no ?? 0} total={q.answered} /></div>
          ) : (
            <div className="space-y-1">
              {q.kind === "nps" && <div className="text-sm" data-testid="enps">eNPS <strong>{q.enps}</strong> · {q.promoters} promoters, {q.passives} passives, {q.detractors} detractors</div>}
              <div className="text-xs text-label-secondary">Average {q.average}</div>
              {q.distribution?.map((n, i) => <Bar key={i} label={String(q.kind === "rating" ? i + 1 : i)} n={n} total={q.answered} />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
