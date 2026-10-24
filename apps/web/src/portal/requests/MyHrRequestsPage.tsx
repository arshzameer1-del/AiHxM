import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  DataSubjectRequestType,
  DataSubjectRequestView,
  EmployeeServiceRequestKind,
  EmployeeServiceRequestView,
  GeneratedDocumentView,
  RequestableLoanTypeView,
} from "@aihxm/shared-types";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError } from "../../api/client";
import { PageHeader, LoadingNote } from "../shared/PageChrome";
import { formatDateTime, formatDay } from "../shared/dates";
import { DocumentViewer } from "../payroll/PayrollDocumentsPanels";
import {
  DSR_BADGE, DSR_LABELS, LETTER_LABELS, STATUS_BADGE,
  buildServiceRequest, emptyRequestForm, requestFormProblem, requestTitle, type RequestFormValues,
} from "./serviceRequests";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";

type Mode = "loan" | "letter" | "privacy";
type Row =
  | { type: "service"; at: string; r: EmployeeServiceRequestView }
  | { type: "privacy"; at: string; r: DataSubjectRequestView };

/**
 * BACKLOG52 - "My HR Requests": ask HR for a loan or salary advance, a letter or certificate, or exercise a privacy right
 * over your own data, and follow what HR answered. One list for all of it.
 */
