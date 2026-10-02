import { useEffect, useRef, useState } from "react";
import { Receipt, Upload } from "lucide-react";
import type { ExpenseClaimView, WorkflowInstanceView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ExpenseClaimForm } from "./ExpenseClaimForm";
import { EXPENSE_CATEGORY_LABELS, EXPENSE_STATUS_LABELS, EXPENSE_STATUS_STYLES } from "./expenseLabels";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Expense Management isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

function formatAmount(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Summary cards — Part 2's own spec: "total claims, approved, pending,
 * rejected." Computed client-side from whatever `GET /expense-claims`
 * already returned for this caller (self/team/all, server-scoped) —
 * no separate aggregate endpoint, same "the client just renders what
 * comes back" posture every other re-skinned list page in this portal
 * follows.
 */
function SummaryCards({ claims }: { claims: ExpenseClaimView[] }) {
  const total = claims.length;
  const approved = claims.filter((c) => c.status === "approved" || c.status === "paid").length;
  const pending = claims.filter((c) => c.status === "pending").length;
  const rejected = claims.filter((c) => c.status === "rejected").length;

  const cards: Array<{ label: string; value: number; tone: string }> = [
    { label: "Total claims", value: total, tone: "text-label-primary" },
    { label: "Approved", value: approved, tone: "text-green-700" },
    { label: "Pending", value: pending, tone: "text-amber-700" },
    { label: "Rejected", value: rejected, tone: "text-danger" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
      {cards.map((c) => (
        <div key={c.label} className="bg-card rounded-card p-4 shadow-sm">
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1">{c.label}</div>
          <div className={`text-2xl font-bold tabular-nums ${c.tone}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function WorkflowTimeline({ instance }: { instance: WorkflowInstanceView }) {
  return (
    <div className="space-y-2">
      {instance.steps.map((step) => (
        <div key={step.id} className="flex items-start justify-between gap-3 text-xs">
          <div>
            <span className="font-medium">{step.name}</span>
            {step.approvals.map((a) => (
              <span key={a.id} className="text-label-tertiary">
                {a.decidedByUserAccountId ? ` · decided ${a.decision ?? ""}` : a.status === "escalated" ? " · escalated" : ""}
              </span>
            ))}
          </div>
          <span
            className={`shrink-0 inline-block px-2 py-0.5 rounded-full font-semibold ${
              step.status === "approved"
                ? "bg-success/15 text-green-700"
                : step.status === "rejected"
                  ? "bg-danger/15 text-red-700"
                  : step.status === "skipped"
                    ? "bg-black/5 text-label-tertiary"
                    : "bg-amber-100 text-amber-800"
            }`}
          >
            {step.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClaimDetail({
  claim,
  canDecide,
  canPay,
  canCancel,
  onChanged,
}: {
  claim: ExpenseClaimView;
  canDecide: boolean;
  canPay: boolean;
  canCancel: boolean;
  onChanged: () => void;
}) {
  const [instance, setInstance] = useState<WorkflowInstanceView | null>(null);
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!claim.workflowInstanceId) return;
    api
      .getWorkflowInstance(claim.workflowInstanceId)
      .then(setInstance)
      .catch(() => setInstance(null));
  }, [claim.workflowInstanceId]);

  async function submitDecision(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await api.decideExpenseClaim(claim.id, { decision, comment: comment || undefined });
      setDeciding(null);
      setComment("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkPaid() {
    setBusy(true);
    setError(null);
    try {
      await api.markExpenseClaimPaid(claim.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark this claim as paid.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm("Cancel this expense claim?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelExpenseClaim(claim.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel this claim.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadExpenseReceipt(claim.id, file);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload this receipt.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const canActOnThis = claim.status === "pending" && (canDecide || canCancel);

  return (
    <div className="mt-3 pt-3 border-t border-black/5 space-y-4">
      {claim.description && <p className="text-sm text-label-secondary">&ldquo;{claim.description}&rdquo;</p>}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Receipts</h4>
          <label className="text-xs font-semibold text-accent hover:underline cursor-pointer flex items-center gap-1">
            <Upload size={12} /> {uploading ? "Uploading…" : "Add receipt"}
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" onChange={handleFileChange} />
          </label>
        </div>
        {claim.receipts.length === 0 ? (
          <p className="text-xs text-label-tertiary">No receipts attached yet.</p>
        ) : (
          <div className="space-y-1">
            {claim.receipts.map((r) => (
              <button
                key={r.id}
                onClick={() => api.downloadExpenseReceipt(claim.id, r.id, r.fileName)}
                className="flex items-center gap-1.5 text-xs text-accent hover:underline"
              >
                <Receipt size={12} /> {r.fileName}
              </button>
            ))}
          </div>
        )}
      </div>

      {instance && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">Approval timeline</h4>
          <WorkflowTimeline instance={instance} />
        </div>
      )}

      {claim.status === "approved" && canPay && (
        <button
          onClick={handleMarkPaid}
          disabled={busy}
          className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-accent text-white disabled:opacity-50"
        >
          Mark as paid
        </button>
      )}

      {canActOnThis && (
        <div>
          {deciding ? (
            <div className="space-y-2">
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Comment (optional)"
                className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <div className="flex gap-3 items-center">
                <button
                  onClick={() => submitDecision(deciding)}
                  disabled={busy}
                  className={`text-xs font-semibold rounded-lg px-3 py-1.5 text-white disabled:opacity-50 ${
                    deciding === "approved" ? "bg-success" : "bg-danger"
                  }`}
                >
                  Confirm {deciding === "approved" ? "approval" : "rejection"}
                </button>
                <button onClick={() => setDeciding(null)} className="text-xs text-label-tertiary">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-4 items-center flex-wrap">
              {canDecide && (
                <button onClick={() => setDeciding("approved")} className="text-xs font-semibold text-green-700 hover:underline">
                  Approve
                </button>
              )}
              {canDecide && (
                <button onClick={() => setDeciding("rejected")} className="text-xs font-semibold text-danger hover:underline">
                  Reject
                </button>
              )}
              {canCancel && (
                <button onClick={handleCancel} disabled={busy} className="text-xs font-medium text-label-tertiary hover:text-danger">
                  Cancel claim
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function ClaimRow({
  claim,
  employeeName,
  canDecide,
  canPay,
  canCancel,
  onChanged,
}: {
  claim: ExpenseClaimView;
  employeeName: string;
  canDecide: boolean;
  canPay: boolean;
  canCancel: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-start justify-between gap-4 text-left">
        <div>
          <div className="font-medium text-sm">
            {employeeName}
            {claim.isOnBehalf && <span className="text-xs text-label-tertiary ml-1.5">(on behalf)</span>}
          </div>
          <div className="text-sm text-label-secondary mt-0.5">
            {EXPENSE_CATEGORY_LABELS[claim.category]} · {claim.expenseDate} ·{" "}
            <span className="tabular-nums">{formatAmount(claim.amount, claim.currency)}</span>
          </div>
        </div>
        <span
          className={`shrink-0 inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${EXPENSE_STATUS_STYLES[claim.status]}`}
        >
          {EXPENSE_STATUS_LABELS[claim.status]}
        </span>
      </button>
      {expanded && <ClaimDetail claim={claim} canDecide={canDecide} canPay={canPay} canCancel={canCancel} onChanged={onChanged} />}
    </div>
  );
}

/**
 * Expense Management — Part 2 category 6, built end to end per kumail's
 * "develop ESS end to end as per documentation" instruction (2026-10).
 * Same "server already RBAC-scopes it, the client just renders whatever
 * comes back" shape as LeavePage: `GET /expense-claims` returns
 * hr_admin's whole company, a line_manager's team, or an
 * employee_self_service holder's own claims, from the identical call.
 * The only role-aware branching here is which ACTIONS render — New
 * Expense / On-Behalf (create.self vs manage.all), Approve/Reject
 * (cosmetic; the actual gate is workflow routing, same as Leave), Mark
 * as paid (pay.all, hr_admin only), Cancel (manage.all, hr_admin only).
 */
export function ExpensesPage() {
  const { identity } = useAuth();
  const [claims, setClaims] = useState<ExpenseClaimView[] | null>(null);
  const [employeeNames, setEmployeeNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const roleKeys = identity?.roleKeys ?? [];
  const canSubmitSelf = roleKeys.includes("employee_self_service");
  const canSubmitOnBehalf = roleKeys.includes("hr_admin");
  const canSubmit = canSubmitSelf || canSubmitOnBehalf;
  const canDecide = roleKeys.includes("hr_admin") || roleKeys.includes("line_manager");
  const canPay = roleKeys.includes("hr_admin");
  const canCancel = roleKeys.includes("hr_admin");

  useEffect(() => {
    Promise.all([api.listExpenseClaims(), api.listEmployees().catch(() => [])])
      .then(([claimRows, emps]) => {
        setClaims(claimRows);
        setEmployeeNames(new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`])));
      })
      .catch((err) => setError(describeError(err)));
  }, [refreshKey]);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Expense Management</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Submit and track expense claims — approvals route through the same workflow as every other request.
      </p>

      {error ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>
      ) : !claims ? (
        <div className="text-label-tertiary text-sm">Loading…</div>
      ) : (
        <>
          <SummaryCards claims={claims} />

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              {canSubmitOnBehalf ? "Expense Claims" : "My Expense Claims"}
            </h2>
            {canSubmit && !showForm && (
              <button
                onClick={() => setShowForm(true)}
                className="text-sm font-semibold rounded-lg px-3 py-1.5 bg-accent text-white"
              >
                New Expense
              </button>
            )}
          </div>

          {showForm && (
            <div className="mb-4">
              <ExpenseClaimForm
                fixedEmployeeId={canSubmitOnBehalf ? undefined : identity?.employeeId ?? undefined}
                onCancel={() => setShowForm(false)}
                onSubmitted={() => {
                  setShowForm(false);
                  bump();
                }}
              />
            </div>
          )}

          {claims.length === 0 ? (
            <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
              No expense claims to show.
            </div>
          ) : (
            <div className="space-y-3">
              {claims.map((c) => (
                <ClaimRow
                  key={c.id}
                  claim={c}
                  employeeName={employeeNames.get(c.employeeId) ?? "Employee"}
                  canDecide={canDecide}
                  canPay={canPay}
                  canCancel={canCancel}
                  onChanged={bump}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
