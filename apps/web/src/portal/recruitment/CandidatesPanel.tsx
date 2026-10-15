import { FormEvent, useEffect, useMemo, useState } from "react";
import { RECRUITMENT_SOURCES } from "@aihxm/shared-types";
import type { CandidateDuplicateMatch, CandidateView, RecruitmentSource } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { CandidateDetail } from "./CandidateDetail";
import { describeError, inputCls, label } from "./recruitUi";

type FormValue = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nationalId: string;
  source: RecruitmentSource | "";
  sourceDetail: string;
  currentEmployer: string;
  currentDesignation: string;
  expectedSalary: string;
  noticePeriodDays: string;
  consentGiven: boolean;
  consentPurpose: string;
};

function emptyForm(): FormValue {
  return {
    firstName: "", lastName: "", email: "", phone: "", nationalId: "", source: "", sourceDetail: "",
    currentEmployer: "", currentDesignation: "", expectedSalary: "", noticePeriodDays: "", consentGiven: false, consentPurpose: "",
  };
}

function CandidateForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (c: CandidateView) => void }) {
  const [value, setValue] = useState<FormValue>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<CandidateDuplicateMatch[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [more, setMore] = useState(false);
  const set = <K extends keyof FormValue>(k: K, v: FormValue[K]) => setValue((cur) => ({ ...cur, [k]: v }));

  async function submit(allowDuplicate: boolean) {
    setError(null);
    setSubmitting(true);
    try {
      const saved = await api.createCandidate({
        firstName: value.firstName,
        lastName: value.lastName,
        email: value.email || undefined,
        phone: value.phone || undefined,
        nationalId: value.nationalId || undefined,
        source: value.source || undefined,
        sourceDetail: value.sourceDetail || undefined,
        currentEmployer: value.currentEmployer || undefined,
        currentDesignation: value.currentDesignation || undefined,
        expectedSalary: value.expectedSalary ? Number(value.expectedSalary) : undefined,
        noticePeriodDays: value.noticePeriodDays ? Number(value.noticePeriodDays) : undefined,
        consentGiven: value.consentGiven || undefined,
        consentPurpose: value.consentPurpose || undefined,
        allowDuplicate: allowDuplicate || undefined,
      });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.body?.matches)) {
        setMatches(err.body.matches as CandidateDuplicateMatch[]);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not add this candidate.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMatches(null);
    void submit(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">First name</label>
          <input required value={value.firstName} onChange={(e) => set("firstName", e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Last name</label>
          <input required value={value.lastName} onChange={(e) => set("lastName", e.target.value)} className={inputCls} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Email (optional)</label>
          <input type="email" value={value.email} onChange={(e) => set("email", e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Phone (optional)</label>
          <input value={value.phone} onChange={(e) => set("phone", e.target.value)} className={inputCls} />
        </div>
      </div>

      <button type="button" onClick={() => setMore(!more)} className="text-sm font-medium text-accent">
        {more ? "Hide details" : "More details (CNIC, source, current job, consent)"}
      </button>

      {more && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">National ID (CNIC)</label>
              <input value={value.nationalId} onChange={(e) => set("nationalId", e.target.value)} placeholder="12345-1234567-1" className={inputCls} />
              <p className="text-xs text-label-tertiary mt-1">Stored encrypted; only the last four characters are ever shown.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Source</label>
              <select value={value.source} onChange={(e) => set("source", e.target.value as RecruitmentSource | "")} className={inputCls}>
                <option value="">Not recorded</option>
                {RECRUITMENT_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Source detail (e.g. referrer, job board)</label>
              <input value={value.sourceDetail} onChange={(e) => set("sourceDetail", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Current employer</label>
              <input value={value.currentEmployer} onChange={(e) => set("currentEmployer", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Current designation</label>
              <input value={value.currentDesignation} onChange={(e) => set("currentDesignation", e.target.value)} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Expected salary</label>
                <input type="number" min={0} value={value.expectedSalary} onChange={(e) => set("expectedSalary", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Notice (days)</label>
                <input type="number" min={0} value={value.noticePeriodDays} onChange={(e) => set("noticePeriodDays", e.target.value)} className={inputCls} />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={value.consentGiven} onChange={(e) => set("consentGiven", e.target.checked)} />
              The candidate agreed to us keeping their details
            </label>
            {value.consentGiven && (
              <input aria-label="Consent purpose" placeholder="What they agreed to (e.g. this vacancy and future roles)" value={value.consentPurpose} onChange={(e) => set("consentPurpose", e.target.value)} className={inputCls} />
            )}
          </div>
        </div>
      )}

      {matches && (
        <div role="alert" className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm space-y-2">
          <p className="font-semibold text-amber-900">This looks like someone already in the pool:</p>
          <ul className="list-disc ml-5">
            {matches.map((m) => (
              <li key={m.candidateId}>{m.fullName} — same {m.matchedOn.map((x) => x.replace("_", " ")).join(" and ")}</li>
            ))}
          </ul>
          <button type="button" disabled={submitting} onClick={() => void submit(true)} className="text-sm font-semibold text-amber-900 underline">
            It is a different person: add anyway
          </button>
        </div>
      )}

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button type="submit" disabled={submitting} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {submitting ? "Adding…" : "Add candidate"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Task #51 — Recruitment, tab two. Candidates are a company-wide pool with no requisition tie until an Application links
 * the two (see PipelinePanel). Candidates deliberately have no login of their own (Decision #10), so this is an HR-side
 * roster. Step 11A adds duplicate detection, a profile with documents and history, and the retention / anonymise controls.
 */
export function CandidatesPanel() {
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  function load() {
    api.listCandidates().then(setCandidates).catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates ?? [];
    return (candidates ?? []).filter((c) => `${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.phone ?? ""} ${c.currentEmployer ?? ""}`.toLowerCase().includes(q));
  }, [candidates, query]);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!candidates) return <div className="text-label-tertiary text-sm">Loading…</div>;

  if (openId) {
    return (
      <CandidateDetail
        candidateId={openId}
        onBack={() => {
          setOpenId(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Add candidates to the pool, then attach them to an approved requisition from the Pipeline tab.
        </p>
        {!creating && (
          <button onClick={() => setCreating(true)} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4">
            Add Candidate
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <CandidateForm
            onCancel={() => setCreating(false)}
            onSaved={(saved) => {
              setCreating(false);
              // Use the POST's own response rather than re-fetching: a live QA pass found a GET right after a POST can
              // briefly omit the new row (read-after-write lag), so the response is the source of truth here.
              setCandidates((cands) => (cands ? [...cands, saved] : [saved]));
            }}
          />
        </div>
      )}

      {candidates.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No candidates yet. Add one to start building the pool.</div>
      )}

      {candidates.length > 0 && (
        <>
          <input aria-label="Search the pool" placeholder="Search by name, email, phone or employer" value={query} onChange={(e) => setQuery(e.target.value)} className={`${inputCls} max-w-md`} />
          <div className="bg-card rounded-card shadow-sm divide-y divide-black/5">
            {shown.map((c) => (
              <div key={c.id} className="p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-sm">
                    {c.firstName} {c.lastName}
                    {c.anonymisedAt && <span className="ml-2 text-xs font-normal text-label-tertiary">anonymised</span>}
                  </div>
                  <div className="text-xs text-label-tertiary">
                    {c.email ?? "No email"} {c.phone ? `· ${c.phone}` : ""}
                    {c.currentEmployer ? ` · ${c.currentDesignation ? `${c.currentDesignation} at ` : ""}${c.currentEmployer}` : ""}
                    {c.source ? ` · via ${label(c.source)}` : ""}
                    {c.documentCount > 0 ? ` · ${c.documentCount} document(s)` : ""}
                  </div>
                </div>
                <button onClick={() => setOpenId(c.id)} className="text-accent text-xs font-medium hover:underline shrink-0">
                  Open profile
                </button>
              </div>
            ))}
            {shown.length === 0 && <div className="p-4 text-sm text-label-tertiary">No one matches that search.</div>}
          </div>
        </>
      )}
    </div>
  );
}
