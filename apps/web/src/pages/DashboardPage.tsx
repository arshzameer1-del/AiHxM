import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CompanyDashboardRow, ImpersonateResponse } from "@boostfactor/shared-types";
import { api } from "../api/client";
import { StatusPill } from "../components/StatusPill";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

export function DashboardPage() {
  const [companies, setCompanies] = useState<CompanyDashboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [impersonation, setImpersonation] = useState<ImpersonateResponse | null>(null);

  async function load() {
    try {
      setCompanies(await api.listCompanies());
    } catch {
      setError("Could not load companies.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleLoginAs(id: string) {
    try {
      setImpersonation(await api.impersonate(id));
    } catch {
      setError("Could not start a scoped session for this company.");
    }
  }

  const totalMrr = companies?.reduce((sum, c) => sum + c.mockMrrUsd, 0) ?? 0;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
          <p className="text-label-tertiary text-sm">
            Every tenant on the platform. Isolation is enforced by Postgres Row Level Security, not
            just this screen's filters — see DECISIONS.md Decision #1.
          </p>
        </div>
        <Link
          to="/companies/new"
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold whitespace-nowrap"
        >
          + Create Company
        </Link>
      </div>

      {companies && companies.length > 0 && (
        <div className="bg-card rounded-card p-4 shadow-sm mb-6 flex gap-8">
          <div>
            <div className="text-xs uppercase tracking-wide text-label-tertiary">Companies</div>
            <div className="text-xl font-bold">{companies.length}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-label-tertiary">
              Mock MRR (placeholder, no billing yet)
            </div>
            <div className="text-xl font-bold">{pkr.format(totalMrr)}</div>
          </div>
        </div>
      )}

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      <div className="bg-card rounded-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5">
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Admins</th>
              <th className="px-4 py-3">Mock MRR</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {companies?.map((c) => (
              <tr key={c.id} className="border-b border-black/5 last:border-0">
                <td className="px-4 py-3">
                  <Link to={`/companies/${c.id}`} className="font-semibold hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-xs text-label-tertiary">{c.slug}</div>
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={c.status} />
                </td>
                <td className="px-4 py-3 capitalize">{c.packageTier}</td>
                <td className="px-4 py-3">{c.adminCount}</td>
                <td className="px-4 py-3">{pkr.format(c.mockMrrUsd)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleLoginAs(c.id)}
                    className="text-accent text-xs font-semibold hover:underline"
                  >
                    Login As
                  </button>
                </td>
              </tr>
            ))}
            {companies?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-label-tertiary">
                  No companies yet. Create the first one to see isolation prove itself with a second.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {impersonation && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center px-4" onClick={() => setImpersonation(null)}>
          <div
            className="bg-card rounded-card p-6 shadow-sm max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold text-lg mb-2">Scoped session issued</h2>
            <p className="text-sm text-label-secondary mb-3">{impersonation.note}</p>
            <div className="bg-surface rounded-lg p-3 text-xs font-mono break-all mb-4">
              {impersonation.token}
            </div>
            <p className="text-xs text-label-tertiary mb-4">
              Expires in {impersonation.expiresIn}. Logged to the audit log as{" "}
              <code>company.impersonate</code>.
            </p>
            <button
              onClick={() => setImpersonation(null)}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
