import { FormEvent, useEffect, useState } from "react";
import type { EmployeeView, JobRequisitionView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { REQUISITION_STATUS_LABELS, REQUISITION_STATUS_STYLES } from "./requisitionLabels";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Recruitment module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type FormValue = {
  title: string;
  department: string;
  headcount: string;
  salaryBand: string;
  justification: string;
  hiringManagerId: string;
};

function emptyForm(): FormValue {
  return { title: "", department: "", headcount: "1", salaryBand: "", justification: "", hiringManagerId: "" };
}

function RequisitionForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (req: JobRequisitionView) => void }) {
  const [value, setValue] = useState<FormValue>(emptyForm);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Same scoped GET /employees the Leave On-Behalf picker and Employee
    // Core's manager dropdown already call — hiringManagerId is just a
    // reference, RecruitmentService doesn't validate it against anything
    // beyond "is this a real employee id".
    api.listEmployees().then(setEmployees).catch(() => {
      // A failed employee-list fetch shouldn't block the rest of the form.
    });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const saved = await api.createRequisition({
        title: value.title,
        department: value.department || undefined,
        headcount: Number(value.headcount) || 1,
        salaryBand: value.salaryBand || undefined,
        justification: value.justification || undefined,
        hiringManagerId: value.hiringManagerId || undefined,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this requisition.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div>
        <label className="block text-sm font-medium mb-1">Job title</label>
        <input
          required
          value={value.title}
          onChange={(e) => setValue((v) => ({ ...v, title: e.target.value }))}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Department (optional)</label>
          <input
            value={value.department}
            onChange={(e) => setValue((v) => ({ ...v, department: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Headcount</label>
          <input
            type="number"
            min={1}
            value={value.headcount}
            onChange={(e) => setValue((v) => ({ ...v, headcount: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Salary band (optional)</label>
          <input
            value={value.salaryBand}
            placeholder="e.g. PKR 150k–200k"
            onChange={(e) => setValue((v) => ({ ...v, salaryBand: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Hiring manager (optional)</label>
          <select
            value={value.hiringManagerId}
            onChange={(e) => setValue((v) => ({ ...v, hiringManagerId: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">None</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNumber})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Justification (optional)</label>
        <input
          value={value.justification}
          onChange={(e) => setValue((v) => ({ ...v, justification: e.target.value }))}
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
          {submitting ? "Creating…" : "Create requisition"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RequisitionRow({ req, onChanged }: { req: JobRequisitionView; onChanged: () => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmitForApproval() {
    setActionError(null);
    setBusy(true);
    try {
      await api.submitRequisition(req.id);
      onChanged();
    } catch (err) {
      // 404 "No active workflow template with that key" is the honest,
      // expected answer today — no hr_admin-reachable UI grants
      // workflow_template.manage.all yet (Decision #18's P0 gap, which
      // blocks requisition approval routing exactly the same way it
      // blocks leave approval routing).
      setActionError(err instanceof ApiError ? err.message : "Could not submit this requisition.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDecision(decision: "approved" | "rejected") {
    setActionError(null);
    setBusy(true);
    try {
      await api.decideRequisition(req.id, { decision });
      onChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-5 shadow-sm">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-semibold">{req.title}</h3>
          <p className="text-xs text-label-tertiary">
            {req.department ?? "No department"} · Headcount {req.headcount}
            {req.salaryBand ? ` · ${req.salaryBand}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${REQUISITION_STATUS_STYLES[req.status]}`}
        >
          {REQUISITION_STATUS_LABELS[req.status]}
        </span>
      </div>

      {req.justification && <p className="text-sm text-label-secondary mb-3">{req.justification}</p>}

      <div className="flex gap-3">
        {req.status === "draft" && (
          <button
            onClick={handleSubmitForApproval}
            disabled={busy}
            className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
          >
            Submit for approval
          </button>
        )}
        {req.status === "pending_approval" && (
          <>
            <button
              onClick={() => handleDecision("approved")}
              disabled={busy}
              className="text-xs font-semibold text-success hover:underline disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => handleDecision("rejected")}
              disabled={busy}
              className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
      </div>

      {actionError && <p className="text-xs text-danger mt-2">{actionError}</p>}
    </div>
  );
}

/**
 * Task #51 — Recruitment, tab one. recruitment.manage.all has no
 * .self/.team scoping (0018_recruitment_seed.sql) so unlike Leave's
 * LeavePage there's no per-role rendering here: this is the one screen
 * an hr_admin session sees, and PortalLayout's nav already keeps every
 * other role from reaching this route at all.
 */
export function RequisitionsPanel() {
  const [requisitions, setRequisitions] = useState<JobRequisitionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listRequisitions().then(setRequisitions).catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!requisitions) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Open a requisition, submit it for approval, then move to Pipeline once it's approved to start adding
          candidates.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Requisition
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <RequisitionForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {requisitions.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No job requisitions yet. Open one to start the approval process.
        </div>
      )}

      {requisitions.map((req) => (
        <RequisitionRow key={req.id} req={req} onChanged={load} />
      ))}
    </div>
  );
}
