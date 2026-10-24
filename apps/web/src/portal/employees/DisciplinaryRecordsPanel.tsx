import { FormEvent, useCallback, useEffect, useState } from "react";
import type { DisciplinaryRecordType, EmployeeDisciplinaryRecordView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatDay } from "../shared/dates";
import { LoadingNote } from "../shared/PageChrome";
import { DISCIPLINARY_TYPES, disciplinaryProblem, typeLabel, waitingForAcknowledgement } from "./sensitiveRecords";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";

/**
 * BACKLOG54 - disciplinary records. `mode="hr"`: HR (hr_admin) issues and withdraws them. `mode="self"`: the employee
 * reads their own and acknowledges each one, with an optional comment. Records are never deleted.
 */
export function DisciplinaryRecordsPanel({ employeeId, mode }: { employeeId: string; mode: "hr" | "self" }) {
  const [rows, setRows] = useState<EmployeeDisciplinaryRecordView[] | null>(null);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [form, setForm] = useState({ recordType: "written_warning" as DisciplinaryRecordType, subject: "", description: "", incidentDate: "", issuedDate: "", actionTaken: "" });
  const [acting, setActing] = useState<{ id: string; kind: "withdraw" | "acknowledge" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.listEmployeeDisciplinaryRecords(employeeId).then(setRows).catch((err) => {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setRefused(true);
      else setError("Could not load the records.");
    });
  }, [employeeId]);
  useEffect(load, [load]);

  async function issue(e: FormEvent) {
    e.preventDefault();
    const problem = disciplinaryProblem(form);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.createEmployeeDisciplinaryRecord({
        employeeId,
        recordType: form.recordType,
        subject: form.subject.trim(),
        description: form.description.trim(),
        incidentDate: form.incidentDate || null,
        issuedDate: form.issuedDate || null,
        actionTaken: form.actionTaken.trim() || null,
      });
      setIssuing(false);
      setForm({ ...form, subject: "", description: "", incidentDate: "", issuedDate: "", actionTaken: "" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not issue the record.");
    } finally {
      setBusy(false);
    }
  }

  async function act(e: FormEvent) {
    e.preventDefault();
    if (!acting) return;
    if (acting.kind === "withdraw" && note.trim().length < 2) return setError("Say why it is being withdrawn.");
    setBusy(true);
    setError(null);
    try {
      if (acting.kind === "withdraw") await api.withdrawEmployeeDisciplinaryRecord(acting.id, note.trim());
      else await api.acknowledgeEmployeeDisciplinaryRecord(acting.id, note.trim() || undefined);
      setActing(null);
      setNote("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (refused) return null;
  const waiting = rows ? waitingForAcknowledgement(rows).length : 0;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" aria-label="Disciplinary records" data-testid="disciplinary-panel">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Disciplinary records</h2>
        {mode === "hr" && !issuing && <button type="button" onClick={() => { setIssuing(true); setError(null); }} className="text-xs font-semibold text-accent hover:underline">Issue a record</button>}
      </div>
      <p className="text-xs text-label-tertiary mb-3">Private. Only {mode === "self" ? "you and HR" : "HR and the employee"} can see these.</p>
      {mode === "self" && waiting > 0 && (
        <div className="rounded-lg bg-warning/10 text-sm px-3 py-2 mb-3" role="status" data-testid="disciplinary-waiting">
          {waiting === 1 ? "1 record is waiting for you to read and acknowledge it." : `${waiting} records are waiting for you to read and acknowledge them.`}
        </div>
      )}
      {error && <div className="text-danger text-xs mb-2" role="alert">{error}</div>}
      {!rows && !error && <LoadingNote />}
      {rows && rows.length === 0 && !issuing && <p className="text-sm text-label-tertiary">No records.</p>}

      {issuing && (
        <form onSubmit={issue} className="space-y-3 mb-4 border border-black/10 rounded-lg p-3" data-testid="disciplinary-form">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="dis-type" className={label}>Type</label>
              <select id="dis-type" value={form.recordType} onChange={(e) => setForm({ ...form, recordType: e.target.value as DisciplinaryRecordType })} className={field}>
                {DISCIPLINARY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="dis-incident" className={label}>Date of the incident</label>
              <input id="dis-incident" type="date" value={form.incidentDate} onChange={(e) => setForm({ ...form, incidentDate: e.target.value })} className={field} />
            </div>
            <div>
              <label htmlFor="dis-issued" className={label}>Issued on (today if empty)</label>
              <input id="dis-issued" type="date" value={form.issuedDate} onChange={(e) => setForm({ ...form, issuedDate: e.target.value })} className={field} />
            </div>
          </div>
          <div>
            <label htmlFor="dis-subject" className={label}>Subject</label>
            <input id="dis-subject" value={form.subject} maxLength={200} onChange={(e) => setForm({ ...form, subject: e.target.value })} className={field} />
          </div>
          <div>
            <label htmlFor="dis-description" className={label}>What happened</label>
            <textarea id="dis-description" rows={3} maxLength={4000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={field} />
          </div>
          <div>
            <label htmlFor="dis-action" className={label}>Action taken</label>
            <textarea id="dis-action" rows={2} maxLength={2000} value={form.actionTaken} onChange={(e) => setForm({ ...form, actionTaken: e.target.value })} className={field} />
          </div>
          <p className="text-xs text-label-tertiary">The employee is told in their inbox and asked to acknowledge it.</p>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy ? "Saving…" : "Issue record"}</button>
            <button type="button" onClick={() => setIssuing(false)} className="text-xs font-medium text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </form>
      )}

      {rows && rows.length > 0 && (
        <ul className="divide-y divide-black/5">
          {rows.map((r) => (
            <li key={r.id} className="py-3 text-sm" data-testid="disciplinary-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.subject}</span>
                <span className="text-xs rounded-full bg-black/5 px-2 py-0.5">{typeLabel(r.recordType)}</span>
                {r.status === "withdrawn" && <span className="text-xs rounded-full bg-black/5 text-label-tertiary px-2 py-0.5">Withdrawn</span>}
                {r.acknowledgedAt ? <span className="text-xs text-label-tertiary">Acknowledged {formatDay(r.acknowledgedAt.slice(0, 10))}</span> : r.status === "active" && <span className="text-xs text-warning">Not acknowledged yet</span>}
              </div>
              <div className="text-xs text-label-tertiary mt-0.5">
                Issued {formatDay(r.issuedDate)}{r.issuedByName ? ` by ${r.issuedByName}` : ""}{r.incidentDate ? ` · incident on ${formatDay(r.incidentDate)}` : ""}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{r.description}</p>
              {r.actionTaken && <p className="mt-1 text-label-secondary"><span className="font-medium">Action taken:</span> {r.actionTaken}</p>}
              {r.employeeComment && <p className="mt-1 text-label-secondary"><span className="font-medium">Employee&apos;s comment:</span> {r.employeeComment}</p>}
              {r.withdrawnReason && <p className="mt-1 text-label-secondary"><span className="font-medium">Withdrawn because:</span> {r.withdrawnReason}</p>}
              {acting?.id === r.id ? (
                <form onSubmit={act} className="mt-2 space-y-2">
                  <label htmlFor={`dis-note-${r.id}`} className={label}>{acting.kind === "withdraw" ? "Why is it being withdrawn?" : "Your comment (optional)"}</label>
                  <textarea id={`dis-note-${r.id}`} rows={2} maxLength={acting.kind === "withdraw" ? 1000 : 2000} value={note} onChange={(e) => setNote(e.target.value)} className={field} />
                  <div className="flex gap-3">
                    <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{acting.kind === "withdraw" ? "Withdraw record" : "Acknowledge"}</button>
                    <button type="button" onClick={() => { setActing(null); setNote(""); }} className="text-xs font-medium text-label-tertiary hover:text-label-primary">Cancel</button>
                  </div>
                </form>
              ) : (
                <div className="mt-2 flex gap-4">
                  {mode === "self" && r.status === "active" && !r.acknowledgedAt && (
                    <button type="button" onClick={() => { setActing({ id: r.id, kind: "acknowledge" }); setNote(""); setError(null); }} className="text-xs font-semibold text-accent hover:underline">Acknowledge</button>
                  )}
                  {mode === "hr" && r.status === "active" && (
                    <button type="button" onClick={() => { setActing({ id: r.id, kind: "withdraw" }); setNote(""); setError(null); }} className="text-xs font-semibold text-danger hover:underline">Withdraw</button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
