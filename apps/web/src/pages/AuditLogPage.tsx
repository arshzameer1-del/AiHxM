import { useEffect, useState } from "react";
import type { AuditLogEntry, CompanyDashboardRow } from "@boostfactor/shared-types";
import { api } from "../api/client";

const dateFormat = new Intl.DateTimeFormat("en-PK", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [companies, setCompanies] = useState<CompanyDashboardRow[]>([]);
  const [companyFilter, setCompanyFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listCompanies().then(setCompanies).catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .listAuditLog(companyFilter || undefined)
      .then(setEntries)
      .catch(() => setError("Could not load the audit log."));
  }, [companyFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-label-tertiary text-sm">
            Append-only at the database level (see migration 0001) — nothing in this app can edit
            or delete an entry, including this screen.
          </p>
        </div>
        <select
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      <div className="bg-card rounded-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Target</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((entry) => (
              <tr key={entry.id} className="border-b border-black/5 last:border-0 align-top">
                <td className="px-4 py-3 whitespace-nowrap text-label-tertiary text-xs">
                  {dateFormat.format(new Date(entry.createdAt))}
                </td>
                <td className="px-4 py-3">{entry.companyName ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{entry.action}</td>
                <td className="px-4 py-3 text-xs">{entry.actor}</td>
                <td className="px-4 py-3 text-xs text-label-tertiary">{entry.target ?? "—"}</td>
              </tr>
            ))}
            {entries?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-label-tertiary">
                  No activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
