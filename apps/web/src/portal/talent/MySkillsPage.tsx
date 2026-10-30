import { useEffect, useState } from "react";
import type { MySkillView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";

const LEVELS = ["", "Beginner", "Basic", "Skilled", "Advanced", "Expert"];

/** Employees: rate my own skills. The level my job needs is shown beside it; it is a guide for conversation, not a score. */
export function MySkillsPage() {
  const [skills, setSkills] = useState<MySkillView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.listMySkills().then(setSkills).catch((e) => { setSkills([]); setError(e instanceof ApiError ? e.message : "Could not load your skills."); }); }, []);
  return (
    <div data-testid="my-skills">
      <PageHeader title="My skills" subtitle="Rate yourself on the skills your company tracks. HR can see your ratings and may adjust them after a conversation with you." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {skills === null ? <LoadingNote what="your skills" /> : skills.length === 0 ? <p className="text-sm text-label-tertiary">Your company has not set up any skills yet.</p> : (
        <ul className="space-y-2 max-w-2xl">{skills.map((s) => (
          <li key={s.skillId} className="bg-card rounded-card p-3 shadow-sm flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[10rem]"><div className="text-sm font-medium">{s.name}</div><div className="text-xs text-label-tertiary">{s.category ?? ""}{s.requiredLevel ? `${s.category ? " · " : ""}Your job needs ${s.requiredLevel} (${LEVELS[s.requiredLevel]})` : ""}{s.source === "hr" ? " · set by HR" : ""}</div></div>
            <label htmlFor={`ms-${s.skillId}`} className="sr-only">{s.name} level</label>
            <select id={`ms-${s.skillId}`} className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={s.level ?? ""} onChange={(e) => e.target.value && api.setMySkill(s.skillId, Number(e.target.value)).then(setSkills).catch((er) => setError(er instanceof ApiError ? er.message : "Could not save."))}>
              <option value="">Not rated</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {LEVELS[n]}</option>)}</select>
          </li>))}</ul>
      )}
    </div>
  );
}
