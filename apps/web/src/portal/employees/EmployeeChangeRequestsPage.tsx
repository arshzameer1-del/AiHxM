import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EmployeeChangeRequestStatus, EmployeeChangeRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { PageHeader, LoadingNote } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";
import { PendingDocumentsInbox } from "./PendingDocumentsInbox";

/**
 * BACKLOG48 - HR's inbox for the changes employees ask for on their own record (contact details, addresses, family,
 * marital status, bank account). Approving applies the change; rejecting needs a reason the employee will see.
 */
const FILTERS: { key: EmployeeChangeRequestStatus | "all"; label: string }[] = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Not approved" },
  { key: "all", label: "All" },
];

const LABELS: Record<string, string> = {
  contactType: "Type", value: "Value", label: "Label", isPrimary: "Primary", addressType: "Type", line1: "Address line 1", line2: "Address line 2",
  city: "City", stateProvince: "State / Province", postalCode: "Postal code", country: "Country", relationship: "Relationship", fullName: "Name",
  dateOfBirth: "Date of birth", cnic: "CNIC", isDependent: "Dependent", isBeneficiary: "Beneficiary", maritalStatus: "Marital status",
  paymentMethod: "Method", bankName: "Bank", accountTitle: "Account title", accountNumber: "Account number", iban: "IBAN", branchCode: "Branch code",
};
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

function Compare({ r }: { r: EmployeeChangeRequestView }) {
  const keys = Object.keys(r.payload).filter((k) => r.payload[k] !== undefined);
  if (keys.length === 0) return null;
  return (
    <table className="text-xs mt-2 w-full max-w-xl">
      <thead>
        <tr className="text-left text-label-tertiary">
          <th className="font-medium pr-3 py-0.5">Field</th>
          {r.current && <th className="font-medium pr-3 py-0.5">Today</th>}
          <th className="font-medium py-0.5">Requested</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k}>
            <td className="pr-3 py-0.5 text-label-secondary">{LABELS[k] ?? k}</td>
            {r.current && <td className="pr-3 py-0.5">{show(r.current[k])}</td>}
            <td className="py-0.5 font-medium">{show(r.payload[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EmployeeChangeRequestsPage() {
  const [filter, setFilter] = useState<EmployeeChangeRequestStatus | "all">("pending");
  const [items, setItems] = useState<EmployeeChangeRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setItems(null);
    api
      .listEmployeeChangeRequests(filter === "all" ? undefined : filter)
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "Requires HR Admin." : "Could not load the requests."));
  }, [filter]);
  useEffect(load, [load]);

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id);
    setRowError((e) => ({ ...e, [id]: "" }));
    try {
      if (action === "approve") await api.approveEmployeeChangeRequest(id);
      else await api.rejectEmployeeChangeRequest(id, reason);
      setRejecting(null);
      setReason("");
      load();
    } catch (err) {
      setRowError((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Could not do that." }));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="text-danger text-sm">{error}</div>;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Change Requests" subtitle="Changes employees asked for on their own record. Nothing changes until you approve." />
      <PendingDocumentsInbox />
      <div className="flex gap-1 border-b border-black/10 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${filter === f.key ? "border-accent text-accent" : "border-transparent text-label-secondary hover:text-label-primary"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {items === null && <LoadingNote />}
      {items && items.length === 0 && <p className="text-sm text-label-tertiary">No requests here.</p>}
      <div className="space-y-3">
        {items?.map((r) => (
          <section key={r.id} className="bg-card rounded-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{r.summary}</div>
                <div className="text-xs text-label-tertiary mt-0.5">
                  <Link className="text-accent hover:underline" to={`/app/employees/${r.employeeId}`}>
                    {r.employeeNumber} · {r.employeeName}
                  </Link>{" "}
                  · sent {formatDateTime(r.submittedAt)}
                  {r.status !== "pending" && r.decidedAt ? ` · ${r.status} ${formatDateTime(r.decidedAt)}` : ""}
                  {r.decisionNote ? ` · “${r.decisionNote}”` : ""}
                </div>
              </div>
              {r.status === "pending" && (
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, "approve")}
                    className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button onClick={() => { setRejecting(rejecting === r.id ? null : r.id); setReason(""); }} className="text-xs font-medium text-label-tertiary hover:text-danger">
                    Reject
                  </button>
                </div>
              )}
            </div>
            <Compare r={r} />
            {rejecting === r.id && (
              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <input
                  aria-label="Reason for rejecting"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Tell the employee why"
                  className="flex-1 min-w-48 rounded-lg border border-black/10 px-3 py-1.5 text-sm"
                />
                <button disabled={!reason.trim() || busy === r.id} onClick={() => decide(r.id, "reject")} className="bg-danger text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
                  Reject request
                </button>
              </div>
            )}
            {rowError[r.id] && <div className="text-danger text-xs mt-2">{rowError[r.id]}</div>}
          </section>
        ))}
      </div>
    </div>
  );
}
