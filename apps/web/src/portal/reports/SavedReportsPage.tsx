import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Share2, Trash2 } from "lucide-react";
import type { SavedReportSummary } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { formatDay } from "../shared/dates";
import { ShareDialog } from "./ShareDialog";

function Row({ r, onShare, onDelete }: { r: SavedReportSummary; onShare?: () => void; onDelete?: () => void }) {
  return (
    <li className="bg-card rounded-card p-4 shadow-sm flex flex-wrap items-center gap-3" data-testid={`saved-${r.id}`}>
      <div className="flex-1 min-w-[12rem]">
        <Link to={`/app/reports/saved/${r.id}`} className="font-semibold hover:underline">{r.name}</Link>
        <p className="text-xs text-label-tertiary mt-0.5">
          {r.kind === "custom" ? `Built from ${r.datasetLabel ?? "your data"}` : r.datasetLabel ? `${r.reportId} · ${r.datasetLabel}` : r.reportId}
          {" · updated "}
          {formatDay(r.updatedAt.slice(0, 10))}
          {!r.isOwner && r.ownerName ? ` · from ${r.ownerName}` : ""}
          {r.isOwner && r.sharedWith > 0 ? ` · shared with ${r.sharedWith}` : ""}
        </p>
        {r.description && <p className="text-sm text-label-secondary mt-1">{r.description}</p>}
      </div>
      {onShare && (
        <button type="button" onClick={onShare} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold">
          <Share2 size={14} aria-hidden="true" /> Share
        </button>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} aria-label={`Delete ${r.name}`} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-2.5 py-1.5 text-sm text-danger">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export function SavedReportsPage() {
  const [data, setData] = useState<{ mine: SavedReportSummary[]; shared: SavedReportSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<SavedReportSummary | null>(null);
  const reload = () => api.listSavedReports().then(setData).catch((e) => setError(describeError(e)));
  useEffect(() => {
    void reload();
  }, []);

  const remove = async (r: SavedReportSummary) => {
    if (!window.confirm(`Delete “${r.name}”? Its schedules stop. People it was shared with lose access.`)) return;
    try {
      await api.archiveSavedReport(r.id);
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  };

  if (!data && !error) return <LoadingNote what="saved reports" />;
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="My reports"
        subtitle="Views you saved from the library or built yourself, and reports others shared with you."
        actions={<Link to="/app/reports/builder" className="rounded bg-accent text-white px-3 py-1.5 text-sm font-semibold">New report</Link>}
      />
      {error && <div className="text-danger text-sm mb-3" role="alert">{error}</div>}
      {data && (
        <div className="space-y-8">
          <section aria-labelledby="mine-h">
            <h2 id="mine-h" className="text-sm font-semibold mb-2">Saved by me ({data.mine.length})</h2>
            {data.mine.length === 0 ? (
              <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">
                Nothing saved yet. Open any report in the <Link to="/app/reports/library" className="text-accent font-semibold">library</Link>, set the period and filters you want, then choose “Save this view”.
              </p>
            ) : (
              <ul className="space-y-2">{data.mine.map((r) => <Row key={r.id} r={r} onShare={() => setSharing(r)} onDelete={() => remove(r)} />)}</ul>
            )}
          </section>
          <section aria-labelledby="shared-h">
            <h2 id="shared-h" className="text-sm font-semibold mb-2">Shared with me ({data.shared.length})</h2>
            {data.shared.length === 0 ? (
              <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">No one has shared a report with you.</p>
            ) : (
              <ul className="space-y-2">{data.shared.map((r) => <Row key={r.id} r={r} />)}</ul>
            )}
          </section>
        </div>
      )}
      {sharing && (
        <ShareDialog
          kind="report"
          id={sharing.id}
          name={sharing.name}
          onClose={() => {
            setSharing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
