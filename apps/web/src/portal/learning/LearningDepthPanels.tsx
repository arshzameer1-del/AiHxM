import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Award, ArrowDown, ArrowUp, ClipboardCheck, Plus, Trash2 } from "lucide-react";
import type {
  CertificateView,
  CourseView,
  EmployeeView,
  ExamForTakerView,
  ExamQuestionInput,
  ExamResultView,
  LearningPathProgressRow,
  LearningPathView,
  MyLearningPathView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
const lbl = "block text-xs font-medium text-label-secondary mb-1";
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-black/5 overflow-hidden">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-label-tertiary">{done}/{total}</span>
    </div>
  );
}

// ---------------------------------------------------------------- taking an exam

/** The employee's exam. The answers are marked on the server; the browser never sees which choice is correct. */
export function ExamTaker({ enrollmentId, onClose, onDone }: { enrollmentId: string; onClose: () => void; onDone: () => void }) {
  const [exam, setExam] = useState<ExamForTakerView | null>(null);
  const [answers, setAnswers] = useState<Array<number | null>>([]);
  const [result, setResult] = useState<ExamResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getExamForTaker(enrollmentId)
      .then((e) => { setExam(e); setAnswers(e.questions.map(() => null)); })
      .catch((e) => setError(errText(e, "Could not open this exam.")));
  }, [enrollmentId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.submitExam(enrollmentId, answers);
      setResult(r);
      onDone();
    } catch (err) {
      setError(errText(err, "Could not submit your answers."));
    } finally {
      setBusy(false);
    }
  }

  if (error && !exam) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm mb-4" role="alert">
        <p className="text-sm text-danger">{error}</p>
        <button onClick={onClose} className="mt-3 text-xs font-medium text-label-secondary">Close</button>
      </div>
    );
  }
  if (!exam) return <LoadingNote />;

  if (result) {
    return (
      <section className="bg-card rounded-card p-5 shadow-sm mb-4" aria-label="Exam result">
        <h3 className="font-semibold">{result.passed ? "You passed" : "Not passed yet"}</h3>
        <p className="text-sm mt-1">
          You got {result.correctCount} of {result.questionCount} right — <span className="font-semibold tabular-nums">{result.scorePct}%</span> (pass mark {result.passMarkPct}%).
        </p>
        {result.passed && result.enrollmentCompleted && <p className="text-sm text-green-700 mt-1">The course is now complete and your certificate is ready.</p>}
        {!result.passed && (
          <p className="text-sm text-label-secondary mt-1">
            {result.attemptsLeft === null ? "You can try again." : result.attemptsLeft > 0 ? `You have ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? "" : "s"} left.` : "You have used all attempts — ask HR to reset them."}
          </p>
        )}
        <button onClick={onClose} className="mt-3 text-xs font-semibold text-accent">Close</button>
      </section>
    );
  }

  const blocked = exam.passed || (exam.attemptsLeft !== null && exam.attemptsLeft <= 0);
  return (
    <form onSubmit={submit} className="bg-card rounded-card p-5 shadow-sm mb-4 space-y-4" aria-label={`Exam: ${exam.title}`}>
      <div>
        <h3 className="font-semibold">{exam.title}</h3>
        <p className="text-xs text-label-tertiary mt-0.5">
          {exam.courseTitle} · pass mark {exam.passMarkPct}% · {exam.attemptsLeft === null ? "unlimited attempts" : `${exam.attemptsLeft} attempt${exam.attemptsLeft === 1 ? "" : "s"} left`}
          {exam.bestScorePct !== null && ` · best score ${exam.bestScorePct}%`}
        </p>
      </div>
      {exam.passed && <p className="text-sm text-green-700">You have already passed this exam.</p>}
      {!exam.passed && blocked && <p className="text-sm text-danger">You have used all attempts. Ask HR to reset them.</p>}
      {!blocked && exam.questions.map((q, qi) => (
        <fieldset key={q.position} className="space-y-1.5">
          <legend className="text-sm font-medium mb-1">{qi + 1}. {q.prompt}</legend>
          {q.options.map((o, oi) => (
            <label key={oi} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`q-${qi}`} checked={answers[qi] === oi} onChange={() => setAnswers((a) => a.map((x, i) => (i === qi ? oi : x)))} />
              {o}
            </label>
          ))}
        </fieldset>
      ))}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-3">
        {!blocked && (
          <button type="submit" disabled={busy || answers.some((a) => a === null)} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
            {busy ? "Submitting…" : "Submit answers"}
          </button>
        )}
        <button type="button" onClick={onClose} className="text-xs font-medium text-label-secondary">Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- certificate