export function MyHrRequestsPage() {
  const { identity } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get("new");
  const [mode, setMode] = useState<Mode | null>(requested === "loan" || requested === "letter" || requested === "privacy" ? requested : null);
  const [service, setService] = useState<EmployeeServiceRequestView[] | null>(null);
  const [privacy, setPrivacy] = useState<DataSubjectRequestView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<GeneratedDocumentView | null>(null);

  const load = useCallback(() => {
    api.listMyServiceRequests().then(setService).catch(() => setService([]));
    api.listMyDataSubjectRequests().then(setPrivacy).catch(() => setPrivacy([]));
  }, []);
  useEffect(load, [load]);

  const rows: Row[] = useMemo(
    () =>
      [
        ...(service ?? []).map((r): Row => ({ type: "service", at: r.createdAt, r })),
        ...(privacy ?? []).map((r): Row => ({ type: "privacy", at: r.createdAt, r })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [service, privacy]
  );

  function open(next: Mode | null) {
    setMode(next);
    setNotice(null);
    const p = new URLSearchParams(params);
    if (next) p.set("new", next);
    else p.delete("new");
    setParams(p, { replace: true });
  }

  async function withdraw(id: string) {
    setError(null);
    try {
      await api.cancelEmployeeServiceRequest(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not withdraw the request.");
    }
  }

  async function openCertificate(id: string) {
    setError(null);
    try {
      setViewing(await api.getPayrollDocument(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the certificate.");
    }
  }

  async function downloadLetter(documentId: string) {
    setError(null);
    try {
      const employeeId = identity?.employeeId;
      if (!employeeId) throw new ApiError(400, "Your login is not linked to an employee record.");
      const docs = await api.listEmployeeDocuments(employeeId);
      const doc = docs.find((d) => d.id === documentId);
      if (!doc) throw new ApiError(404, "The letter is not on your file any more.");
      await api.downloadEmployeeDocument(employeeId, doc.id, doc.fileName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download the letter.");
    }
  }

  return (
    <div data-testid="my-hr-requests">
      <PageHeader title="My HR Requests" subtitle="Ask HR for a loan, an advance, a letter or a certificate, or about your personal data. You are told here and in the bell when HR answers." />
      <div className="flex flex-wrap gap-2 mb-5">
        <button className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium" onClick={() => open("loan")}>Loan or salary advance</button>
        <button className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium" onClick={() => open("letter")}>Letter or certificate</button>
        <button className="px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium" onClick={() => open("privacy")}>Privacy request</button>
      </div>
      {notice && <div className="text-sm text-accent mb-3" role="status">{notice}</div>}
      {error && <div className="text-sm text-danger mb-3" role="alert">{error}</div>}
      {mode === "privacy" ? (
        <PrivacyForm employeeId={identity?.employeeId ?? null} onClose={() => open(null)} onSent={() => { open(null); setNotice("Your privacy request was sent to HR."); load(); }} />
      ) : mode ? (
        <RequestForm key={mode} kind={mode === "loan" ? "loan" : "letter"} onClose={() => open(null)} onSent={() => { open(null); setNotice("Your request was sent to HR."); load(); }} />
      ) : null}

      <section aria-label="My requests" className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">My requests</h2>
        {service === null || privacy === null ? (
          <LoadingNote what="your requests" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-label-tertiary" data-testid="no-requests">You have not sent HR any requests yet.</p>
        ) : (
          <div className="divide-y divide-black/5">
            {rows.map((row) =>
              row.type === "service" ? (
                <ServiceRow key={row.r.id} r={row.r} onWithdraw={() => withdraw(row.r.id)} onCertificate={openCertificate} onLetter={downloadLetter} />
              ) : (
                <PrivacyRow key={row.r.id} r={row.r} />
              )
            )}
          </div>
        )}
      </section>
      {viewing && <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function ServiceRow({ r, onWithdraw, onCertificate, onLetter }: {
  r: EmployeeServiceRequestView; onWithdraw: () => void; onCertificate: (id: string) => void; onLetter: (id: string) => void;
}) {
  const badge = STATUS_BADGE[r.status];
  return (
    <div className="py-3 flex items-start justify-between gap-3" data-testid="service-request-row">
      <div className="min-w-0">
        <div className="text-sm font-medium">{requestTitle(r)}</div>
        <div className="text-xs text-label-tertiary mt-0.5">
          {r.purpose} · sent {formatDateTime(r.createdAt)}
          {r.neededBy ? ` · needed by ${formatDay(r.neededBy)}` : ""}
        </div>
        {r.decisionNote && <div className="text-xs mt-1">HR: {r.decisionNote}</div>}
        {r.status === "fulfilled" && r.loanId && <div className="text-xs mt-1 text-accent">HR approved this and set up the loan. Instalments are deducted from your pay.</div>}
        <div className="flex gap-3 mt-1">
          {r.generatedDocumentId && <button className="text-xs font-medium text-accent hover:underline" onClick={() => onCertificate(r.generatedDocumentId!)}>Open certificate</button>}
          {r.employeeDocumentId && <button className="text-xs font-medium text-accent hover:underline" onClick={() => onLetter(r.employeeDocumentId!)}>Download letter</button>}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
        {r.status === "pending" && <button onClick={onWithdraw} className="text-xs font-medium text-label-tertiary hover:text-danger">Withdraw</button>}
      </div>
    </div>
  );
}

function PrivacyRow({ r }: { r: DataSubjectRequestView }) {
  const badge = DSR_BADGE[r.status];
  return (
    <div className="py-3 flex items-start justify-between gap-3" data-testid="privacy-request-row">
      <div className="min-w-0">
        <div className="text-sm font-medium">Privacy request: {DSR_LABELS[r.requestType]}</div>
        <div className="text-xs text-label-tertiary mt-0.5">{r.description} · sent {formatDateTime(r.createdAt)}</div>
        {r.decisionComment && <div className="text-xs mt-1">HR: {r.decisionComment}</div>}
        {r.fulfillmentNote && <div className="text-xs mt-1">Done: {r.fulfillmentNote}</div>}
      </div>
      <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.cls}`}>{badge.label}</span>
    </div>
  );
}

function RequestForm({ kind, onClose, onSent }: { kind: EmployeeServiceRequestKind; onClose: () => void; onSent: () => void }) {
  const [v, setV] = useState<RequestFormValues>(emptyRequestForm(kind));
  const [types, setTypes] = useState<RequestableLoanTypeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof RequestFormValues>(key: K, value: RequestFormValues[K]) => setV((x) => ({ ...x, [key]: value }));

  useEffect(() => {
    if (kind !== "letter") api.listRequestableLoanTypes().then(setTypes).catch(() => setTypes([]));
  }, [kind]);
  const typeChoices = types.filter((t) => t.kind === v.kind);
  const chosen = typeChoices.find((t) => t.id === v.loanTypeId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = requestFormProblem(v);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.submitEmployeeServiceRequest(buildServiceRequest(v));
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-card rounded-card p-5 shadow-sm mb-5 space-y-3" aria-label={kind === "letter" ? "Request a letter" : "Request a loan or advance"}>
      <h2 className="font-semibold text-sm">{kind === "letter" ? "Request a letter or certificate" : "Request a loan or salary advance"}</h2>
      {kind === "letter" ? (
        <>
          <div>
            <label htmlFor="req-letter-type" className={label}>Which letter?</label>
            <select id="req-letter-type" className={field} value={v.letterType} onChange={(e) => set("letterType", e.target.value as RequestFormValues["letterType"])}>
              {Object.entries(LETTER_LABELS).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="req-addressed" className={label}>Addressed to (optional)</label>
            <input id="req-addressed" className={field} value={v.addressedTo} maxLength={200} placeholder="e.g. HBL, Gulberg Branch" onChange={(e) => set("addressedTo", e.target.value)} />
          </div>
        </>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="req-kind" className={label}>What do you need?</label>
              <select id="req-kind" className={field} value={v.kind} onChange={(e) => setV((x) => ({ ...x, kind: e.target.value as EmployeeServiceRequestKind, loanTypeId: "" }))}>
                <option value="loan">Loan</option>
                <option value="salary_advance">Salary advance</option>
              </select>
            </div>
            <div>
              <label htmlFor="req-type" className={label}>Type (optional)</label>
              <select id="req-type" className={field} value={v.loanTypeId} onChange={(e) => set("loanTypeId", e.target.value)}>
                <option value="">HR will choose</option>
                {typeChoices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="req-amount" className={label}>Amount (PKR)</label>
              <input id="req-amount" className={field} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} />
            </div>
            <div>
              <label htmlFor="req-installments" className={label}>Pay back over (months, optional)</label>
              <input id="req-installments" className={field} inputMode="numeric" value={v.installments} onChange={(e) => set("installments", e.target.value)} />
            </div>
          </div>
          {chosen && (chosen.maxInstallments || chosen.requiresGuarantor || chosen.description) && (
            <p className="text-xs text-label-tertiary">
              {chosen.description ? `${chosen.description} ` : ""}
              {chosen.maxInstallments ? `Up to ${chosen.maxInstallments} instalments. ` : ""}
              {chosen.requiresGuarantor ? "HR will ask you for a guarantor." : ""}
            </p>
          )}
        </>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label htmlFor="req-purpose" className={label}>Why do you need it?</label>
          <textarea id="req-purpose" className={field} rows={3} maxLength={1000} value={v.purpose} onChange={(e) => set("purpose", e.target.value)} />
        </div>
        <div>
          <label htmlFor="req-needed" className={label}>Needed by (optional)</label>
          <input id="req-needed" type="date" className={field} value={v.neededBy} onChange={(e) => set("neededBy", e.target.value)} />
        </div>
      </div>
      {error && <div className="text-xs text-danger" role="alert">{error}</div>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">{busy ? "Sending…" : "Send to HR"}</button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium">Cancel</button>
      </div>
    </form>
  );
}

function PrivacyForm({ employeeId, onClose, onSent }: { employeeId: string | null; onClose: () => void; onSent: () => void }) {
  const [type, setType] = useState<DataSubjectRequestType>("access");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!employeeId) return setError("Your login is not linked to an employee record.");
    if (!description.trim()) return setError("Describe what you are asking for.");
    setBusy(true);
    setError(null);
    try {
      await api.submitDataSubjectRequest({ employeeId, requestType: type, description: description.trim() });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-card rounded-card p-5 shadow-sm mb-5 space-y-3" aria-label="Privacy request">
      <h2 className="font-semibold text-sm">Privacy request about my personal data</h2>
      <div>
        <label htmlFor="dsr-type" className={label}>What do you want?</label>
        <select id="dsr-type" className={field} value={type} onChange={(e) => setType(e.target.value as DataSubjectRequestType)}>
          {Object.entries(DSR_LABELS).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="dsr-description" className={label}>Details</label>
        <textarea id="dsr-description" className={field} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {type === "deletion" && <p className="text-xs text-label-tertiary">Some records, such as payroll and tax, must be kept by law. HR will tell you what can be removed.</p>}
      {error && <div className="text-xs text-danger" role="alert">{error}</div>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50">{busy ? "Sending…" : "Send to HR"}</button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium">Cancel</button>
      </div>
    </form>
  );
}
