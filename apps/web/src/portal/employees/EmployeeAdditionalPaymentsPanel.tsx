import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type { CompensationComponentView, EmployeeAdditionalPaymentView, HrReferenceCatalogItemView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass =
  "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Payroll Enterprise Gap Analysis Phase P3, Section 6 (0112_loans_advances_
 * additional_payments.sql) — the SAP IT0015 equivalent: a one-time earning
 * or deduction tied to a specific date, not a recurring component (see
 * `EmployeeCompensationPanel`) and not yet tied to a specific off-cycle run
 * (IT0267 equivalent — Phase P4). Core-Employee-owned, same posture as
 * `EmployeeLoansPanel`. `status` only ever moves pending -> consumed
 * (written by `PayrollService.finalizeRun()` once a run's period covers
 * `effectiveDate`) or pending -> cancelled (via this panel, before that
 * happens).
 */
export function EmployeeAdditionalPaymentsPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [payments, setPayments] = useState<EmployeeAdditionalPaymentView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    api
      .listEmployeeAdditionalPayments(employeeId)
      .then(setPayments)
      .catch((err) => setLoadError(errorMessage(err, "Could not load additional payments.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  async function handleCancel(id: string) {
    try {
      await api.cancelEmployeeAdditionalPayment(id);
      load();
    } catch (err) {
      setLoadError(errorMessage(err, "Could not cancel this payment."));
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Additional Payments</h2>
        {canManage && (
          <button type="button" onClick={() => setShowForm((s) => !s)} className="text-xs font-semibold text-accent hover:underline">
            {showForm ? "Cancel" : "+ New one-time payment"}
          </button>
        )}
      </div>

      {loadError && <p className="text-xs text-danger mb-2">{loadError}</p>}

      {showForm && (
        <NewPaymentForm
          employeeId={employeeId}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {!payments ? (
        <LoadingNote />
      ) : payments.length === 0 ? (
        <p className="text-sm text-label-tertiary">No one-time payments on record.</p>
      ) : (
        <div className="space-y-2">
          {payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between bg-black/5 rounded-lg px-3 py-2 text-sm">
              <div>
                <div className="font-medium">
                  {p.label}
                  {!p.isTaxable && <span className="text-label-tertiary text-xs ml-1">(non-taxable)</span>}
                </div>
                <div className="text-xs text-label-tertiary">
                  {p.effectiveDate} · Status: <span className="font-semibold">{p.status}</span>
                  {p.approvalStatus === "pending" && <span className="ml-2 px-1.5 rounded bg-amber-100 text-amber-800">awaiting approval</span>}
                  {p.approvalStatus === "approved" && <span className="ml-2 px-1.5 rounded bg-green-100 text-green-800">approved</span>}
                  {p.approvalStatus === "rejected" && <span className="ml-2 px-1.5 rounded bg-red-100 text-red-800">rejected</span>}
                </div>
                {p.reasonNote && <div className="text-xs text-label-secondary">{p.reasonNote}</div>}
              </div>
              <div className="flex items-center gap-3">
                <span className={`font-mono font-semibold ${p.paymentType === "deduction" ? "text-danger" : ""}`}>
                  {p.paymentType === "deduction" ? "-" : "+"}
                  {pkr.format(p.amount)}
                </span>
                {canManage && p.status === "pending" && (
                  <button type="button" onClick={() => handleCancel(p.id)} className="text-xs font-semibold text-danger hover:underline">
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

function NewPaymentForm({ employeeId, onCreated, onCancel }: { employeeId: string; onCreated: () => void; onCancel: () => void }) {
  const [paymentType, setPaymentType] = useState<"earning" | "deduction">("earning");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [isTaxable, setIsTaxable] = useState(true);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [componentId, setComponentId] = useState("");
  const [reasonId, setReasonId] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [components, setComponents] = useState<CompensationComponentView[]>([]);
  const [reasons, setReasons] = useState<HrReferenceCatalogItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listCompensationComponents().then(setComponents).catch(() => setComponents([]));
    api.listHrCatalogItems("payroll_adjustment_reason").then(setReasons).catch(() => setReasons([]));
  }, []);

  // only components that can be paid once: earnings and reimbursements for an earning, deductions for a deduction
  const choices = components.filter(
    (c) => c.isActive && (paymentType === "deduction" ? c.componentType === "deduction" : ["earning", "reimbursement", "arrears", "retro", "shift_premium"].includes(c.componentType))
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createEmployeeAdditionalPayment({
        employeeId,
        paymentType,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(componentId ? { componentId } : {}),
        ...(reasonId ? { reasonCatalogItemId: reasonId } : {}),
        ...(reasonNote.trim() ? { reasonNote: reasonNote.trim() } : {}),
        amount: Number(amount),
        isTaxable: paymentType === "deduction" ? undefined : isTaxable,
        effectiveDate,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create this payment."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4 mb-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Type</label>
          <select value={paymentType} onChange={(e) => setPaymentType(e.target.value as "earning" | "deduction")} className={inputClass}>
            <option value="earning">One-time earning</option>
            <option value="deduction">One-time deduction</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Effective date</label>
          <input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="adj-component">Pay component</label>
          <select id="adj-component" value={componentId} onChange={(e) => setComponentId(e.target.value)} className={inputClass}>
            <option value="">None - use a label</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="adj-reason">Reason</label>
          <select id="adj-reason" value={reasonId} onChange={(e) => setReasonId(e.target.value)} className={inputClass}>
            <option value="">Not specified</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="adj-label">Label{componentId ? " (optional)" : ""}</label>
        <input id="adj-label" required={!componentId} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={componentId ? "Defaults to the component's name" : "e.g. Eid Bonus"} className={inputClass} />
      </div>
      <div>
        <label className={labelClass} htmlFor="adj-note">Note</label>
        <input id="adj-note" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Why is this being paid?" className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3 items-end">
        <div>
          <label className={labelClass}>Amount (PKR)</label>
          <input type="number" min="1" step="1" required value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
        </div>
        {paymentType === "earning" && (
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={isTaxable} onChange={(e) => setIsTaxable(e.target.checked)} />
            Taxable
          </label>
        )}
        {paymentType === "deduction" && <p className="text-xs text-label-tertiary pb-2">A deduction is never taxable.</p>}
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
