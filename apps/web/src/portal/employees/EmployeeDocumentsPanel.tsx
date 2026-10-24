import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText } from "lucide-react";
import type { EmployeeDocumentChecklist, EmployeeDocumentView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDay, localDayKey } from "../shared/dates";
import {
  CHECKLIST_BADGE,
  DEFAULT_DOCUMENT_TYPES,
  REVIEW_BADGE,
  expiryState,
  typeLabel,
  uploadProblem,
} from "./employeeDocuments";

const todayKey = () => new Date().toISOString().slice(0, 10);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";

/**
 * BACKLOG50 - the document vault of one employee.
 *  - HR (`canManage`): upload with an expiry date, approve or reject what the employee uploaded, choose the mandatory documents.
 *  - The employee (`own`): sees their file, the checklist of what HR expects, and uploads for HR to check.
 */
export function EmployeeDocumentsPanel({ employeeId, canManage, own = false }: { employeeId: string; canManage: boolean; own?: boolean }) {
  const [docs, setDocs] = useState<EmployeeDocumentView[] | null>(null);
  const [checklist, setChecklist] = useState<EmployeeDocumentChecklist | null>(null);
  const [options, setOptions] = useState(DEFAULT_DOCUMENT_TYPES);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [editingRequired, setEditingRequired] = useState(false);
  const [requiredPick, setRequiredPick] = useState<string[]>([]);
  const [uploadType, setUploadType] = useState("cnic");
  const [expiry, setExpiry] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const today = todayKey();

  const load = useCallback(() => {
    api.listEmployeeDocuments(employeeId).then(setDocs).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the documents."));
    api.getEmployeeDocumentChecklist(employeeId).then(setChecklist).catch(() => setChecklist(null));
  }, [employeeId]);

  useEffect(() => {
    setDocs(null);
    load();
    api
      .listHrCatalogItems("document_type")
      .then((items) => items.length > 0 && setOptions(items.map((i) => ({ value: i.code, label: i.label }))))
      .catch(() => undefined); // an employee cannot read the catalog - the standard list is used
  }, [employeeId, load]);

  async function download(doc: EmployeeDocumentView) {
    setBusy(doc.id);
    setError(null);
    try {
      await api.downloadEmployeeDocument(employeeId, doc.id, doc.fileName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this document.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const problem = uploadProblem(file, uploadType);
    if (problem) return setError(problem);
    setUploading(true);
    try {
      await api.uploadEmployeeDocument(employeeId, { file: file!, documentType: uploadType, expiryDate: expiry || undefined, note: note.trim() || undefined, own: !canManage && own });
      setNotice(!canManage && own ? "Uploaded. HR will check it before it counts." : "Document added.");
      setFile(null);
      setExpiry("");
      setNote("");
      if (fileInput.current) fileInput.current.value = "";
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload the document.");
    } finally {
      setUploading(false);
    }
  }

  async function decide(doc: EmployeeDocumentView, decision: "approved" | "rejected") {
    setError(null);
    if (decision === "rejected" && !reason.trim()) return setError("Tell the employee why the document is not approved.");
    setBusy(doc.id);
    try {
      await api.reviewEmployeeDocument(doc.id, decision, reason.trim() || undefined);
      setRejecting(null);
      setReason("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the decision.");
    } finally {
      setBusy(null);
    }
  }

  async function openRequiredEditor() {
    setError(null);
    try {
      const r = await api.getRequiredEmployeeDocuments();
      setRequiredPick(r.documentTypes);
      setEditingRequired(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the mandatory documents.");
    }
  }

  async function saveRequired() {
    setError(null);
    try {
      await api.saveRequiredEmployeeDocuments(requiredPick);
      setEditingRequired(false);
      setNotice("Mandatory documents saved. They apply to every employee.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the mandatory documents.");
    }
  }

  const sortedDocs = docs ? [...docs].sort((a, b) => (a.reviewStatus === "pending" ? -1 : 0) - (b.reviewStatus === "pending" ? -1 : 0) || b.createdAt.localeCompare(a.createdAt)) : null;

  return (
    <div className="space-y-6">
      {error && <div className="text-danger text-sm" role="alert">{error}</div>}
      {notice && <div className="text-sm text-accent" role="status">{notice}</div>}

      {checklist && (checklist.requiredCount > 0 || canManage) && (
        <section className="bg-card rounded-card p-5 shadow-sm" aria-label="Mandatory documents">
          <div className="flex items-center justify-between mb-3 gap-3">
            <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
              Mandatory documents{checklist.requiredCount > 0 ? ` · ${checklist.completeCount} of ${checklist.requiredCount} on file` : ""}
            </h2>
            {canManage && !editingRequired && (
              <button type="button" onClick={openRequiredEditor} className="text-xs font-semibold text-accent hover:underline">Choose which</button>
            )}
          </div>
          {checklist.requiredCount === 0 && !editingRequired && <div className="text-sm text-label-tertiary">No document is marked mandatory yet.</div>}
          {!editingRequired && (
            <ul className="flex flex-wrap gap-2">
              {checklist.items.map((i) => (
                <li key={i.documentType} className={`text-xs font-medium rounded-full px-3 py-1 ${CHECKLIST_BADGE[i.status].cls}`} data-testid={`checklist-${i.documentType}`}>
                  {typeLabel(i.documentType, options)} · {CHECKLIST_BADGE[i.status].label}
                  {i.expiryDate && i.status !== "missing" ? ` · until ${formatDay(i.expiryDate)}` : ""}
                </li>
              ))}
            </ul>
          )}
          {editingRequired && (
            <div>
              <p className="text-xs text-label-tertiary mb-2">Every employee is expected to have these on file. This is the Document Policy in HR Administration.</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                {options.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={requiredPick.includes(o.value)}
                      onChange={(e) => setRequiredPick(e.target.checked ? [...requiredPick, o.value] : requiredPick.filter((x) => x !== o.value))}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={saveRequired} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Save</button>
                <button type="button" onClick={() => setEditingRequired(false)} className="text-xs font-medium text-label-tertiary hover:text-label-primary">Cancel</button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="bg-card rounded-card p-5 shadow-sm" aria-label="Documents on file">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Documents on file</h2>
        {sortedDocs === null && <LoadingNote />}
        {sortedDocs && sortedDocs.length === 0 && (
          <div className="text-sm text-label-tertiary">{canManage ? "No documents on this file yet." : "No documents have been placed on your file yet."}</div>
        )}
        {sortedDocs && sortedDocs.length > 0 && (
          <div className="divide-y divide-black/5">
            {sortedDocs.map((doc) => {
              const state = expiryState(doc.expiryDate, today);
              return (
                <div key={doc.id} className="py-3" data-testid={`doc-${doc.id}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
                        <FileText size={16} strokeWidth={1.75} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{doc.fileName}</div>
                        <div className="text-xs text-label-tertiary">
                          {typeLabel(doc.documentType, options)} · {formatBytes(doc.sizeBytes)} · added {formatDay(localDayKey(doc.createdAt))}
                          {doc.expiryDate && (
                            <span className={state === "expired" ? "text-danger font-medium" : state === "soon" ? "text-warning font-medium" : ""}>
                              {" "}· {state === "expired" ? "expired" : "expires"} {formatDay(doc.expiryDate)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {doc.reviewStatus !== "approved" && (
                        <span className={`text-xs font-medium rounded-full px-2.5 py-0.5 ${REVIEW_BADGE[doc.reviewStatus].cls}`}>{REVIEW_BADGE[doc.reviewStatus].label}</span>
                      )}
                      <button type="button" onClick={() => download(doc)} disabled={busy === doc.id} className="flex items-center gap-1.5 text-sm font-medium text-accent hover:text-accent-dark disabled:opacity-50">
                        <Download size={15} strokeWidth={1.75} />
                        Download
                      </button>
                    </div>
                  </div>
                  {doc.note && <div className="text-xs text-label-secondary mt-1 ml-12">{doc.note}</div>}
                  {doc.reviewStatus === "rejected" && doc.reviewNote && <div className="text-xs text-danger mt-1 ml-12">HR: {doc.reviewNote}</div>}
                  {canManage && doc.reviewStatus === "pending" && (
                    <div className="mt-2 ml-12">
                      {rejecting === doc.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input aria-label="Reason" placeholder="Why is it not approved?" value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-black/10 px-3 py-1.5 text-sm flex-1 min-w-48" />
                          <button type="button" onClick={() => decide(doc, "rejected")} disabled={busy === doc.id} className="text-xs font-semibold text-danger hover:underline">Reject</button>
                          <button type="button" onClick={() => { setRejecting(null); setReason(""); }} className="text-xs font-medium text-label-tertiary">Cancel</button>
                        </div>
                      ) : (
                        <div className="flex gap-4">
                          <button type="button" onClick={() => decide(doc, "approved")} disabled={busy === doc.id} className="text-xs font-semibold text-accent hover:underline">Approve</button>
                          <button type="button" onClick={() => { setRejecting(doc.id); setReason(""); }} className="text-xs font-semibold text-danger hover:underline">Reject</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {(canManage || own) && (
        <section className="bg-card rounded-card p-5 shadow-sm" aria-label="Add a document">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">{canManage ? "Add a document" : "Upload a document for HR"}</h2>
          <form onSubmit={upload} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="doc-type" className="block text-xs font-medium mb-1">Document type</label>
              <select id="doc-type" value={uploadType} onChange={(e) => setUploadType(e.target.value)} className={field}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="doc-expiry" className="block text-xs font-medium mb-1">Expires on <span className="text-label-tertiary font-normal">(if it does)</span></label>
              <input id="doc-expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={field} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="doc-file" className="block text-xs font-medium mb-1">File <span className="text-label-tertiary font-normal">(PDF, image, Word or Excel, up to 10 MB)</span></label>
              <input id="doc-file" ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="doc-note" className="block text-xs font-medium mb-1">Note <span className="text-label-tertiary font-normal">(optional)</span></label>
              <input id="doc-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={field} />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" disabled={uploading} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
                {uploading ? "Uploading…" : canManage ? "Add document" : "Upload for HR to check"}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
