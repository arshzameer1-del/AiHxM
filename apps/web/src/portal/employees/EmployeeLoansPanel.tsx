import { FormEvent, useEffect, useState } from "react";
import type { EmployeeLoanView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const LOAN_TYPE_LABEL: Record<string, string> = { loan: "Loan", salary_advance: "Salary Advance" };

/**
 * Payroll Enterprise Gap Analysis Phase P3 (0112_loans_advances_
 * additional_payments.sql) — the SAP IT0045 equivalent, on the employee's
 * own profile alongside Compensation (same Core-Employee-owned posture —
 * see `EmployeeCompensationPanel`'s own doc comment). PayrollService only
 * ever READS this data (previewing this period's installment at
 * calculate() time, committing the ledger row only at finalize()) — every
 * write here goes through `EmployeeLoansService`, never Payroll.
 */
export function EmployeeLoansPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [loans, setLoans] = useState<EmployeeLoanView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

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
        <p className="text-sm text-label-tertiary">Loading…</p>
      ) : loans.length === 0 ? (
        <p className="text-sm text-label-tertiary">No loans or salary advances on record.</p>
      ) : (
        <div className="space-y-2">
          {loans.map((loan) => (
            <div key={loan.id} className="flex items-center justify-between bg-black/5 rounded-lg px-3 py-2 text-sm">
              <div>
                <div className="font-medium">
                  {LOAN_TYPE_LABEL[loan.loanType] ?? loan.loanType}
                  {loan.reason && <span className="text-label-tertiary"> — {loan.reason}</span>}
                </div>
                <div className="text-xs text-label-tertiary">
                  Issued {loan.issuedDate} · Installment {pkr.format(loan.installmentAmount)}/period · Status:{" "}
                  <span className="font-semibold">{loan.status}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="font-mono font-semibold">{pkr.format(loan.outstandingBalance)}</div>
                  <div className="text-xs text-label-tertiary">of {pkr.format(loan.principalAmount)}</div>
                </div>
                {canManage && loan.status === "active" && (
                  <button type="button" onClick={() => handleCancel(loan.id)} className="text-xs font-semibold text-danger hover:underline">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NewLoanForm({ employeeId, onCreated, onCancel }: { employeeId: string; onCreated: () => void; onCancel: () => void }) {
  const [loanType, setLoanType] = useState<"loan" | "salary_advance">("loan");
  const [reason, setReason] = useState("");
  const [principalAmount, setPrincipalAmount] = useState("");
  const [installmentAmount, setInstallmentAmount] = useState("");
  const [issuedDate, setIssuedDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        installmentAmount: Number(installmentAmount),
        issuedDate,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this loan / advance."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4 mb-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Type</label>
          <select value={loanType} onChange={(e) => setLoanType(e.target.value as "loan" | "salary_advance")} className={inputClass}>
            <option value="loan">Loan</option>
            <option value="salary_advance">Salary Advance</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Issued date</label>
          <input type="date" required value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Reason (optional)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Medical emergency" className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Principal amount (PKR)</label>
          <input
            type="number"
            min="1"
            step="1"
            required
            value={principalAmount}
            onChange={(e) => setPrincipalAmount(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Installment per period (PKR)</label>
          <input
            type="number"
            min="1"
            step="1"
            required
            value={installmentAmount}
            onChange={(e) => setInstallmentAmount(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
