import { FormEvent, useEffect, useState } from "react";
import type { EmployeeView, JobRequisitionAction, JobRequisitionView, PositionView } from "@aihxm/shared-types";
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
  positionId: string;
};

function emptyForm(): FormValue {
  return { title: "", department: "", headcount: "1", salaryBand: "", justification: "", hiringManagerId: "", positionId: "" };
}

function RequisitionForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (req: JobRequisitionView) => void }) {
  const [value, setValue] = useState<FormValue>(emptyForm);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [positions, setPositions] = useState<PositionView[]>([]);
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
    // ORG-01: requisitions are raised against an approved position with open capacity.
    api.listPositions({ status: "vacant" }).then(setPositions).catch(() => {
      // Positions are optional unless the hiring policy requires one.
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
        positionId: value.positionId || undefined,
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
        <label htmlFor="req-field-1" className="block text-sm font-medium mb-1">Job title</label>
        <input id="req-field-1"
          required
          value={value.title}
          onChange={(e) => setValue((v) => ({ ...v, title: e.target.value }))}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div>
        <label htmlFor="req-field-2" className="block text-sm font-medium mb-1">Position (approved seat with open capacity)</label>
        <select id="req-field-2"
          value={value.positionId}
          onChange={(e) => {
            const picked = positions.find((p) => p.id === e.target.value);
            setValue((v) => ({ ...v, positionId: e.target.value, title: v.title || picked?.positionTitle || "" }));
          }}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">No position (if your hiring policy allows)</option>
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.positionTitle}
              {p.positionCode ? ` (${p.positionCode})` : ""} · {p.headcountFte} FTE
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="req-field-3" className="block text-sm font-medium mb-1">Department (optional)</label>
          <input id="req-field-3"
            value={value.department}
            onChange={(e) => setValue((v) => ({ ...v, department: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label htmlFor="req-field-4" className="block text-sm font-medium mb-1">Headcount</label>
          <input id="req-field-4"
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
          <label htmlFor="req-field-5" className="block text-sm font-medium mb-1">Salary band (optional)</label>
          <input id="req-field-5"
            value={value.salaryBand}
            placeholder="e.g. PKR 150k–200k"
            onChange={(e) => setValue((v) => ({ ...v, salaryBand: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label htmlFor="req-field-6" className="block text-sm font-medium mb-1">Hiring manager (optional)</label>
          <select id="req-field-6"
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
        <label htmlFor="req-field-7" className="block text-sm font-medium mb-1">Justification (optional)</label>
        <input id="req-field-7"
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

function RequisitionRow({ req, onChanged }: { req: JobRequisitionView; onChanged: (updated: JobRequisitionView) => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmitForApproval() {
    setActionError(null);
    setBusy(true);
    try {
      // Patch local state straight from the mutation's own response
      // rather than re-fetching the list afterward. A live QA pass found
      // that an immediate GET /job-requisitions right after this POST can
      // still come back showing the pre-mutation status for a few
      // seconds (confirmed via network-log inspection: the POST returns
      // 201, the very next GET still reports "draft", and only a later
      // reload shows "pending_approval") — a backend/infra read-after-
      // write lag, not a logic bug in the submit itself. The mutation
      // endpoint already returns the updated JobRequisitionView, so using
      // that directly sidesteps the lag entirely instead of trusting a
      // refetch that may not have caught up yet.
      const updated = await api.submitRequisition(req.id);
      onChanged(updated);
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

  async function handleAction(action: JobRequisitionAction) {
    let reason: string | undefined;
    if (action === "hold" || action === "cancel") {
      reason = window.prompt(`Reason to ${action} this requisition?`)?.trim();
      if (!reason) return;
    }
    setActionError(null);
    setBusy(true);
    try {
      onChanged(await api.requisitionAction(req.id, action, reason));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Could not ${action} this requisition.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDecision(decision: "approved" | "rejected") {
    setActionError(null);
    setBusy(true);
    try {
      // Same local-patch-from-response fix as handleSubmitForApproval
      // above — decideRequisition also returns the updated view.
      const updated = await api.decideRequisition(req.id, { decision });
      onChanged(updated);
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
            {req.filledHeadcount > 0 ? ` (${req.filledHeadcount} filled)` : ""}
            {req.positionId ? " · Linked to a position" : ""}
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
        {req.status === "approved" && (
          <button onClick={() => handleAction("open")} disabled={busy} className="text-xs font-semibold text-accent hover:underline disabled:opacity-50">
            Open for hiring
          </button>
        )}
        {(req.status === "approved" || req.status === "open") && (
          <button onClick={() => handleAction("hold")} disabled={busy} className="text-xs font-semibold text-label-secondary hover:underline disabled:opacity-50">
            Put on hold
          </button>
        )}
        {req.status === "on_hold" && (
          <button onClick={() => handleAction("resume")} disabled={busy} className="text-xs font-semibold text-accent hover:underline disabled:opacity-50">
            Resume
          </button>
        )}
        {["approved", "open", "on_hold"].includes(req.status) && (
          <button onClick={() => handleAction("fill")} disabled={busy} className="text-xs font-semibold text-label-secondary hover:underline disabled:opacity-50">
            Mark filled
          </button>
        )}
        {["draft", "pending_approval", "approved", "open", "on_hold"].includes(req.status) && (
          <button onClick={() => handleAction("cancel")} disabled={busy} className="text-xs font-semibold text-danger hover:underline disabled:opacity-50">
            Cancel
          </button>
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

  // Replaces a single row in place from a mutation's own response —
  // see RequisitionRow's handleSubmitForApproval/handleDecision comment
  // for why this exists instead of calling load() again after every
  // action. New rows still take the create form's onSaved -> load()
  // path below, which is correct for a brand-new id the local list
  // doesn't have yet.
  function patchOne(updated: JobRequisitionView) {
    setRequisitions((reqs) => reqs?.map((r) => (r.id === updated.id ? updated : r)) ?? reqs);
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
        <RequisitionRow key={req.id} req={req} onChanged={patchOne} />
      ))}
    </div>
  );
}
