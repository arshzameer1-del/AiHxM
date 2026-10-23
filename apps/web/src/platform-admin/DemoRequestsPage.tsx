import { useEffect, useState } from "react";
import type { DemoRequest, DemoRequestStatus } from "@aihxm/shared-types";
import { api } from "../api/client";

const STATUSES: DemoRequestStatus[] = ["new", "contacted", "qualified", "closed"];

const TONE: Record<DemoRequestStatus, string> = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-amber-100 text-amber-800",
  qualified: "bg-green-100 text-green-800",
  closed: "bg-gray-200 text-gray-600",
};

/**
 * Requests collected by the public marketing website's "Book a demo" form (POST /public/demo-requests). The website
 * saves each one here; this screen is where the team works through them. Platform Admin only — a prospect is not a
 * tenant yet, so none of this lives inside a company.
 */
export function DemoRequestsPage() {
  const [rows, setRows] = useState<DemoRequest[] | null>(null);
  const [filter, setFilter] = useState<DemoRequestStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      setRows(await api.listDemoRequests(filter || undefined));
    } catch {
      setError("Could not load demo requests.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function save(id: string, input: { status?: DemoRequestStatus; internalNotes?: string | null }) {
    setSavingId(id);
    try {
      const updated = await api.updateDemoRequest(id, input);
      setRows((prev) => (prev ? prev.map((r) => (r.id === id ? updated : r)) : prev));
    } catch {
      setError("Could not save this change. Read-only Platform Admins cannot edit requests.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Demo requests</h1>
          <p className="text-label-tertiary text-sm">
            Sent from the "Book a demo" form on the AiHxM website. The same person asking twice in a day is counted once.
          </p>
        </div>
        <select
          aria-label="Filter by status"
          value={filter}
          onChange={(e) => setFilter(e.target.value as DemoRequestStatus | "")}
          className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
      {rows === null && !error && <p className="text-sm text-label-tertiary">Loading…</p>}
      {rows?.length === 0 && (
        <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">No demo requests yet.</div>
      )}

      <div className="space-y-3">
        {rows?.map((r) => {
          const open = openId === r.id;
          return (
            <div key={r.id} className="bg-card rounded-card shadow-sm">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : r.id)}
                aria-expanded={open}
                className="w-full text-left p-4 flex flex-wrap items-center gap-x-4 gap-y-1"
              >
                <span className="font-semibold">{r.companyName}</span>
                <span className="text-sm text-label-tertiary">
                  {r.fullName} · {r.workEmail}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {r.duplicateCount > 0 && (
                    <span className="text-xs text-label-tertiary">asked {r.duplicateCount + 1}×</span>
                  )}
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${TONE[r.status]}`}>
                    {r.status}
                  </span>
                  <span className="text-xs text-label-tertiary">{new Date(r.createdAt).toLocaleString()}</span>
                </span>
              </button>
              {open && (
                <div className="border-t border-black/5 p-4 space-y-3 text-sm">
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                    <Row label="Phone" value={r.phone} />
                    <Row label="Job title" value={r.jobTitle} />
                    <Row label="Employees" value={r.employeeCount} />
                    <Row label="Interested in" value={r.interests.join(", ")} />
                    <Row label="From page" value={r.sourcePage} />
                  </dl>
                  {r.message && (
                    <p className="whitespace-pre-wrap bg-black/[0.03] rounded-lg p-3">{r.message}</p>
                  )}
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block">
                      <span className="block text-xs font-medium text-label-tertiary mb-1">Status</span>
                      <select
                        value={r.status}
                        disabled={savingId === r.id}
                        onChange={(e) => save(r.id, { status: e.target.value as DemoRequestStatus })}
                        className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block flex-1 min-w-[16rem]">
                      <span className="block text-xs font-medium text-label-tertiary mb-1">Internal notes</span>
                      <textarea
                        rows={2}
                        value={notes[r.id] ?? r.internalNotes ?? ""}
                        onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={savingId === r.id || notes[r.id] === undefined}
                      onClick={() => save(r.id, { internalNotes: notes[r.id] })}
                      className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
                    >
                      Save notes
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-label-tertiary">{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}
