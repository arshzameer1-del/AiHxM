import { FormEvent, useEffect, useState } from "react";
import type { CareersEmploymentType, RequisitionCareersView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { LoadingNote } from "../shared/PageChrome";
import { describeError, fmtDate, inputCls, primaryBtn } from "./recruitUi";
import { EMPLOYMENT_LABEL } from "../../auth/CareersPublicPage";

/** Which approved requisitions are on the public careers page, and what the public reads about each. */
export function CareersPanel() {
  const [rows, setRows] = useState<RequisitionCareersView[] | null>(null);
  const slug = useAuth().identity?.companySlug ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listCareersRequisitions().then(setRows).catch((err) => { setRows([]); setError(describeError(err)); });
  useEffect(() => {
    load();
  }, []);

  if (!rows) return <LoadingNote />;
  const url = slug ? `${window.location.origin}/careers/${slug}` : null;
  return (
    <div className="space-y-4 max-w-3xl">
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}
      <p className="text-sm text-label-secondary">
        Approved requisitions can be published here for anyone to see and apply to.
        {url ? <> Your page: <a className="text-accent underline" href={url} target="_blank" rel="noreferrer">{url}</a>.</> : null}{" "}
        The page itself is switched on in Settings.
      </p>
      {rows.length === 0 && <div className="bg-card rounded-card shadow-sm p-5 text-sm text-label-tertiary">No approved requisitions yet. Approve a requisition first.</div>}
      {rows.map((r) => (
        <div key={r.requisitionId} className="bg-card rounded-card shadow-sm p-4" data-testid="careers-row">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm">{r.title}</span>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${r.published ? "bg-green-100 text-green-800" : "bg-black/5"}`}>{r.published ? "Published" : "Not published"}</span>
            <span className="text-xs text-label-tertiary">{r.applicationCount} application{r.applicationCount === 1 ? "" : "s"}</span>
            <button type="button" className="ml-auto text-accent text-xs font-medium hover:underline" onClick={() => setEditing(editing === r.requisitionId ? null : r.requisitionId)}>
              {editing === r.requisitionId ? "Close" : r.published ? "Edit" : "Publish"}
            </button>
          </div>
          {r.published && <p className="text-xs text-label-tertiary mt-1">{[r.location, r.employmentType && EMPLOYMENT_LABEL[r.employmentType], r.closesOn && `closes ${fmtDate(r.closesOn)}`].filter(Boolean).join(" · ")}</p>}
          {editing === r.requisitionId && <CareersForm row={r} onSaved={() => { setEditing(null); load(); }} />}
        </div>
      ))}
    </div>
  );
}

function CareersForm({ row, onSaved }: { row: RequisitionCareersView; onSaved: () => void }) {
  const [description, setDescription] = useState(row.description ?? "");
  const [location, setLocation] = useState(row.location ?? "");
  const [type, setType] = useState<CareersEmploymentType | "">(row.employmentType ?? "");
  const [closesOn, setClosesOn] = useState(row.closesOn ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idp = `cp-${row.requisitionId}`;

  async function save(publish: boolean, e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveRequisitionCareers(row.requisitionId, { publish, description, location, employmentType: type || null, closesOn: closesOn || null });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => save(true, e)} className="mt-3 space-y-3 border-t border-black/5 pt-3" aria-label={`Careers page settings for ${row.title}`}>
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}
      <div>
        <label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-d`}>What the public reads about this job</label>
        <textarea id={`${idp}-d`} rows={6} maxLength={8000} className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        <p className="text-xs text-label-tertiary mt-1">Do not include salary, headcount or internal reasons. Those are never shown, and this text is public.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div><label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-l`}>Location</label><input id={`${idp}-l`} className={inputCls} maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} /></div>
        <div>
          <label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-t`}>Type</label>
          <select id={`${idp}-t`} className={inputCls} value={type} onChange={(e) => setType(e.target.value as CareersEmploymentType | "")}>
            <option value="">Not stated</option>
            {(Object.keys(EMPLOYMENT_LABEL) as CareersEmploymentType[]).map((k) => <option key={k} value={k}>{EMPLOYMENT_LABEL[k]}</option>)}
          </select>
        </div>
        <div><label className="block text-xs font-semibold mb-1" htmlFor={`${idp}-c`}>Apply by</label><input id={`${idp}-c`} type="date" className={inputCls} value={closesOn} onChange={(e) => setClosesOn(e.target.value)} /></div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryBtn}>{row.published ? "Save and keep published" : "Publish"}</button>
        {row.published && <button type="button" disabled={busy} onClick={() => save(false)} className="px-4 py-2 text-sm font-medium rounded-lg border border-black/10">Unpublish</button>}
      </div>
    </form>
  );
}
