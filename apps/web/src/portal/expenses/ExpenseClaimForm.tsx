import { FormEvent, useEffect, useState } from "react";
import type { EmployeeView, ExpenseCategory, ExpenseClaimView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from "./expenseLabels";

/**
 * Same shared-by-both-submit-paths shape as LeaveRequestForm: an
 * employee_self_service holder submitting their own claim
 * (`fixedEmployeeId` set, no picker) and an hr_admin submitting On-Behalf
 * for anyone (`fixedEmployeeId` omitted — ExpenseClaimsService's own
 * `manage.all` path). Which one a given session sees is decided by
 * ExpensesPage; this component just renders the form either way.
 */
export function ExpenseClaimForm({
  fixedEmployeeId,
  onCancel,
  onSubmitted,
}: {
  fixedEmployeeId?: string;
  onCancel: () => void;
  onSubmitted: (result: ExpenseClaimView) => void;
}) {
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [employeeId, setEmployeeId] = useState(fixedEmployeeId ?? "");
  const [category, setCategory] = useState<ExpenseCategory>("travel");
  const [expenseDate, setExpenseDate] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (fixedEmployeeId) return;
    api.listEmployees().then(setEmployees).catch(() => {
      // A failed employee-list fetch shouldn't block the rest of the form.
    });
  }, [fixedEmployeeId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.submitExpenseClaim({
        employeeId,
        category,
        expenseDate,
        amount: parsedAmount,
        description: description || undefined,
      });
      onSubmitted(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit this expense claim.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      {!fixedEmployeeId && (
        <div>
          <label className="block text-sm font-medium mb-1">Employee</label>
          <select
            required
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">Select an employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Date</label>
          <input
            type="date"
            required
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Amount (PKR)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Description (optional)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What was this for?"
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Submit claim"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
      <p className="text-xs text-label-tertiary">
        You can attach a receipt right after submitting, from the claim's detail view.
      </p>
    </form>
  );
}
