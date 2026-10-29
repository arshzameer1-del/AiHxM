import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { DataSubjectRequestView, EmployeeServiceRequestKind, EmployeeServiceRequestStatus, EmployeeServiceRequestView, RequestableLoanTypeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";
import { PageHeader, LoadingNote } from "../shared/PageChrome";
import { formatDateTime, formatDay, todayIso } from "../shared/dates";
import { DSR_BADGE, DSR_LABELS, STATUS_BADGE, requestTitle } from "./serviceRequests";

const field = "w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

type Tab = "loans" | "letters" | "privacy";
const TABS: { key: Tab; label: string }[] = [
  { key: "loans", label: "Loans and advances" },
  { key: "letters", label: "Letters and certificates" },
  { key: "privacy", label: "Privacy requests" },
];
const FILTERS: { key: EmployeeServiceRequestStatus | "all"; label: string }[] = [
  { key: "pending", label: "Waiting" },
  { key: "fulfilled", label: "Done" },
  { key: "rejected", label: "Not approved" },
  { key: "all", label: "All" },
];
const LOAN_KINDS: EmployeeServiceRequestKind[] = ["loan", "salary_advance"];
const LETTER_KINDS: EmployeeServiceRequestKind[] = ["letter"];
const todayKey = () => todayIso();

/**
 * BACKLOG52 - HR's queue for what employees ask: loans and advances (approving creates the real loan), letters and
 * certificates (generate the salary certificate or upload the signed letter), and privacy requests.
 */
export function EmployeeRequestsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "letters" ? "letters" : params.get("tab") === "privacy" ? "privacy" : "loans";
  const [filter, setFilter] = useState<EmployeeServiceRequestStatus | "all">("pending");

  return (
    <div data-testid="employee-requests">
      <PageHeader
        title="Employee Requests"
        subtitle="Loans, salary advances, letters, certificates and privacy requests that employees sent you."
        actions={<Link to="/app/employees/change-requests" className="text-sm font-semibold text-accent hover:underline">Change requests</Link>}
      />
      <div className="flex flex-wrap gap-2 mb-3" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === t.key ? "bg-accent text-white" : "bg-black/5"}`}>{t.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`px-2.5 py-1 rounded-full text-xs font-medium ${filter === f.key ? "bg-label-primary text-white" : "bg-black/5"}`}>{f.label}</button>
        ))}
      </div>
      {tab === "privacy" ? <PrivacyQueue filter={filter} /> : <ServiceQueue key={tab} kinds={tab === "loans" ? LOAN_KINDS : LETTER_KINDS} filter={filter} />}
    </div>
  );
}

function ServiceQueue({ kinds, filter }: { kinds: EmployeeServiceRequestKind[]; filter: EmployeeServiceRequestStatus | "all" }) {
  const [items, setItems] = useState<EmployeeServiceRequestView[] | null>(null);
  const [types, setTypes] = useState<RequestableLoanTypeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setItems(null);
    Promise.all(kinds.map((k) => api.listEmployeeServiceRequests(filter, k)))
      .then((all) => setItems(all.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
      .catch((err) => { setItems([]); setError(err instanceof ApiError ? err.message : "Could not load the requests."); });
  }, [filter, kinds]);
  useEffect(load, [load]);
  useEffect(() => {
    if (kinds.includes("loan")) api.listRequestableLoanTypes().then(setTypes).catch(() => setTypes([]));
  }, [kinds]);

  if (error) return <div className="text-sm text-danger" role="alert">{error}</div>;
  if (!items) return <LoadingNote what="requests" />;
  if (items.length === 0) return <p className="text-sm text-label-tertiary" data-testid="queue-empty">Nothing here.</p>;
  return (
    <div className="space-y-3">
      {items.map((r) => <ServiceCard key={r.id} r={r} types={types} onChanged={load} />)}
    </div>
  );
}

function ServiceCard({ r, types, onChanged }: { r: EmployeeServiceRequestView; types: RequestableLoanTypeView[]; onChanged: () => void }) {
  const [action, setAction] = useState<null | "approve" | "reject" | "upload">(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(r.amount ? String(r.amount) : "");
  const [count, setCount] = useState(r.installmentsCount ? String(r.installmentsCount) : "");
  const [typeId, setTypeId] = useState(r.loanTypeId ?? "");
  const [issued, setIssued] = useState(todayKey());
  const [start, setStart] = useState("");
  const [guarantor, setGuarantor] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const badge = STATUS_BADGE[r.status];
  const choices = types.filter((t) => t.kind === r.kind);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setAction(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not do that.");
    } finally {
      setBusy(false);
    }
  }
  const approve = (e: FormEvent) => {
    e.preventDefault();
    return run(() =>
      api.approveEmployeeLoanRequest(r.id, {
        principalAmount: Number(amount) || undefined,
        installmentsCount: Number(count) || undefined,
        loanTypeId: typeId || undefined,
        issuedDate: issued || undefined,
        deductionStartDate: start || undefined,
        guarantorEmployeeId: guarantor.trim() || undefined,
        note: note.trim() || undefined,
      })
    );
  };
  const reject = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return setError("Tell the employee why it is not approved.");
    return run(() => api.rejectEmployeeServiceRequest(r.id, note.trim()));
  };
  const upload = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError("Choose the signed letter first.");
    return run(() => api.issueLetterForRequest(r.id, file, note.trim() || undefined));
  };

  return (
    <div className="bg-card rounded-card p-4 shadow-sm" data-testid="queue-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{requestTitle(r)}{r.loanTypeName ? ` · ${r.loanTypeName}` : ""}</div>
          <div className="text-xs text-label-tertiary mt-0.5">
            <Link className="text-accent hover:underline" to={`/app/employees/${r.employeeId}`}><EmployeeAvatar employeeId={r.employeeId} name={r.employeeName} size="xs" className="mr-1.5 align-middle" />{r.employeeNumber} · {r.employeeName}</Link> · sent {formatDateTime(r.createdAt)}
            {r.neededBy ? ` · needed by ${formatDay(r.neededBy)}` : ""}
          </div>
          <div className="text-sm mt-1">{r.purpose}</div>
          {r.addressedTo && <div className="text-xs text-label-tertiary mt-0.5">Addressed to: {r.addressedTo}</div>}
          {r.installmentsCount && <div className="text-xs text-label-tertiary mt-0.5">Wants to pay back over {r.installmentsCount} months</div>}
          {r.decisionNote && <div className="text-xs mt-1">Note: {r.decisionNote}</div>}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.cls}`}>{badge.label}</span>
      </div>

      {r.status === "pending" && !action && (
        <div className="flex flex-wrap gap-2 mt-3">
          {r.kind !== "letter" && <button className={btn} onClick={() => setAction("approve")}>Approve and create loan</button>}
          {r.letterType === "salary_certificate" && (
            <button className={btn} disabled={busy} onClick={() => run(() => api.issueSalaryCertificateForRequest(r.id))}>{busy ? "Working…" : "Generate and issue from payroll"}</button>
          )}
          {r.kind === "letter" && <button className={r.letterType === "salary_certificate" ? quiet : btn} onClick={() => setAction("upload")}>Upload signed letter</button>}
          <button className={quiet} onClick={() => setAction("reject")}>Not approve</button>
        </div>
      )}

      {action === "approve" && (
        <form onSubmit={approve} className="mt-3 grid sm:grid-cols-3 gap-3" aria-label="Approve loan">
          <label className="text-xs">Amount<input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label className="text-xs">Instalments<input className={field} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></label>
          <label className="text-xs">Type
            <select className={field} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">No type</option>
              {choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="text-xs">Issue date<input type="date" className={field} value={issued} onChange={(e) => setIssued(e.target.value)} /></label>
          <label className="text-xs">First deduction (optional)<input type="date" className={field} value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="text-xs">Guarantor employee ID (if the type needs one)<input className={field} value={guarantor} onChange={(e) => setGuarantor(e.target.value)} /></label>
          <label className="text-xs sm:col-span-3">Note to the employee (optional)<input className={field} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="sm:col-span-3 flex gap-2">
            <button type="submit" className={btn} disabled={busy}>{busy ? "Creating…" : "Create the loan"}</button>
            <button type="button" className={quiet} onClick={() => setAction(null)}>Cancel</button>
          </div>
        </form>
      )}
      {action === "reject" && (
        <form onSubmit={reject} className="mt-3 flex flex-wrap gap-2 items-end" aria-label="Reject request">
          <label className="text-xs flex-1 min-w-[14rem]">Reason the employee will see<input className={field} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button type="submit" className={btn} disabled={busy}>Not approve</button>
          <button type="button" className={quiet} onClick={() => setAction(null)}>Cancel</button>
        </form>
      )}
      {action === "upload" && (
        <form onSubmit={upload} className="mt-3 flex flex-wrap gap-2 items-end" aria-label="Upload letter">
          <label className="text-xs">Signed letter (PDF or image)
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" className="block text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="text-xs flex-1 min-w-[12rem]">Note (optional)<input className={field} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button type="submit" className={btn} disabled={busy}>{busy ? "Uploading…" : "Issue letter"}</button>
          <button type="button" className={quiet} onClick={() => setAction(null)}>Cancel</button>
        </form>
      )}
      {error && <div className="text-xs text-danger mt-2" role="alert">{error}</div>}
    </div>
  );
}

