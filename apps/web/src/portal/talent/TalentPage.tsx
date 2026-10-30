import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { JobSkillRequirementView, JobView, NineBoxPerson, NineBoxView, PositionView, SkillGapReport, SkillView, SuccessionPositionView, SuccessionReadiness, TalentBand, TalentPoolView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { useConfirm } from "../shared/useConfirm";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";
const LEVELS = ["", "Beginner", "Basic", "Skilled", "Advanced", "Expert"];
const READY: Record<SuccessionReadiness, string> = { ready_now: "Ready now", one_to_two_years: "In 1 to 2 years", three_plus_years: "In 3 or more years" };
const BAND_LABEL: Record<TalentBand, string> = { low: "Low", medium: "Medium", high: "High" };
const TABS = [["ninebox", "Nine-box"], ["skills", "Skills"], ["succession", "Succession"], ["pools", "Talent pools"]] as const;
type Tab = (typeof TABS)[number][0];
const msg = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);

/** HR: nine-box, skills and gaps, succession lists and talent pools. Every placement is a person's judgement; nothing is scored or acted on. */
export function TalentPage() {
  const [tab, setTab] = useState<Tab>("ninebox");
  const [error, setError] = useState<string | null>(null);
  return (
    <div data-testid="talent">
      <PageHeader title="Talent" subtitle="Where people stand today, what skills jobs need, and who could step into key positions. Placements are your judgement and are never acted on automatically." />
      <div role="tablist" className="flex gap-1 border-b border-black/10 mb-5 overflow-x-auto">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${tab === k ? "border-accent text-accent" : "border-transparent text-label-tertiary"}`}>{l}</button>
        ))}
      </div>
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {tab === "ninebox" && <NineBoxTab onError={setError} />}
      {tab === "skills" && <SkillsTab onError={setError} />}
      {tab === "succession" && <SuccessionTab onError={setError} />}
      {tab === "pools" && <PoolsTab onError={setError} />}
    </div>
  );
}

function NineBoxTab({ onError }: { onError: (m: string | null) => void }) {
  const { dialog, ask } = useConfirm();
  const [box, setBox] = useState<NineBoxView | null>(null);
  const [pick, setPick] = useState<NineBoxPerson | null>(null);
  const [potential, setPotential] = useState<TalentBand>("medium");
  const [perf, setPerf] = useState<"" | TalentBand>("");
  const [note, setNote] = useState("");
  useEffect(() => { api.getNineBox().then(setBox).catch((e) => { setBox({ people: [], ratingBands: { low: "", medium: "", high: "" } }); onError(msg(e, "Could not load the nine-box.")); }); }, [onError]);
  const rows: TalentBand[] = ["high", "medium", "low"];
  const cols: TalentBand[] = ["low", "medium", "high"];
  const placed = (p: TalentBand, pf: TalentBand) => (box?.people ?? []).filter((x) => x.potential === p && x.performance === pf);
  const waiting = (box?.people ?? []).filter((x) => !x.potential || !x.performance);

  function open(p: NineBoxPerson) { setPick(p); setPotential(p.potential ?? "medium"); setPerf(p.performanceSource === "hr" ? (p.performance ?? "") : ""); setNote(p.note ?? ""); }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!pick) return;
    try { setBox(await api.saveTalentAssessment({ employeeId: pick.employeeId, potential, performanceBand: perf || null, note: note || null })); setPick(null); onError(null); } catch (err) { onError(msg(err, "Could not save.")); }
  }
  if (!box) return <LoadingNote what="the nine-box" />;
  return (
    <div className="space-y-5">
      {dialog}
      <p className="text-xs text-label-tertiary">Performance is read from each person's latest released review rating ({box.ratingBands.low} is low, {box.ratingBands.medium} medium, {box.ratingBands.high} high) unless you set it yourself. Potential is always your judgement.</p>
      <div className="overflow-x-auto"><div className="grid grid-cols-[auto_repeat(3,minmax(9rem,1fr))] gap-2 min-w-[34rem]" data-testid="ninebox-grid">
        {rows.map((p) => (
          <div key={p} className="contents">
            <div className="text-xs text-label-tertiary self-center pr-1">Potential<br /><strong>{BAND_LABEL[p]}</strong></div>
            {cols.map((pf) => (
              <div key={pf} className="bg-card rounded-card p-2 shadow-sm min-h-[5.5rem]" data-testid={`cell-${p}-${pf}`}>
                {placed(p, pf).map((x) => <button key={x.employeeId} type="button" onClick={() => open(x)} className="block w-full text-left text-xs py-0.5 hover:underline">{x.employeeName}</button>)}
              </div>
            ))}
          </div>
        ))}
        <div />{cols.map((c) => <div key={c} className="text-xs text-center text-label-tertiary">Performance<br /><strong>{BAND_LABEL[c]}</strong></div>)}
      </div></div>
      {pick && (
        <form onSubmit={save} className="bg-card rounded-card p-4 shadow-sm space-y-3 max-w-md" data-testid="ninebox-form">
          <h2 className="font-semibold">{pick.employeeName} <span className="text-label-tertiary font-normal">{pick.employeeNumber}</span></h2>
          <div><label htmlFor="nb-pot" className="block text-xs font-medium text-label-secondary mb-1">Potential</label><select id="nb-pot" className={field} value={potential} onChange={(e) => setPotential(e.target.value as TalentBand)}>{(["low", "medium", "high"] as TalentBand[]).map((b) => <option key={b} value={b}>{BAND_LABEL[b]}</option>)}</select></div>
          <div><label htmlFor="nb-perf" className="block text-xs font-medium text-label-secondary mb-1">Performance</label><select id="nb-perf" className={field} value={perf} onChange={(e) => setPerf(e.target.value as "" | TalentBand)}>
            <option value="">{pick.finalRating ? `From latest review (rating ${pick.finalRating})` : "No review rating yet"}</option>{(["low", "medium", "high"] as TalentBand[]).map((b) => <option key={b} value={b}>Set myself: {BAND_LABEL[b]}</option>)}</select></div>
          <div><label htmlFor="nb-note" className="block text-xs font-medium text-label-secondary mb-1">Note</label><input id="nb-note" className={field} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="flex gap-2"><button type="submit" className={btn}>Save placement</button><button type="button" className={quiet} onClick={() => setPick(null)}>Cancel</button>
            {pick.potential && <button type="button" className={quiet} onClick={() => ask("Remove this person from the nine-box?", () => void api.removeTalentAssessment(pick.employeeId).then((b) => { setBox(b); setPick(null); }).catch((e) => onError(msg(e, "Could not remove."))))}>Remove</button>}</div>
        </form>
      )}
      <div>
        <h2 className="font-semibold text-sm mb-2">Not placed yet ({waiting.length})</h2>
        <div className="flex flex-wrap gap-2" data-testid="ninebox-waiting">{waiting.map((x) => <button key={x.employeeId} type="button" className={quiet} onClick={() => open(x)}>{x.employeeName}</button>)}</div>
        <p className="text-xs text-label-tertiary mt-2">People appear in the grid once they have both a potential and a performance band.</p>
      </div>
    </div>
  );
}

function SkillsTab({ onError }: { onError: (m: string | null) => void }) {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [reqs, setReqs] = useState<JobSkillRequirementView[]>([]);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [jobId, setJobId] = useState("");
  const [gap, setGap] = useState<SkillGapReport | null>(null);
  useEffect(() => {
    api.listSkills(true).then(setSkills).catch((e) => { setSkills([]); onError(msg(e, "Could not load skills.")); });
    api.listJobs().then(setJobs).catch(() => setJobs([]));
    api.listSkillRequirements().then(setReqs).catch(() => setReqs([]));
  }, [onError]);
  const jobReqs = useMemo(() => reqs.filter((r) => r.jobId === jobId), [reqs, jobId]);
  const loadGap = useCallback(() => { if (jobId) api.getSkillGaps(jobId).then(setGap).catch((e) => onError(msg(e, "Could not build the report."))); else setGap(null); }, [jobId, onError]);
  useEffect(loadGap, [loadGap]);

  async function add(e: FormEvent) { e.preventDefault(); try { setSkills(await api.saveSkill({ name, category: category || null })); setName(""); onError(null); } catch (err) { onError(msg(err, "Could not add.")); } }
  async function setReq(skillId: string, level: number | null) { try { setReqs(await api.setSkillRequirement(jobId, skillId, level)); loadGap(); } catch (err) { onError(msg(err, "Could not save.")); } }
  if (!skills) return <LoadingNote what="skills" />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <h2 className="font-semibold">Skills catalogue</h2>
        <form onSubmit={add} className="flex gap-2 items-end">
          <div className="flex-1"><label htmlFor="sk-name" className="block text-xs text-label-secondary mb-1">New skill</label><input id="sk-name" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></div>
          <div className="w-36"><label htmlFor="sk-cat" className="block text-xs text-label-secondary mb-1">Category</label><input id="sk-cat" className={field} value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} /></div>
          <button type="submit" className={btn}>Add</button>
        </form>
        {skills.length === 0 ? <p className="text-sm text-label-tertiary">No skills yet. Add the ones that matter in your company.</p> : (
          <ul className="space-y-1" data-testid="skill-list">{skills.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm"><span className="flex-1">{s.name}{s.category && <span className="text-label-tertiary"> · {s.category}</span>}{!s.isActive && " (hidden)"}</span>
              <button type="button" className="text-xs text-accent" onClick={() => api.saveSkill({ id: s.id, name: s.name, category: s.category, isActive: !s.isActive }).then(setSkills).catch((e) => onError(msg(e, "Could not update.")))}>{s.isActive ? "Hide" : "Show"}</button></li>
          ))}</ul>
        )}
      </div>
      <div className="space-y-3">
        <h2 className="font-semibold">What a job needs, and who falls short</h2>
        <div><label htmlFor="sk-job" className="block text-xs text-label-secondary mb-1">Job</label><select id="sk-job" className={field} value={jobId} onChange={(e) => setJobId(e.target.value)}><option value="">Choose a job</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></div>
        {jobId && (
          <>
            <ul className="space-y-1">{skills.filter((s) => s.isActive).map((s) => {
              const cur = jobReqs.find((r) => r.skillId === s.id)?.requiredLevel ?? "";
              return (<li key={s.id} className="flex items-center gap-2 text-sm"><label htmlFor={`rq-${s.id}`} className="flex-1">{s.name}</label>
                <select id={`rq-${s.id}`} className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={cur} onChange={(e) => void setReq(s.id, e.target.value ? Number(e.target.value) : null)}><option value="">Not needed</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {LEVELS[n]}</option>)}</select></li>);
            })}</ul>
            {gap && (
              <div data-testid="gap-report"><h3 className="text-sm font-medium mt-2">{gap.people.length} of {gap.peopleInJob} in this job fall short</h3>
                {gap.people.length === 0 ? <p className="text-xs text-label-tertiary">{gap.requirements.length === 0 ? "Set the levels this job needs first." : "Everyone in this job meets the levels set."}</p> : (
                  <ul className="space-y-1 mt-1">{gap.people.map((p) => (<li key={p.employeeId} className="text-sm"><strong>{p.employeeName}</strong> <span className="text-label-tertiary">{p.employeeNumber}</span>
                    <div className="text-xs text-label-secondary">{p.gaps.map((g) => `${g.skillName}: ${g.level ?? "not rated"} of ${g.requiredLevel}`).join(" · ")}</div></li>))}</ul>
                )}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SuccessionTab({ onError }: { onError: (m: string | null) => void }) {
  const { dialog, ask } = useConfirm();
  const [list, setList] = useState<SuccessionPositionView[] | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [people, setPeople] = useState<NineBoxPerson[]>([]);
  const [form, setForm] = useState({ positionId: "", employeeId: "", readiness: "ready_now" as SuccessionReadiness, note: "" });
  useEffect(() => {
    api.getSuccession().then(setList).catch((e) => { setList([]); onError(msg(e, "Could not load succession lists.")); });
    api.listPositions().then(setPositions).catch(() => setPositions([]));
    api.getNineBox().then((b) => setPeople(b.people)).catch(() => setPeople([]));
  }, [onError]);
  async function add(e: FormEvent) { e.preventDefault(); try { setList(await api.addSuccessionCandidate(form.positionId, form.employeeId, form.readiness, form.note)); setForm({ ...form, employeeId: "", note: "" }); onError(null); } catch (err) { onError(msg(err, "Could not add.")); } }
  return (
    <div className="space-y-5">
      {dialog}
      <form onSubmit={add} className="bg-card rounded-card p-4 shadow-sm grid gap-3 sm:grid-cols-2 max-w-3xl">
        <div><label htmlFor="su-pos" className="block text-xs font-medium text-label-secondary mb-1">Key position</label><select id="su-pos" className={field} value={form.positionId} onChange={(e) => setForm({ ...form, positionId: e.target.value })} required><option value="">Choose</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.positionTitle}</option>)}</select></div>
        <div><label htmlFor="su-emp" className="block text-xs font-medium text-label-secondary mb-1">Possible successor</label><select id="su-emp" className={field} value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required><option value="">Choose</option>{people.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.employeeName} ({p.employeeNumber})</option>)}</select></div>
        <div><label htmlFor="su-rd" className="block text-xs font-medium text-label-secondary mb-1">Readiness</label><select id="su-rd" className={field} value={form.readiness} onChange={(e) => setForm({ ...form, readiness: e.target.value as SuccessionReadiness })}>{(Object.keys(READY) as SuccessionReadiness[]).map((k) => <option key={k} value={k}>{READY[k]}</option>)}</select></div>
        <div><label htmlFor="su-note" className="block text-xs font-medium text-label-secondary mb-1">Note</label><input id="su-note" className={field} maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
        <div className="sm:col-span-2"><button type="submit" className={btn}>Add to succession list</button></div>
      </form>
      {list === null ? <LoadingNote what="succession lists" /> : list.length === 0 ? <p className="text-sm text-label-tertiary">No succession lists yet.</p> : (
        <div className="space-y-3" data-testid="succession-list">{list.map((p) => (
          <div key={p.positionId} className="bg-card rounded-card p-4 shadow-sm">
            <div className="font-semibold">{p.positionTitle} <span className="text-label-tertiary font-normal">· {p.orgUnitName}</span></div>
            <div className="text-xs text-label-tertiary mb-2">Today: {p.incumbentName ?? "vacant"}</div>
            <ul className="space-y-1">{p.candidates.map((c) => (<li key={c.employeeId} className="text-sm flex items-center gap-2"><span className="flex-1">{c.employeeName} <span className="text-label-tertiary">· {READY[c.readiness]}{c.note ? ` · ${c.note}` : ""}</span></span>
              <button type="button" className="text-xs text-danger" onClick={() => ask(`Remove ${c.employeeName} from this succession list?`, () => void api.removeSuccessionCandidate(p.positionId, c.employeeId).then(setList).catch((e) => onError(msg(e, "Could not remove."))))}>Remove</button></li>))}</ul>
          </div>))}</div>
      )}
    </div>
  );
}

function PoolsTab({ onError }: { onError: (m: string | null) => void }) {
  const [pools, setPools] = useState<TalentPoolView[] | null>(null);
  const [people, setPeople] = useState<NineBoxPerson[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    api.listTalentPools().then(setPools).catch((e) => { setPools([]); onError(msg(e, "Could not load pools.")); });
    api.getNineBox().then((b) => setPeople(b.people)).catch(() => setPeople([]));
  }, [onError]);
  async function create(e: FormEvent) { e.preventDefault(); try { setPools(await api.createTalentPool(name)); setName(""); onError(null); } catch (err) { onError(msg(err, "Could not create.")); } }
  if (!pools) return <LoadingNote what="pools" />;
  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex gap-2 items-end max-w-md"><div className="flex-1"><label htmlFor="pl-name" className="block text-xs text-label-secondary mb-1">New pool</label><input id="pl-name" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></div><button type="submit" className={btn}>Create</button></form>
      <div className="grid gap-4 lg:grid-cols-2" data-testid="pool-list">{pools.map((p) => (
        <div key={p.id} className="bg-card rounded-card p-4 shadow-sm space-y-2">
          <div className="flex items-center"><h2 className="font-semibold flex-1">{p.name}</h2><button type="button" className="text-xs text-danger" onClick={() => api.deleteTalentPool(p.id).then(setPools).catch((e) => onError(msg(e, "Could not delete.")))}>Delete pool</button></div>
          <ul className="space-y-1">{p.members.map((m) => (<li key={m.employeeId} className="text-sm flex"><span className="flex-1">{m.employeeName}</span><button type="button" className="text-xs text-danger" onClick={() => api.setTalentPoolMember(p.id, m.employeeId, false).then(setPools).catch((e) => onError(msg(e, "Could not remove.")))}>Remove</button></li>))}</ul>
          <label htmlFor={`pm-${p.id}`} className="sr-only">Add a person to {p.name}</label>
          <select id={`pm-${p.id}`} className={field} value="" onChange={(e) => e.target.value && api.setTalentPoolMember(p.id, e.target.value, true).then(setPools).catch((er) => onError(msg(er, "Could not add.")))}>
            <option value="">Add a person…</option>{people.filter((x) => !p.members.some((m) => m.employeeId === x.employeeId)).map((x) => <option key={x.employeeId} value={x.employeeId}>{x.employeeName} ({x.employeeNumber})</option>)}</select>
        </div>))}</div>
    </div>
  );
}
