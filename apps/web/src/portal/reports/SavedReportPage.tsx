import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CalendarClock, Pencil } from "lucide-react";
import type { ReportExportFormat, ReportResult, SavedReportDetail } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { ExportMenu } from "./ExportMenu";
import { ResultView } from "./ResultView";
import { presetLabel } from "./reportFormat";

/** Opens a saved or shared report: re-run live with the viewer's own access, never a stored copy of numbers. */
export function SavedReportPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [saved, setSaved] = useState<SavedReportDetail | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [canExport, setCanExport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setResult(null);
    setError(null);
    api
      .runSavedReport(id)
      .then((r) => {
        if (cancelled) return;
        setSaved(r.saved);
        setResult(r.result);
        setCanExport(r.canExport);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError && e.status === 404 ? "This report does not exist, or it is no longer shared with you." : describeError(e));
        api.getSavedReport(id).then((s) => !cancelled && setSaved(s)).catch(() => undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const doExport = async (format: ReportExportFormat) => {
    setExporting(true);
    setExportError(null);
    try {
      await api.exportSavedReport(id, format);
    } catch (e) {
      setExportError(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  if (error && !saved)
    return (
      <div>
        <BackLink to="/app/reports/saved">My reports</BackLink>
        <div className="text-danger text-sm" role="alert">{error}</div>
      </div>
    );
  if (!saved && !error) return <LoadingNote what="report" />;

  const subtitle = saved
    ? saved.kind === "catalog"
      ? `${saved.reportId} · ${saved.datasetLabel ?? ""} · ${presetLabel(saved.preset)}${saved.compare ? " · compared with the previous period" : ""}`
      : `Built from ${saved.datasetLabel ?? "your data"}`
    : undefined;
  return (
    <div className="max-w-6xl">
      <BackLink to="/app/reports/saved">My reports</BackLink>
      <PageHeader
        title={saved?.name ?? "Saved report"}
        subtitle={saved && !saved.isOwner && saved.ownerName ? `Shared by ${saved.ownerName}. ${subtitle ?? ""}` : subtitle}
        actions={
          <>
            {saved?.isOwner && saved.kind === "custom" && (
              <button type="button" onClick={() => navigate(`/app/reports/builder/${saved.id}`)} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold">
                <Pencil size={14} aria-hidden="true" /> Edit
              </button>
            )}
            {saved?.isOwner && (
              <Link to={`/app/reports/schedules?saved=${saved.id}`} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold">
                <CalendarClock size={14} aria-hidden="true" /> Schedule
              </Link>
            )}
            <ExportMenu onExport={doExport} disabled={!canExport || !result} busy={exporting} title={canExport ? "Download the rows. Every export is recorded." : "You do not have permission to export this report."} />
          </>
        }
      />
      {saved?.description && <p className="text-sm text-label-secondary mb-3">{saved.description}</p>}
      {exportError && <div className="text-danger text-sm mb-3" role="alert">{exportError}</div>}
      {error && <div className="bg-card rounded-card p-4 shadow-sm text-sm text-danger" role="alert" data-testid="report-error">{error}</div>}
      {result && <ResultView result={result} sourceNote={saved?.kind === "custom" ? "Report Builder" : undefined} />}
    </div>
  );
}
