import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ApplicationView, CandidateView, PreEmploymentCheckStatus, PreEmploymentCheckType, PreEmploymentCheckView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { describeError, fmtDateTime, inputCls, label, primaryBtn } from "./recruitUi";

const TYPES: PreEmploymentCheckType[] = ["reference", "education", "employment_history", "identity", "criminal_record", "medical", "other"];
const STATUSES: PreEmploymentCheckStatus[] = ["requested", "in_progress", "passed", "failed", "waived"];
const STATUS_STYLES: Record<PreEmploymentCheckStatus, string> = {
  requested: "bg-black/5 text-label-secondary",
  in_progress: "bg-accent/10 text-accent-dark",
  passed: "bg-green-100 text-green-700",
  failed: "bg-danger/15 text-red-700",
  waived: "bg-amber-100 text-amber-800",
};

/**
 * TAL-03: pre-employment checks per application. Which checks a company runs is its own decision - none are preset. A
 * required check that has not passed or been waived stops the offer from being accepted.
 */
export function ChecksPanel() {
  const [applications, setApplications] = useState<ApplicationView[]>([]);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [applicationId, setApplicationId] = useState("");
  const [checks, setChecks] = useState<PreEmploymentCheckView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ checkType: "reference" as PreEmploymentCheckType, label: "", isRequired: true });
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([api.listApplications(), api.listCandidates()])
      .then(([a, c]) => {
        const open = a.filter((x) => x.stage !== "rejected");
        setApplications(open);
        setCandidates(c);
        const first = open.find((x) => x.stage === "offer") ?? open[0];
        if (first) setApplicationId(first.id);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  const nameOf = useMemo(() => {
    const byCand = new Map(candidates.map((c) => [c.id, c]));
    return (a: ApplicationView) => {
      const c = byCand.get(a.candidateId);
      return `${c ? `${c.firstName} ${c.lastName}` : "Candidate"} · ${label(a.stage)}`;
    };
  }, [candidates]);

  const load = useCallback(async () => {
    if (!applicationId) return setChecks([]);
    try {
      setChecks(await api.listPreEmploymentChecks(applicationId));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createPreEmploymentCheck({ applicationId, checkType: form.checkType, label: form.label || undefined, isRequired: form.isRequired });
      setForm({ ...form, label: "" });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function setStatus(c: PreEmploymentCheckView, status: PreEmploymentCheckStatus) {
    try {
      await api.updatePreEmploymentCheck(c.id, { status, resultNote: notes[c.id] || undefined });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="chk-app">Application</label>
        <select id="chk-app" className={`${inputCls} max-w-md`} value={applicationId} onChange={(e) => setApplicationId(e.target.value)}>
          {applications.map((a) => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}
        </select>
      </div>

      {applicationId && (
        <form onSubmit={add} className="bg-black/5 rounded-lg p-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="chk-type">Check</label>
            <select id="chk-type" className={inputCls} value={form.checkType} onChange={(e) => setForm({ ...form, checkType: e.target.value as PreEmploymentCheckType })}>
              {TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="chk-label">Details</label>
            <input id="chk-label" className={inputCls} placeholder="e.g. Previous employer HR" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" checked={form.isRequired} onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} /> Required before hiring</label>
          <button type="submit" className={primaryBtn}>Add check</button>
        </form>
      )}

      {checks.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No checks recorded for this application.</div>
      ) : (
        <ul className="bg-card rounded-card shadow-sm divide-y divide-black/5">
          {checks.map((c) => (
            <li key={c.id} className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm">
                  <span className="font-semibold">{label(c.checkType)}</span>{c.label ? ` · ${c.label}` : ""}
                  {c.isRequired && <span className="ml-2 text-xs text-label-tertiary">required</span>}
                  <div className="text-xs text-label-tertiary">Updated {fmtDateTime(c.updatedAt)}</div>
                </div>
                <span className={`px-2 py-1 text-xs font-semibold rounded ${STATUS_STYLES[c.status]}`}>{label(c.status)}</span>
              </div>
              {c.resultNote && <p className="text-xs text-label-secondary">{c.resultNote}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label="Result note" placeholder="Result note (optional)" className={`${inputCls} max-w-xs`} value={notes[c.id] ?? ""} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                {STATUSES.filter((s) => s !== c.status).map((s) => (
                  <button key={s} onClick={() => setStatus(c, s)} className="text-xs font-medium text-accent hover:underline">Mark {label(s).toLowerCase()}</button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