export function CertificateCard({ enrollmentId, onClose }: { enrollmentId: string; onClose: () => void }) {
  const [cert, setCert] = useState<CertificateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getCertificate(enrollmentId).then(setCert).catch((e) => setError(errText(e, "Could not load the certificate.")));
  }, [enrollmentId]);

  if (error) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm mb-4" role="alert">
        <p className="text-sm text-danger">{error}</p>
        <button onClick={onClose} className="mt-3 text-xs font-medium text-label-secondary">Close</button>
      </div>
    );
  }
  if (!cert) return <LoadingNote />;
  return (
    <div className="mb-4">
      <style>{`@media print { body * { visibility: hidden !important; } #certificate-print, #certificate-print * { visibility: visible !important; } #certificate-print { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
      <div id="certificate-print" className="bg-white rounded-card border-4 border-double border-black/20 p-8 text-center shadow-sm">
        <Award className="mx-auto text-accent" size={32} aria-hidden />
        <p className="text-xs uppercase tracking-widest text-label-tertiary mt-3">{cert.companyName}</p>
        <h3 className="text-2xl font-bold mt-1">Certificate of Completion</h3>
        <p className="text-sm text-label-secondary mt-4">This certifies that</p>
        <p className="text-xl font-semibold mt-1">{cert.employeeName}</p>
        <p className="text-xs text-label-tertiary">Employee no. {cert.employeeNumber}</p>
        <p className="text-sm text-label-secondary mt-4">has completed</p>
        <p className="text-lg font-semibold mt-1">{cert.courseTitle}</p>
        <p className="text-sm mt-4">
          on {formatDay(cert.completedOn)}{cert.scorePct !== null && <> with a score of <span className="tabular-nums font-semibold">{cert.scorePct}%</span></>}
        </p>
        <p className="text-xs text-label-tertiary mt-5 tabular-nums">Certificate no. {cert.certificateNo}</p>
      </div>
      <div className="flex gap-4 mt-3">
        <button onClick={() => window.print()} className="text-xs font-semibold text-accent">Print or save as PDF</button>
        <button onClick={onClose} className="text-xs font-medium text-label-secondary">Close</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the employee's learning paths

export function MyLearningPathsPanel({ onChanged }: { onChanged: () => void }) {
  const [paths, setPaths] = useState<MyLearningPathView[] | null>(null);
  const [exam, setExam] = useState<string | null>(null);
  const [cert, setCert] = useState<string | null>(null);
  const load = useCallback(() => {
    api.listMyLearningPaths().then(setPaths).catch(() => setPaths([]));
  }, []);
  useEffect(load, [load]);

  if (!paths) return <LoadingNote />;
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">My Learning Paths</h2>
      {exam && <ExamTaker enrollmentId={exam} onClose={() => setExam(null)} onDone={() => { load(); onChanged(); }} />}
      {cert && <CertificateCard enrollmentId={cert} onClose={() => setCert(null)} />}
      {paths.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No learning path has been assigned to you.</div>
      ) : (
        <div className="space-y-4">
          {paths.map((p) => (
            <section key={p.pathId} className="bg-card rounded-card p-4 shadow-sm" aria-label={p.title}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="font-medium text-sm">{p.title}</h3>
                  {p.description && <p className="text-xs text-label-secondary mt-0.5">{p.description}</p>}
                </div>
                {p.dueDate && <span className="text-xs text-label-tertiary">Due {formatDay(p.dueDate)}</span>}
              </div>
              <div className="mt-2 max-w-sm"><Bar done={p.completedCourses} total={p.totalCourses} /></div>
              <ol className="mt-3 space-y-1.5">
                {p.courses.map((c) => (
                  <li key={c.courseId} className="flex items-center justify-between gap-3 text-sm">
                    <span className={c.status === "completed" ? "text-label-tertiary line-through" : ""}>{c.position}. {c.title}</span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-label-tertiary">
                        {c.status === "completed" ? "Completed" : c.status === "not_enrolled" ? "Not started" : `${c.progressPercent}%`}
                      </span>
                      {c.enrollmentId && c.hasExam && c.status !== "completed" && (
                        <button onClick={() => setExam(c.enrollmentId)} className="text-xs font-semibold text-accent flex items-center gap-1">
                          <ClipboardCheck size={12} /> Take exam
                        </button>
                      )}
                      {c.enrollmentId && c.status === "completed" && (
                        <button onClick={() => setCert(c.enrollmentId)} className="text-xs font-semibold text-accent flex items-center gap-1">
                          <Award size={12} /> Certificate
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- HR: exam editor

const blankQuestion = (): ExamQuestionInput => ({ prompt: "", options: ["", ""], correctIndex: 0 });

export function CourseExamEditor({ course, onClose, onSaved }: { course: CourseView; onClose: () => void; onSaved: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(false);
  const [title, setTitle] = useState(`${course.title} exam`);
  const [passMark, setPassMark] = useState("70");
  const [maxAttempts, setMaxAttempts] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [attemptCount, setAttemptCount] = useState(0);
  const [questions, setQuestions] = useState<ExamQuestionInput[]>([blankQuestion()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getCourseExam(course.id)
      .then((r) => {
        if ("questions" in r) {
          setExists(true);
          setTitle(r.title);
          setPassMark(String(r.passMarkPct));
          setMaxAttempts(r.maxAttempts === null ? "" : String(r.maxAttempts));
          setIsActive(r.isActive);
          setAttemptCount(r.attemptCount);
          setQuestions(r.questions);
        }
        setLoaded(true);
      })
      .catch((e) => { setError(errText(e, "Could not load the exam.")); setLoaded(true); });
  }, [course.id]);

  const setQ = (i: number, patch: Partial<ExamQuestionInput>) => setQuestions((qs) => qs.map((q, x) => (x === i ? { ...q, ...patch } : q)));
  const setOpt = (qi: number, oi: number, v: string) => setQ(qi, { options: questions[qi]!.options.map((o, x) => (x === oi ? v : o)) });

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.saveCourseExam(course.id, {
        title: title.trim(),
        passMarkPct: Number(passMark),
        maxAttempts: maxAttempts.trim() === "" ? null : Number(maxAttempts),
        isActive,
        questions: questions.map((q) => ({ prompt: q.prompt.trim(), options: q.options.map((o) => o.trim()), correctIndex: q.correctIndex })),
      });
      onSaved();
    } catch (err) {
      setError(errText(err, "Could not save the exam."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await api.removeCourseExam(course.id);
      onSaved();
    } catch (err) {
      setError(errText(err, "Could not remove the exam."));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <LoadingNote />;
  return (
    <form onSubmit={save} className="bg-black/5 rounded-lg p-4 mb-4 space-y-3" aria-label={`Exam for ${course.title}`}>
      <h3 className="font-semibold text-sm">Exam for {course.title}</h3>
      <p className="text-xs text-label-secondary">
        With an active exam, a course is completed by passing it — the progress bar can no longer finish it.
        {attemptCount > 0 && ` ${attemptCount} attempt${attemptCount === 1 ? "" : "s"} recorded so far.`}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-1">
          <label htmlFor="exam-title" className={lbl}>Exam title</label>
          <input id="exam-title" required value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="exam-pass" className={lbl}>Pass mark (%)</label>
          <input id="exam-pass" type="number" min="1" max="100" required value={passMark} onChange={(e) => setPassMark(e.target.value)} className={`${field} tabular-nums`} />
        </div>
        <div>
          <label htmlFor="exam-attempts" className={lbl}>Attempts allowed (empty = unlimited)</label>
          <input id="exam-attempts" type="number" min="1" max="20" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} className={`${field} tabular-nums`} />
        </div>
      </div>
      <label htmlFor="exam-active" className="flex items-center gap-2 text-sm">
        <input id="exam-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Exam is active
      </label>

      {questions.map((q, qi) => (
        <fieldset key={qi} className="bg-card rounded-lg p-3 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <label htmlFor={`q-prompt-${qi}`} className={lbl}>Question {qi + 1}</label>
              <input id={`q-prompt-${qi}`} required value={q.prompt} onChange={(e) => setQ(qi, { prompt: e.target.value })} className={field} />
            </div>
            {questions.length > 1 && (
              <button type="button" aria-label={`Remove question ${qi + 1}`} onClick={() => setQuestions((qs) => qs.filter((_, x) => x !== qi))} className="mt-6 text-label-tertiary hover:text-danger">
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {q.options.map((o, oi) => (
            <div key={oi} className="flex items-center gap-2">
              <input type="radio" name={`correct-${qi}`} aria-label={`Choice ${oi + 1} of question ${qi + 1} is correct`} checked={q.correctIndex === oi} onChange={() => setQ(qi, { correctIndex: oi })} />
              <input aria-label={`Question ${qi + 1} choice ${oi + 1}`} required value={o} onChange={(e) => setOpt(qi, oi, e.target.value)} className={field} />
              {q.options.length > 2 && (
                <button
                  type="button"
                  aria-label={`Remove choice ${oi + 1}`}
                  onClick={() => setQ(qi, { options: q.options.filter((_, x) => x !== oi), correctIndex: q.correctIndex === oi ? 0 : q.correctIndex > oi ? q.correctIndex - 1 : q.correctIndex })}
                  className="text-label-tertiary hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
          {q.options.length < 6 && (
            <button type="button" onClick={() => setQ(qi, { options: [...q.options, ""] })} className="text-xs font-medium text-accent">Add a choice</button>
          )}
          <p className="text-xs text-label-tertiary">Select the radio button beside the correct choice.</p>
        </fieldset>
      ))}
      {questions.length < 50 && (
        <button type="button" onClick={() => setQuestions((qs) => [...qs, blankQuestion()])} className="text-xs font-semibold text-accent flex items-center gap-1">
          <Plus size={12} /> Add a question
        </button>
      )}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex gap-3 items-center">
        <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save exam"}</button>
        <button type="button" onClick={onClose} className="text-xs font-medium text-label-secondary">Cancel</button>
        {exists && <button type="button" onClick={remove} disabled={busy} className="ml-auto text-xs text-label-tertiary hover:text-danger">Remove exam</button>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- HR: learning paths

function PathForm({ path, courses, onDone, onCancel }: { path?: LearningPathView; courses: CourseView[]; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(path?.title ?? "");
  const [description, setDescription] = useState(path?.description ?? "");
  const [isActive, setIsActive] = useState(path?.isActive ?? true);
  const [ids, setIds] = useState<string[]>(path?.courses.map((c) => c.courseId) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const available = courses.filter((c) => c.isActive && !ids.includes(c.id));
  const [pick, setPick] = useState("");

  const move = (i: number, d: -1 | 1) =>
    setIds((x) => { const n = [...x]; const j = i + d; if (j < 0 || j >= n.length) return x; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (ids.length === 0) { setError("Add at least one course to the path."); return; }
    setBusy(true);
    try {
      const body = { title: title.trim(), description: description.trim() || null, courseIds: ids, isActive };
      if (path) await api.updateLearningPath(path.id, body);
      else await api.createLearningPath(body);
      onDone();
    } catch (err) {
      setError(errText(err, "Could not save this path."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-black/5 rounded-lg p-4 mb-4 space-y-3" aria-label={path ? "Edit learning path" : "New learning path"}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="path-title" className={lbl}>Path title</label>
          <input id="path-title" required value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="path-desc" className={lbl}>Description (optional)</label>
          <input id="path-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
        </div>
      </div>
      <div>
        <p className={lbl}>Courses, in the order they are taken</p>
        {ids.length === 0 ? <p className="text-xs text-label-tertiary">No courses yet.</p> : (
          <ol className="space-y-1">
            {ids.map((id, i) => (
              <li key={id} className="flex items-center gap-2 bg-card rounded-lg px-3 py-1.5 text-sm">
                <span className="flex-1">{i + 1}. {byId.get(id)?.title ?? "Unknown course"}</span>
                <button type="button" aria-label={`Move ${byId.get(id)?.title ?? "course"} up`} onClick={() => move(i, -1)} className="text-label-tertiary hover:text-accent"><ArrowUp size={14} /></button>
                <button type="button" aria-label={`Move ${byId.get(id)?.title ?? "course"} down`} onClick={() => move(i, 1)} className="text-label-tertiary hover:text-accent"><ArrowDown size={14} /></button>
                <button type="button" aria-label={`Remove ${byId.get(id)?.title ?? "course"}`} onClick={() => setIds((x) => x.filter((y) => y !== id))} className="text-label-tertiary hover:text-danger"><Trash2 size={14} /></button>
              </li>
            ))}
          </ol>
        )}
        <div className="flex gap-2 mt-2">
          <select aria-label="Course to add" value={pick} onChange={(e) => setPick(e.target.value)} className={field}>
            <option value="">Choose a course…</option>
            {available.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <button type="button" disabled={!pick} onClick={() => { setIds((x) => [...x, pick]); setPick(""); }} className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold bg-accent text-white disabled:opacity-50">Add</button>
        </div>
      </div>
      <label htmlFor="path-active" className="flex items-center gap-2 text-sm">
        <input id="path-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Path is active
      </label>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy ? "Saving…" : path ? "Save path" : "Create path"}</button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">Cancel</button>
      </div>
    </form>
  );
}

function AssignPath({ path, onDone, onCancel }: { path: LearningPathView; onDone: (msg: string) => void; onCancel: () => void }) {
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listEmployees().then(setEmployees).catch(() => setEmployees([])); }, []);

  const shown = (employees ?? []).filter((e) => `${e.firstName} ${e.lastName} ${e.employeeNumber}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.assignLearningPath(path.id, { employeeIds: [...picked], dueDate: due || null });
      onDone(`${r.assigned} assigned${r.alreadyAssigned ? `, ${r.alreadyAssigned} already had it` : ""} — ${r.enrollmentsCreated} course enrolment${r.enrollmentsCreated === 1 ? "" : "s"} created.`);
    } catch (err) {
      setError(errText(err, "Could not assign this path."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-black/5 rounded-lg p-4 mb-4 space-y-3" aria-label={`Assign ${path.title}`}>
      <h3 className="font-semibold text-sm">Assign “{path.title}”</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="assign-q" className={lbl}>Find people</label>
          <input id="assign-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or employee number" className={field} />
        </div>
        <div>
          <label htmlFor="assign-due" className={lbl}>Finish by (optional)</label>
          <input id="assign-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
        </div>
      </div>
      {!employees ? <LoadingNote /> : (
        <ul className="max-h-56 overflow-y-auto bg-card rounded-lg divide-y divide-black/5">
          {shown.map((e) => (
            <li key={e.id}>
              <label htmlFor={`assign-${e.id}`} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer">
                <input id={`assign-${e.id}`} type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
                {e.firstName} {e.lastName} <span className="text-xs text-label-tertiary">{e.employeeNumber}</span>
              </label>
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-2 text-xs text-label-tertiary">No one matches.</li>}
        </ul>
      )}
      <p className="text-xs text-label-secondary">Each person is enrolled in every course of the path. Courses they already have are left as they are.</p>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy || picked.size === 0} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {busy ? "Assigning…" : `Assign to ${picked.size} ${picked.size === 1 ? "person" : "people"}`}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">Cancel</button>
      </div>
    </form>
  );
}

function PathProgress({ path, onClose }: { path: LearningPathView; onClose: () => void }) {
  const [rows, setRows] = useState<LearningPathProgressRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.learningPathProgress(path.id).then(setRows).catch((e) => { setRows([]); setError(errText(e, "Could not load progress.")); }); }, [path.id]);
  return (
    <section className="bg-card rounded-card p-4 shadow-sm mb-4" aria-label={`Progress on ${path.title}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm">Progress — {path.title}</h3>
        <button onClick={onClose} className="text-xs font-medium text-label-secondary">Close</button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!rows ? <LoadingNote /> : rows.length === 0 ? <p className="text-sm text-label-tertiary">No one has been assigned this path yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3 font-medium">Employee</th><th className="py-1 pr-3 font-medium">Finish by</th><th className="py-1 font-medium">Progress</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} className="border-t border-black/5">
                  <td className="py-1.5 pr-3">{r.employeeName} <span className="text-xs text-label-tertiary">{r.employeeNumber}</span></td>
                  <td className="py-1.5 pr-3 tabular-nums">{r.dueDate ? formatDay(r.dueDate) : "—"}</td>
                  <td className="py-1.5 min-w-[140px]"><Bar done={r.completedCourses} total={r.totalCourses} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function LearningPathsAdminPanel({ courses }: { courses: CourseView[] }) {
  const [paths, setPaths] = useState<LearningPathView[] | null>(null);
  const [mode, setMode] = useState<{ kind: "new" } | { kind: "edit" | "assign" | "progress"; path: LearningPathView } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.listLearningPaths(true).then(setPaths).catch((e) => { setPaths([]); setError(errText(e, "Could not load learning paths.")); });
  }, []);
  useEffect(load, [load]);

  if (!paths) return <LoadingNote />;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Manage Learning Paths</h2>
        {!mode && <button onClick={() => setMode({ kind: "new" })} className="text-sm font-semibold rounded-lg px-3 py-1.5 bg-accent text-white">New path</button>}
      </div>
      {notice && <p className="text-sm text-green-700 mb-3" role="status">{notice}</p>}
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {mode?.kind === "new" && <PathForm courses={courses} onCancel={() => setMode(null)} onDone={() => { setMode(null); setNotice("Path created."); load(); }} />}
      {mode?.kind === "edit" && <PathForm path={mode.path} courses={courses} onCancel={() => setMode(null)} onDone={() => { setMode(null); setNotice("Path saved."); load(); }} />}
      {mode?.kind === "assign" && <AssignPath path={mode.path} onCancel={() => setMode(null)} onDone={(m) => { setMode(null); setNotice(m); load(); }} />}
      {mode?.kind === "progress" && <PathProgress path={mode.path} onClose={() => setMode(null)} />}
      {paths.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No learning paths yet. A path puts courses in order — for example an onboarding programme — and assigns the whole thing in one step.</div>
      ) : (
        <div className="space-y-3">
          {paths.map((p) => (
            <div key={p.id} className="bg-card rounded-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{p.title}{!p.isActive && <span className="ml-2 text-xs text-label-tertiary">(inactive)</span>}</div>
                  <div className="text-xs text-label-tertiary mt-0.5">{p.courses.length} course{p.courses.length === 1 ? "" : "s"} · {p.totalMinutes} min · {p.assignedCount} assigned</div>
                  <div className="text-xs text-label-secondary mt-1">{p.courses.map((c) => c.title + (c.hasExam ? " (exam)" : "")).join(" → ")}</div>
                </div>
                <span className="flex items-center gap-3 shrink-0">
                  <button onClick={() => setMode({ kind: "assign", path: p })} disabled={!p.isActive} className="text-xs font-semibold text-accent disabled:opacity-40">Assign</button>
                  <button onClick={() => setMode({ kind: "progress", path: p })} className="text-xs font-semibold text-accent">Progress</button>
                  <button onClick={() => setMode({ kind: "edit", path: p })} className="text-xs text-label-tertiary hover:text-accent">Edit</button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
