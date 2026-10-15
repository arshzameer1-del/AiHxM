import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { RECRUITMENT_SOURCES } from "@aihxm/shared-types";
import type { CandidateDocumentType, CandidateDocumentView, CandidateTimelineEntry, CandidateView, RecruitmentSource } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ReasonModal } from "../../components/ReasonModal";
import { describeError, fmtDate, fmtDateTime, ghostBtn, inputCls, label, linkBtn, primaryBtn } from "./recruitUi";

const DOC_TYPES: CandidateDocumentType[] = ["resume", "cover_letter", "identity", "certificate", "reference", "other"];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** TAL-01: a candidate's profile, documents, and a single timeline of everything that happened to them. */
export function CandidateDetail({ candidateId, onBack }: { candidateId: string; onBack: () => void }) {
  const [candidate, setCandidate] = useState<CandidateView | null>(null);
  const [docs, setDocs] = useState<CandidateDocumentView[]>([]);
  const [timeline, setTimeline] = useState<CandidateTimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anonymising, setAnonymising] = useState(false);
  const [docType, setDocType] = useState<CandidateDocumentType>("resume");
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState({ email: "", phone: "", currentEmployer: "", currentDesignation: "", expectedSalary: "", noticePeriodDays: "", source: "" as RecruitmentSource | "", sourceDetail: "" });

  const load = useCallback(async () => {
    try {
      const [c, d, t] = await Promise.all([api.getCandidate(candidateId), api.listCandidateDocuments(candidateId), api.getCandidateTimeline(candidateId)]);
      setCandidate(c);
      setDocs(d);
      setTimeline(t);
      setDraft({
        email: c.email ?? "", phone: c.phone ?? "", currentEmployer: c.currentEmployer ?? "", currentDesignation: c.currentDesignation ?? "",
        expectedSalary: c.expectedSalary === null ? "" : String(c.expectedSalary), noticePeriodDays: c.noticePeriodDays === null ? "" : String(c.noticePeriodDays),
        source: c.source ?? "", sourceDetail: c.sourceDetail ?? "",
      });
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [candidateId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateCandidate(candidateId, {
        email: draft.email || undefined,
        phone: draft.phone || undefined,
        currentEmployer: draft.currentEmployer || undefined,
        currentDesignation: draft.currentDesignation || undefined,
        expectedSalary: draft.expectedSalary ? Number(draft.expectedSalary) : undefined,
        noticePeriodDays: draft.noticePeriodDays ? Number(draft.noticePeriodDays) : undefined,
        source: draft.source || undefined,
        sourceDetail: draft.sourceDetail || undefined,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }
    setBusy(true);
    try {
      await api.uploadCandidateDocument(candidateId, docType, file);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!candidate) return error ? <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div> : <div className="text-label-tertiary text-sm">Loading…</div>;
  const anonymised = Boolean(candidate.anonymisedAt);

  return (
    <div className="space-y-5">
      <button onClick={onBack} className={ghostBtn}>← Back to the pool</button>
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      <section className="bg-card rounded-card shadow-sm p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold">{candidate.firstName} {candidate.lastName}</h2>
            <p className="text-xs text-label-tertiary">
              {candidate.email ?? "No email"}{candidate.phone ? ` · ${candidate.phone}` : ""}
              {candidate.nationalIdMasked ? ` · ID ${candidate.nationalIdMasked}` : ""}
            </p>
          </div>
          {!anonymised && (
            <div className="flex gap-3">
              <button onClick={() => setEditing(!editing)} className={linkBtn}>{editing ? "Stop editing" : "Edit"}</button>
              <button onClick={() => setAnonymising(true)} className="text-danger text-xs font-medium hover:underline">Anonymise</button>
            </div>
          )}
        </div>

        {anonymised ? (
          <p className="text-sm text-label-secondary">This candidate was anonymised on {fmtDate(candidate.anonymisedAt)}. Personal details and documents have been removed; the hiring history is kept.</p>
        ) : editing ? (
          <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
            {([
              ["Email", "email"], ["Phone", "phone"], ["Current employer", "currentEmployer"], ["Current designation", "currentDesignation"],
              ["Expected salary", "expectedSalary"], ["Notice (days)", "noticePeriodDays"], ["Source detail", "sourceDetail"],
            ] as const).map(([text, key]) => (
              <div key={key}>
                <label className="block text-sm font-medium mb-1">{text}</label>
                <input className={inputCls} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
              </div>
            ))}
            <div>
              <label className="block text-sm font-medium mb-1">Source</label>
              <select className={inputCls} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value as RecruitmentSource | "" })}>
                <option value="">Not recorded</option>
                {RECRUITMENT_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2"><button type="submit" disabled={busy} className={primaryBtn}>Save changes</button></div>
          </form>
        ) : (
          <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <Item k="Current job" v={candidate.currentEmployer ? `${candidate.currentDesignation ? `${candidate.currentDesignation} at ` : ""}${candidate.currentEmployer}` : "-"} />
            <Item k="Expected salary" v={candidate.expectedSalary === null ? "-" : candidate.expectedSalary.toLocaleString()} />
            <Item k="Notice period" v={candidate.noticePeriodDays === null ? "-" : `${candidate.noticePeriodDays} days`} />
            <Item k="Source" v={candidate.source ? `${label(candidate.source)}${candidate.sourceDetail ? ` (${candidate.sourceDetail})` : ""}` : "-"} />
            <Item k="Consent" v={candidate.consentGivenAt ? `Given ${fmtDate(candidate.consentGivenAt)}${candidate.consentPurpose ? ` for ${candidate.consentPurpose}` : ""}` : "Not recorded"} />
            <Item k="Keep until" v={candidate.retentionUntil ? fmtDate(candidate.retentionUntil) : "No retention period set"} />
          </dl>
        )}
      </section>

      <section className="bg-card rounded-card shadow-sm p-5 space-y-3">
        <h3 className="font-semibold">Documents</h3>
        {docs.length === 0 && <p className="text-sm text-label-tertiary">No documents yet.</p>}
        <ul className="divide-y divide-black/5 text-sm">
          {docs.map((d) => (
            <li key={d.id} className="py-2 flex items-center justify-between gap-3">
              <span>
                <span className="text-xs bg-black/5 rounded px-1.5 py-0.5 mr-2">{label(d.docType)}</span>
                {d.fileName} <span className="text-xs text-label-tertiary">· {formatBytes(d.sizeBytes)} · {fmtDate(d.createdAt)}</span>
              </span>
              <span className="flex gap-3">
                <button className={linkBtn} onClick={() => api.downloadCandidateDocument(candidateId, d.id, d.fileName).catch((err) => setError(describeError(err)))}>Download</button>
                {!anonymised && <button className="text-danger text-xs font-medium hover:underline" onClick={() => api.deleteCandidateDocument(candidateId, d.id).then(load).catch((err) => setError(describeError(err)))}>Delete</button>}
              </span>
            </li>
          ))}
        </ul>
        {!anonymised && (
          <form onSubmit={upload} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="cand-doc-type">Type</label>
              <select id="cand-doc-type" className={inputCls} value={docType} onChange={(e) => setDocType(e.target.value as CandidateDocumentType)}>
                {DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="cand-doc-file">File (PDF, Word or image, up to 10 MB)</label>
              <input id="cand-doc-file" ref={fileRef} type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp" className="text-sm" />
            </div>
            <button type="submit" disabled={busy} className={primaryBtn}>Upload</button>
          </form>
        )}
      </section>

      <section className="bg-card rounded-card shadow-sm p-5 space-y-3">
        <h3 className="font-semibold">History</h3>
        {timeline.length === 0 && <p className="text-sm text-label-tertiary">Nothing recorded yet.</p>}
        <ol className="space-y-2 text-sm">
          {timeline.map((t, i) => (
            <li key={`${t.at}-${i}`} className="flex gap-3">
              <span className="text-xs text-label-tertiary w-36 shrink-0">{fmtDateTime(t.at)}</span>
              <span><span className="text-xs bg-black/5 rounded px-1.5 py-0.5 mr-2">{label(t.kind)}</span>{t.summary}</span>
            </li>
          ))}
        </ol>
      </section>

      {anonymising && (
        <ReasonModal
          title={`Anonymise ${candidate.firstName} ${candidate.lastName}`}
          description="Name, contact details, ID number and documents are removed for good. The applications and decisions stay, without personal details. This cannot be undone."
          confirmLabel="Anonymise"
          danger
          onCancel={() => setAnonymising(false)}
          onConfirm={async (reason) => {
            await api.anonymiseCandidate(candidateId, reason);
            setAnonymising(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-label-tertiary">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
