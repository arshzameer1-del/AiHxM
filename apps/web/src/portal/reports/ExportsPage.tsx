import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ReportExportHistoryItem } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { formatDateTime } from "../shared/dates";

const FORMAT: Record<string, string> = { xlsx: "Excel", csv: "CSV", pdf: "PDF" };

/** Your own export history: what you downloaded and when. The rows are never stored; every export is also in the audit log. */
export function ExportsPage() {
  const [rows, setRows] = useState<ReportExportHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getReportExportHistory().then(setRows).catch((e) => setError(describeError(e)));
  }, []);
  if (error) return <div className="text-danger text-sm" role="alert">{error}</div>;
  if (!rows) return <LoadingNote what="exports" />;
  return (
    <div className="max-w-4xl">
      <PageHeader title="My exports" subtitle="The last 50 files you downloaded. Only the report name, format and size are kept, never the data." />
      {rows.length === 0 ? (
        <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">You have not exported anything yet. Use Export on any report.</p>
      ) : (
        <div className="bg-card rounded-card p-4 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary">
                <th className="py-1.5 pr-4 font-semibold">When</th><th className="py-1.5 pr-4 font-semibold">Report</th><th className="py-1.5 pr-4 font-semibold">File</th><th className="py-1.5 pr-4 font-semibold text-right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1.5 pr-4 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                  <td className="py-1.5 pr-4">{r.reportId === "X00" ? (r.title ?? "Custom report") : <Link to={`/app/reports/${r.reportId}`} className="text-accent hover:underline">{r.reportId} · {r.title ?? ""}</Link>}</td>
                  <td className="py-1.5 pr-4">{FORMAT[r.format] ?? r.format}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{r.rowCount ?? "—"}{r.partial ? " (partial)" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
