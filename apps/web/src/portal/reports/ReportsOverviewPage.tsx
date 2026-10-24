import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BarChart3, CalendarClock, LayoutDashboard, Share2, Wrench } from "lucide-react";
import type { ReportCatalogResponse, ReportsOverview } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { KpiCard } from "./ResultView";

function Shortcut({ to, icon: Icon, title, text }: { to: string; icon: typeof BarChart3; title: string; text: string }) {
  return (
    <Link to={to} className="bg-card rounded-card p-4 shadow-sm hover:shadow-md outline-none focus-visible:ring-2 focus-visible:ring-accent flex gap-3">
      <Icon size={20} className="text-accent shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        <span className="block font-semibold text-sm">{title}</span>
        <span className="block text-xs text-label-secondary mt-0.5">{text}</span>
      </span>
    </Link>
  );
}

/** The landing page of Reports & Analytics: headline figures, what needs attention, and the shortcuts. Only real report results appear. */
export function ReportsOverviewPage() {
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [catalog, setCatalog] = useState<ReportCatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getReportsOverview().then((r) => !cancelled && setData(r)).catch((e) => !cancelled && setError(describeError(e)));
    api.getReportCatalog().then((r) => !cancelled && setCatalog(r)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="text-danger text-sm" role="alert">{error}</div>;
  if (!data) return <LoadingNote what="overview" />;
  const title = (id: string) => catalog?.entries.find((e) => e.id === id)?.title ?? id;
  const links = [...new Set([...data.favorites, ...data.recent])].slice(0, 8);

  return (
    <div className="max-w-6xl">
      <PageHeader title="Reports & Analytics" subtitle="Live figures from your own records, limited to what you are allowed to see." />

      {data.kpis.length > 0 ? (
        <section aria-label="Headline figures" className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6" data-testid="overview-kpis">
          {data.kpis.map((k) => (
            <KpiCard key={`${k.reportId}-${k.key}`} kpi={k} to={k.reportId ? `/app/reports/${k.reportId}` : undefined} />
          ))}
        </section>
      ) : (
        <p className="text-sm text-label-secondary mb-6">No headline figures are available to you yet. Open the Library to see which reports you can run.</p>
      )}

      {data.highlights.length > 0 && (
        <section aria-labelledby="attn-h" className="bg-card rounded-card p-5 shadow-sm mb-6" data-testid="overview-attention">
          <h2 id="attn-h" className="text-sm font-semibold mb-2 inline-flex items-center gap-1.5">
            <AlertTriangle size={15} className="text-warning" aria-hidden="true" /> Needs attention
          </h2>
          <ul className="divide-y divide-border">
            {data.highlights.map((h) => (
              <li key={h.reportId} className="py-2 flex items-center justify-between gap-3 text-sm">
                <span>{h.message}</span>
                <Link to={`/app/reports/${h.reportId}`} className="text-accent font-semibold hover:underline shrink-0">{h.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Shortcuts" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <Shortcut to="/app/reports/saved" icon={Share2} title={`My reports (${data.mine})`} text={data.sharedWithMe > 0 ? `${data.sharedWithMe} shared with you` : "Saved views you can reopen or share"} />
        <Shortcut to="/app/reports/dashboards" icon={LayoutDashboard} title={`Dashboards (${data.dashboards})`} text="Your own page of key figures and charts" />
        <Shortcut to="/app/reports/builder" icon={Wrench} title="Report Builder" text="Build a table or chart from your data" />
        <Shortcut to="/app/reports/schedules" icon={CalendarClock} title={`Scheduled (${data.schedules})`} text="Get a report by email or in the app on a schedule" />
      </section>

      {links.length > 0 && (
        <section aria-labelledby="quick-h" className="bg-card rounded-card p-5 shadow-sm">
          <h2 id="quick-h" className="text-sm font-semibold mb-2">Favorites and recently opened</h2>
          <ul className="grid gap-x-6 sm:grid-cols-2">
            {links.map((id) => (
              <li key={id} className="py-1.5 text-sm border-t border-border first:border-t-0 sm:[&:nth-child(2)]:border-t-0">
                <Link to={`/app/reports/${id}`} className="hover:underline">
                  <span className="text-xs font-mono text-label-tertiary mr-1.5">{id}</span>
                  {title(id)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