function PrivacyQueue({ filter }: { filter: EmployeeServiceRequestStatus | "all" }) {
  const [items, setItems] = useState<DataSubjectRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const mapped = filter === "pending" ? undefined : filter === "fulfilled" ? "fulfilled" : filter === "rejected" ? "rejected" : undefined;

  const load = useCallback(() => {
    api.listDataSubjectRequests(mapped)
      .then((all) => setItems(filter === "pending" ? all.filter((r) => r.status === "pending" || r.status === "approved") : all))
      .catch((err) => { setItems([]); setError(err instanceof ApiError ? err.message : "Could not load the requests."); });
  }, [filter, mapped]);
  useEffect(() => { setItems(null); load(); }, [load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setRowError((e) => ({ ...e, [id]: "" }));
    try {
      await fn();
      setText((t) => ({ ...t, [id]: "" }));
      load();
    } catch (err) {
      setRowError((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Could not do that." }));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="text-sm text-danger" role="alert">{error}</div>;
  if (!items) return <LoadingNote what="privacy requests" />;
  if (items.length === 0) return <p className="text-sm text-label-tertiary" data-testid="queue-empty">Nothing here.</p>;
  return (
    <div className="space-y-3">
      {items.map((r) => {
        const badge = DSR_BADGE[r.status];
        const t = text[r.id] ?? "";
        return (
          <div key={r.id} className="bg-card rounded-card p-4 shadow-sm" data-testid="privacy-card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{DSR_LABELS[r.requestType]}</div>
                <div className="text-xs text-label-tertiary mt-0.5">
                  <Link className="text-accent hover:underline" to={`/app/employees/${r.employeeId}`}><EmployeeAvatar employeeId={r.employeeId} name={r.employeeName} size="xs" className="mr-1.5 align-middle" />{r.employeeNumber} · {r.employeeName}</Link> · sent {formatDateTime(r.createdAt)}{r.isOnBehalf ? " · filed by HR" : ""}
                </div>
                <div className="text-sm mt-1">{r.description}</div>
                {r.decisionComment && <div className="text-xs mt-1">Decision: {r.decisionComment}</div>}
                {r.fulfillmentNote && <div className="text-xs mt-1">Done: {r.fulfillmentNote}</div>}
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.cls}`}>{badge.label}</span>
            </div>
            {(r.status === "pending" || r.status === "approved") && (
              <div className="flex flex-wrap gap-2 mt-3 items-end">
                <label className="text-xs flex-1 min-w-[14rem]">{r.status === "pending" ? "Comment (needed to refuse)" : "What was done"}
                  <input className={field} value={t} onChange={(e) => setText((x) => ({ ...x, [r.id]: e.target.value }))} />
                </label>
                {r.status === "pending" ? (
                  <>
                    <button className={btn} disabled={busy === r.id} onClick={() => act(r.id, () => api.decideDataSubjectRequest(r.id, "approved", t.trim() || undefined))}>Approve</button>
                    <button className={quiet} disabled={busy === r.id} onClick={() => (t.trim() ? act(r.id, () => api.decideDataSubjectRequest(r.id, "rejected", t.trim())) : setRowError((e) => ({ ...e, [r.id]: "Tell the employee why it is not approved." })))}>Not approve</button>
                  </>
                ) : (
                  <button className={btn} disabled={busy === r.id} onClick={() => (t.trim() ? act(r.id, () => api.fulfillDataSubjectRequest(r.id, t.trim())) : setRowError((e) => ({ ...e, [r.id]: "Write what was done, for the record." })))}>Mark completed</button>
                )}
              </div>
            )}
            {rowError[r.id] && <div className="text-xs text-danger mt-2" role="alert">{rowError[r.id]}</div>}
          </div>
        );
      })}
    </div>
  );
}
