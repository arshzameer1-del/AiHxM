import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type { EmployeeLoanView, EmployeeView, LoanScheduleRowView, LoanTypeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatDay } from "../shared/dates";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });
const pkr2 = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const LOAN_TYPE_LABEL: Record<string, string> = { loan: "Loan", salary_advance: "Salary Advance" };
const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Awaiting approval",
  active: "Active",
  on_hold: "On hold",
  closed: "Closed",
  cancelled: "Cancelled",
  rejected: "Rejected",
};
const ROW_LABEL: Record<string, string> = { scheduled: "Scheduled", held: "Held", skipped: "Skipped", paid: "Paid", settled: "Settled", cancelled: "Cancelled" };

/**
 * Payroll Enterprise Gap Analysis Phase P3 (0112) and gap register PAY-13 - loans and salary advances on the employee's
 * own profile, with the approved repayment schedule payroll recovers from. Payroll only READS this data when it
 * calculates and commits the ledger when a run is finalised; every write here goes through `EmployeeLoansService`.
 */
export function EmployeeLoansPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [loans, setLoans] = useState<EmployeeLoanView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  function load() {
    api
      .listEmployeeLoans(employeeId)
      .then(setLoans)
      .catch((err) => setLoadError(errorMessage(err, "Could not load loans / advances.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  async function handleCancel(id: string) {
    try {
      await api.cancelEmployeeLoan(id);
      load();
    } catch (err) {
      setLoadError(errorMessage(err, "Could not cancel this loan."));
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Loans &amp; Salary Advances</h2>
        {canManage && (
          <button type="button" onClick={() => setShowForm((s) => !s)} className="text-xs font-semibold text-accent hover:underline">
            {showForm ? "Cancel" : "+ New loan / advance"}
          </button>
        )}
      </div>

      {loadError && <p className="text-xs text-danger mb-2">{loadError}</p>}

      {showForm && (
        <NewLoanForm
          employeeId={employeeId}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {!loans ? (
        <LoadingNote />
      ) : loans.length === 0 ? (
        <p className="text-sm text-label-tertiary">No loans or salary advances on record.</p>
      ) : (
        <div className="space-y-2">
          {loans.map((loan) => (
            <div key={loan.id} className="bg-black/5 rounded-lg px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    {loan.loanTypeName ?? LOAN_TYPE_LABEL[loan.loanType] ?? loan.loanType}
                    {loan.reason && <span className="text-label-tertiary"> — {loan.reason}</span>}
                  </div>
                  <div className="text-xs text-label-tertiary">
                    Issued {formatDay(loan.issuedDate)} · Installment {pkr2.format(loan.installmentAmount)}
                    {loan.installmentsCount ? ` × ${loan.installmentsCount}` : ""} · Status:{" "}
                    <span className="font-semibold">{STATUS_LABEL[loan.status] ?? loan.status}</span>
                    {loan.status === "on_hold" && loan.holdReason ? ` (${loan.holdReason})` : ""}
                    {loan.settlementRequested ? " · Settling in the next payroll run" : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-mono font-semibold">{pkr.format(loan.outstandingBalance)}</div>
                    <div className="text-xs text-label-tertiary">of {pkr.format(loan.principalAmount)}</div>
                  </div>
                  <button type="button" onClick={() => setOpenId(openId === loan.id ? null : loan.id)} className="text-xs font-semibold text-accent hover:underline">
                    {openId === loan.id ? "Hide" : "Schedule"}
                  </button>
                  {canManage && ["active", "on_hold", "pending_approval"].includes(loan.status) && (
                    <button type="button" onClick={() => handleCancel(loan.id)} className="text-xs font-semibold text-danger hover:underline">
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              {openId === loan.id && <LoanDetail loan={loan} canManage={canManage} onChanged={load} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LoanDetail({ loan, canManage, onChanged }: { loan: EmployeeLoanView; canManage: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<LoanScheduleRowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [resumeFrom, setResumeFrom] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  const [cashDate, setCashDate] = useState("");
  const [cashRef, setCashRef] = useState("");
  const [busy, setBusy] = useState(false);

  const loadRows = () =>
    api
      .getLoanSchedule(loan.id)
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Could not load the schedule.")));

  useEffect(() => {
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.id, loan.outstandingBalance, loan.status]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await action();
      setReason("");
      setCashAmount("");
      setCashRef("");
      onChanged();
      await loadRows();
    } catch (err) {
      setError(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const open = loan.status === "active" || loan.status === "on_hold";

  return (
    <div className="mt-3 border-t border-black/10 pt-3">
      {!rows ? (
        <p className="text-xs text-label-tertiary">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="text-xs text-label-secondary">
          This loan was created before repayment schedules and recovers a fixed instalment each run.
          {canManage && open && (
            <button type="button" disabled={busy} onClick={() => run(() => api.generateLoanSchedule(loan.id), "Could not create the schedule.")} className="ml-2 font-semibold text-accent hover:underline">
              Create a schedule
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-label-tertiary">
                <th className="py-1 pr-3 font-medium">#</th>
                <th className="py-1 pr-3 font-medium">Due</th>
                <th className="py-1 pr-3 font-medium text-right">Amount</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                {canManage && open && <th className="py-1 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-black/5">
                  <td className="py-1 pr-3">{r.installmentNo}</td>
                  <td className="py-1 pr-3">{formatDay(r.dueDate)}</td>
                  <td className="py-1 pr-3 text-right font-mono">{pkr2.format(r.amount)}</td>
                  <td className="py-1 pr-3">
                    {ROW_LABEL[r.status] ?? r.status}
                    {r.note ? <span className="text-label-tertiary"> · {r.note}</span> : null}
                  </td>
                  {canManage && open && (
                    <td className="py-1 text-right">
                      {r.status === "scheduled" && (
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 3}
                          title={reason.trim().length < 3 ? "Type a reason below first" : "Skip this installment"}
                          onClick={() => run(() => api.skipLoanInstallments(loan.id, { installmentNos: [r.installmentNo], reason: reason.trim() }), "Could not skip this installment.")}
                          className="font-semibold text-accent hover:underline disabled:opacity-40"
                        >
                          Skip
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && open && (
        <div className="mt-3 space-y-3">
          <div>
            <label className={labelClass} htmlFor={`loan-reason-${loan.id}`}>Reason (needed to hold recovery or skip an installment)</label>
            <input id={`loan-reason-${loan.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {loan.status === "active" ? (
              <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => run(() => api.holdEmployeeLoan(loan.id, { reason: reason.trim() }), "Could not hold this loan.")} className="rounded-lg border border-black/10 px-3 py-2 text-xs font-semibold disabled:opacity-40">
                Hold recovery
              </button>
            ) : (
              <>
                <div>
                  <label className={labelClass} htmlFor={`loan-resume-${loan.id}`}>Resume from (optional)</label>
                  <input id={`loan-resume-${loan.id}`} type="date" value={resumeFrom} onChange={(e) => setResumeFrom(e.target.value)} className={inputClass} />
                </div>
                <button type="button" disabled={busy} onClick={() => run(() => api.resumeEmployeeLoan(loan.id, resumeFrom ? { resumeFrom } : {}), "Could not resume this loan.")} className="rounded-lg bg-accent text-white px-3 py-2 text-xs font-semibold disabled:opacity-40">
                  Resume recovery
                </button>
              </>
            )}
            {loan.status === "active" &&
              (loan.settlementRequested ? (
                <button type="button" disabled={busy} onClick={() => run(() => api.settleEmployeeLoan(loan.id, { mode: "withdraw" }), "Could not withdraw the request.")} className="rounded-lg border border-black/10 px-3 py-2 text-xs font-semibold disabled:opacity-40">
                  Withdraw early settlement
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => run(() => api.settleEmployeeLoan(loan.id, { mode: "payroll" }), "Could not request settlement.")} className="rounded-lg border border-black/10 px-3 py-2 text-xs font-semibold disabled:opacity-40">
                  Settle in next payroll run
                </button>
              ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className={labelClass} htmlFor={`loan-cash-${loan.id}`}>Cash received (PKR)</label>
              <input id={`loan-cash-${loan.id}`} type="number" min="1" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor={`loan-cash-date-${loan.id}`}>Received on</label>
              <input id={`loan-cash-date-${loan.id}`} type="date" value={cashDate} onChange={(e) => setCashDate(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor={`loan-cash-ref-${loan.id}`}>Reference</label>
              <input id={`loan-cash-ref-${loan.id}`} value={cashRef} onChange={(e) => setCashRef(e.target.value)} className={inputClass} />
            </div>
            <button
              type="button"
              disabled={busy || !cashAmount || !cashDate}
              onClick={() => run(() => api.settleEmployeeLoan(loan.id, { mode: "cash", amount: Number(cashAmount), receivedOn: cashDate, reference: cashRef.trim() || undefined }), "Could not record the repayment.")}
              className="rounded-lg border border-black/10 px-3 py-2 text-xs font-semibold disabled:opacity-40"
            >
              Record repayment
            </button>
          </div>
        </div>
      )}
      {error && <div className="text-danger text-xs mt-2">{error}</div>}
    </div>
  );
}

function NewLoanForm({ employeeId, onCreated, onCancel }: { employeeId: string; onCreated: () => void; onCancel: () => void }) {
  const [types, setTypes] = useState<LoanTypeView[]>([]);
  const [colleagues, setColleagues] = useState<EmployeeView[]>([]);
  const [typeId, setTypeId] = useState("");
  const [loanType, setLoanType] = useState<"loan" | "salary_advance">("loan");
  const [reason, setReason] = useState("");
  const [principalAmount, setPrincipalAmount] = useState("");
  const [mode, setMode] = useState<"amount" | "count">("amount");
  const [installment, setInstallment] = useState("");
  const [issuedDate, setIssuedDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [guarantorId, setGuarantorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listLoanTypes().then(setTypes).catch(() => setTypes([]));
    api.listEmployees().then(setColleagues).catch(() => setColleagues([]));
  }, []);

  const selected = types.find((t) => t.id === typeId) ?? null;

  function pickType(id: string) {
    setTypeId(id);
    const t = types.find((x) => x.id === id);
    if (t) setLoanType(t.kind);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createEmployeeLoan({
        employeeId,
        loanType,
        reason: reason.trim() || undefined,
        principalAmount: Number(principalAmount),
        ...(mode === "amount" ? { installmentAmount: Number(installment) } : { installmentsCount: Number(installment) }),
        issuedDate,
        deductionStartDate: startDate || undefined,
        loanTypeId: typeId || undefined,
        guarantorEmployeeId: guarantorId || undefined,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this loan / advance."));
    } finally {
      setSubmitting(false);
    }
  }

  const limits = selected
    ? [
        selected.maxInstallmentPercent !== null ? `instalment up to ${selected.maxInstallmentPercent}% of monthly earnings` : null,
        selected.maxPrincipalMultiple !== null ? `amount up to ${selected.maxPrincipalMultiple}× monthly earnings` : null,
        selected.maxInstallments !== null ? `at most ${selected.maxInstallments} instalments` : null,
        selected.requiresGuarantor ? "a guarantor is required" : null,
      ].filter(Boolean)
    : [];

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4 mb-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="loan-type">Type</label>
          <select id="loan-type" value={typeId} onChange={(e) => pickType(e.target.value)} className={inputClass}>
            <option value="">Loan / advance without a catalogue type</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {limits.length > 0 && <p className="text-xs text-label-tertiary mt-1">Policy: {limits.join("; ")}.</p>}
        </div>
        <div>
          <label className={labelClass} htmlFor="loan-kind">Kind</label>
          <select id="loan-kind" value={loanType} disabled={!!selected} onChange={(e) => setLoanType(e.target.value as "loan" | "salary_advance")} className={inputClass}>
            <option value="loan">Loan</option>
            <option value="salary_advance">Salary Advance</option>
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="loan-issued">Issued date</label>
          <input id="loan-issued" type="date" required value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="loan-start">First installment due (optional)</label>
          <input id="loan-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="loan-reason">Reason (optional)</label>
        <input id="loan-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Medical emergency" className={inputClass} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="loan-principal">Principal amount (PKR)</label>
          <input id="loan-principal" type="number" min="1" step="1" required value={principalAmount} onChange={(e) => setPrincipalAmount(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="loan-installment">
            <select aria-label="Repay by" value={mode} onChange={(e) => setMode(e.target.value as "amount" | "count")} className="border-0 bg-transparent font-medium p-0 mr-1">
              <option value="amount">Installment amount (PKR)</option>
              <option value="count">Number of installments</option>
            </select>
          </label>
          <input id="loan-installment" type="number" min="1" step={mode === "amount" ? "1" : "1"} required value={installment} onChange={(e) => setInstallment(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="loan-guarantor">Guarantor{selected?.requiresGuarantor ? " (required)" : " (optional)"}</label>
        <select id="loan-guarantor" value={guarantorId} onChange={(e) => setGuarantorId(e.target.value)} className={inputClass}>
          <option value="">None</option>
          {colleagues
            .filter((c) => c.id !== employeeId)
            .map((c) => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName} ({c.employeeNumber})</option>
            ))}
        </select>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex items-center gap-4">
        <button type="submit" disabled={submitting} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {submitting ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
