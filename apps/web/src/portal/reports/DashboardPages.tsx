import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import type { DashboardData, DashboardDetail, DashboardSummary, DashboardWidgetData, DashboardWidgetType, ReportCatalogEntry, SaveDashboardRequest, SavedReportSummary } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { formatDay } from "../shared/dates";
import { ReportChart } from "./charts";
import { KpiCard } from "./ResultView";
import { ShareDialog } from "./ShareDialog";
import { formatCell } from "./reportFormat";

// ---------------------------------------------------------------- list

export function DashboardsPage() {
  const [data, setData] = useState<{ mine: DashboardSummary[]; shared: DashboardSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listDashboards().then(setData).catch((e) => setError(describeError(e)));
  }, []);
  if (!data && !error) return <LoadingNote what="dashboards" />;
  const List = ({ items, empty }: { items: DashboardSummary[]; empty: string }) =>
    items.length === 0 ? (
      <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{empty}</p>
    ) : (
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((d) => (
          <li key={d.id}>
            <Link to={`/app/reports/dashboards/${d.id}`} className="bg-card rounded-card p-4 shadow-sm hover:shadow-md block outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`dashboard-${d.id}`}>
              <span className="font-semibold block">{d.name}</span>
              <span className="text-xs text-label-tertiary block mt-0.5">
                {d.widgetCount} {d.widgetCount === 1 ? "widget" : "widgets"} · updated {formatDay(d.updatedAt.slice(0, 10))}
                {!d.isOwner && d.ownerName ? ` · from ${d.ownerName}` : ""}
              </span>
              {d.description && <span className="text-sm text-label-secondary block mt-1">{d.description}</span>}
            </Link>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Dashboards"
        subtitle="A page of key figures, charts and tables you choose. Each one is a live report, re-run with the viewer’s own access."
        actions={<Link to="/app/reports/dashboards/new" className="inline-flex items-center gap-1.5 rounded bg-accent text-white px-3 py-1.5 text-sm font-semibold"><Plus size={14} aria-hidden="true" /> New dashboard</Link>}
      />
      {error && <div className="text-danger text-sm mb-3" role="alert">{error}</div>}
      {data && (
        <div className="space-y-8">
          <section aria-labelledby="dm-h">
            <h2 id="dm-h" className="text-sm font-semibold mb-2">Mine ({data.mine.length})</h2>
            <List items={data.mine} empty="You have no dashboards yet. Create one to pin the figures you check most." />
          </section>
          <section aria-labelledby="ds-h">
            <h2 id="ds-h" className="text-sm font-semibold mb-2">Shared with me ({data.shared.length})</h2>
            <List items={data.shared} empty="No dashboard has been shared with you." />
          </section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one dashboard

function WidgetView({ w, type, rows }: { w: DashboardWidgetData; type: DashboardWidgetType; rows?: number }) {
  if (!w.ok || !w.result) {
    return (
      <div className="bg-card rounded-card p-4 shadow-sm" role="status">
        <p className="text-xs uppercase tracking-wide text-label-tertiary">{w.title}</p>
        <p className="text-sm text-label-secondary mt-1">{w.error ?? "This widget could not be loaded."}</p>
      </div>
    );
  }
  const r = w.result;
  if (type === "kpi") {
    const k = r.kpis[0];
    return k ? <KpiCard kpi={{ ...k, label: w.title }} to={r.reportId && r.reportId !== "X00" ? `/app/reports/${r.reportId}` : undefined} /> : <p className="bg-card rounded-card p-4 shadow-sm text-sm text-label-secondary">{w.title}: no figure to show.</p>;
  }
  if (type === "chart") {
    const c = r.charts[0];
    return c ? <ReportChart spec={{ ...c, title: w.title }} /> : <p className="bg-card rounded-card p-4 shadow-sm text-sm text-label-secondary">{w.title}: this report has no chart.</p>;
  }
  return (
    <section className="bg-card rounded-card p-4 shadow-sm overflow-x-auto" aria-label={w.title}>
      <h3 className="text-sm font-semibold mb-2">{w.title}</h3>
      {r.rows.length === 0 ? (
        <p className="text-sm text-label-secondary">No records.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary">
              {r.columns.map((c) => (
                <th key={c.key} scope="col" className={`py-1 pr-3 font-semibold ${c.type === "number" || c.type === "percent" ? "text-right" : ""}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.rows.slice(0, rows ?? 8).map((row, i) => (
              <tr key={i} className="border-t border-border">
                {r.columns.map((c) => (
                  <td key={c.key} className={`py-1 pr-3 ${c.type === "number" || c.type === "percent" ? "text-right tabular-nums" : ""}`}>{formatCell(row[c.key], c.type)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

type DraftWidget = { widgetType: DashboardWidgetType; reportId: string | null; savedReportId: string | null; title: string; label: string };

function Editor({ initial, onSaved, onCancel }: { initial: DashboardDetail | null; onSaved: (d: DashboardDetail) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [widgets, setWidgets] = useState<DraftWidget[]>([]);
  const [catalog, setCatalog] = useState<ReportCatalogEntry[]>([]);
  const [saved, setSaved] = useState<SavedReportSummary[]>([]);
  const [source, setSource] = useState("");
  const [type, setType] = useState<DashboardWidgetType>("kpi");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getReportCatalog().then((c) => setCatalog(c.entries.filter((e) => e.status === "available"))).catch(() => undefined);
    api.listSavedReports().then((s) => setSaved([...s.mine, ...s.shared])).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!initial) return;
    setWidgets(initial.widgets.map((w) => ({ widgetType: w.widgetType, reportId: w.reportId, savedReportId: w.savedReportId, title: w.title ?? "", label: w.title ?? w.reportId ?? "Saved report" })));
  }, [initial]);

  const labelFor = (value: string) => {
    if (value.startsWith("r:")) return catalog.find((e) => e.id === value.slice(2))?.title ?? value.slice(2);
    return saved.find((s) => s.id === value.slice(2))?.name ?? "Saved report";
  };
  const add = () => {
    if (!source) return;
    if (widgets.length >= 12) {
      setError("A dashboard can hold up to 12 widgets.");
      return;
    }
    setError(null);
    setWidgets([...widgets, { widgetType: type, reportId: source.startsWith("r:") ? source.slice(2) : null, savedReportId: source.startsWith("s:") ? source.slice(2) : null, title: "", label: labelFor(source) }]);
    setSource("");
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= widgets.length) return;
    const next = [...widgets];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setWidgets(next);
  };
  const save = async () => {
    if (!name.trim()) {
      setError("Give the dashboard a name.");
      return;
    }
    setBusy(true);
    setError(null);
    const body: SaveDashboardRequest = {
      name: name.trim(),
      description: description.trim() || null,
      widgets: widgets.map((w) => ({ widgetType: w.widgetType, reportId: w.reportId, savedReportId: w.savedReportId, title: w.title.trim() || null })),
    };
    try {
      onSaved(initial ? await api.updateDashboard(initial.id, body) : await api.saveDashboard(body));
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-card p-4 shadow-sm grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="d-name" className="block text-xs text-label-tertiary mb-1">Dashboard name</label>
          <input id="d-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-black/25 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label htmlFor="d-desc" className="block text-xs text-label-tertiary mb-1">Description (optional)</label>
          <input id="d-desc" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded border border-black/25 px-2 py-1.5 text-sm" />
        </div>
      </div>

      <div className="bg-card rounded-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold mb-3">Widgets ({widgets.length}/12)</h2>
        {widgets.length === 0 && <p className="text-sm text-label-secondary mb-3">Nothing here yet. Add a figure, a chart or a table from any report you can run.</p>}
        <ol className="space-y-2 mb-4">
          {widgets.map((w, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 border border-border rounded p-2">
              <span className="text-xs rounded bg-black/5 px-2 py-0.5 font-semibold">{w.widgetType === "kpi" ? "Figure" : w.widgetType === "chart" ? "Chart" : "Table"}</span>
              <span className="text-sm flex-1 min-w-[8rem]">{w.label}</span>
              <label className="sr-only" htmlFor={`wt-${i}`}>Title of widget {i + 1}</label>
              <input id={`wt-${i}`} placeholder="Own title (optional)" maxLength={120} value={w.title} onChange={(e) => setWidgets(widgets.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} className="rounded border border-black/25 px-2 py-1 text-sm w-48" />
              <button type="button" aria-label={`Move widget ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0} className="p-1 disabled:opacity-30"><ArrowUp size={14} /></button>
              <button type="button" aria-label={`Move widget ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === widgets.length - 1} className="p-1 disabled:opacity-30"><ArrowDown size={14} /></button>
              <button type="button" aria-label={`Remove widget ${i + 1}`} onClick={() => setWidgets(widgets.filter((_, j) => j !== i))} className="p-1 text-danger"><Trash2 size={14} /></button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label htmlFor="w-type" className="block text-xs text-label-tertiary mb-1">Show as</label>
            <select id="w-type" value={type} onChange={(e) => setType(e.target.value as DashboardWidgetType)} className="rounded border border-black/25 px-2 py-1.5 text-sm">
              <option value="kpi">A key figure</option>
              <option value="chart">A chart</option>
              <option value="table">A table</option>
            </select>
          </div>
          <div className="flex-1 min-w-[14rem]">
            <label htmlFor="w-source" className="block text-xs text-label-tertiary mb-1">From</label>
            <select id="w-source" value={source} onChange={(e) => setSource(e.target.value)} className="w-full rounded border border-black/25 px-2 py-1.5 text-sm">
              <option value="">Choose a report…</option>
              {saved.length > 0 && (
                <optgroup label="My saved reports">
                  {saved.map((s) => (
                    <option key={s.id} value={`s:${s.id}`}>{s.name}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Report library">
                {catalog.map((e) => (
                  <option key={e.id} value={`r:${e.id}`}>{e.id} · {e.title}</option>
                ))}
              </optgroup>
            </select>
          </div>
          <button type="button" onClick={add} disabled={!source} className="rounded border border-black/25 px-3 py-1.5 text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-1"><Plus size={14} aria-hidden="true" /> Add widget</button>
        </div>
      </div>

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={busy} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save dashboard"}</button>
        <button type="button" onClick={onCancel} className="rounded border border-black/25 px-4 py-1.5 text-sm font-semibold">Cancel</button>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const isNew = id === "new";
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(isNew);
  const [sharing, setSharing] = useState(false);

  const load = () => {
    setData(null);
    setError(null);
    api.getDashboardData(id).then(setData).catch((e) => setError(describeError(e)));
  };
  useEffect(() => {
    setEditing(isNew);
    if (!isNew) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const widgetsById = useMemo(() => new Map((data?.dashboard.widgets ?? []).map((w) => [w.id, w])), [data]);

  if (isNew)
    return (
      <div className="max-w-5xl">
        <BackLink to="/app/reports/dashboards">Dashboards</BackLink>
        <PageHeader title="New dashboard" />
        <Editor initial={null} onSaved={(d) => navigate(`/app/reports/dashboards/${d.id}`, { replace: true })} onCancel={() => navigate("/app/reports/dashboards")} />
      </div>
    );
  if (error)
    return (
      <div>
        <BackLink to="/app/reports/dashboards">Dashboards</BackLink>
        <div className="text-danger text-sm" role="alert">{error}</div>
      </div>
    );
  if (!data) return <LoadingNote what="dashboard" />;
  const d = data.dashboard;

  const remove = async () => {
    if (!window.confirm(`Delete “${d.name}”? People it was shared with lose access.`)) return;
    try {
      await api.archiveDashboard(d.id);
      navigate("/app/reports/dashboards");
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="max-w-6xl">
      <BackLink to="/app/reports/dashboards">Dashboards</BackLink>
      <PageHeader
        title={d.name}
        subtitle={d.description ?? (!d.isOwner && d.ownerName ? `Shared by ${d.ownerName}` : undefined)}
        actions={
          d.isOwner ? (
            <>
              <button type="button" onClick={() => setSharing(true)} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold"><Share2 size={14} aria-hidden="true" /> Share</button>
              <button type="button" onClick={() => setEditing((e) => !e)} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold"><Pencil size={14} aria-hidden="true" /> {editing ? "Close editor" : "Edit"}</button>
              <button type="button" onClick={remove} className="rounded border border-black/25 px-2.5 py-1.5 text-sm text-danger" aria-label={`Delete ${d.name}`}><Trash2 size={14} aria-hidden="true" /></button>
            </>
          ) : undefined
        }
      />
      {editing && d.isOwner ? (
        <Editor initial={d} onSaved={() => { setEditing(false); load(); }} onCancel={() => setEditing(false)} />
      ) : d.widgets.length === 0 ? (
        <p className="bg-card rounded-card p-8 shadow-sm text-sm text-label-secondary text-center">This dashboard is empty.{d.isOwner ? " Use Edit to add widgets." : ""}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="dashboard-grid">
          {data.widgets.map((w) => {
            const meta = widgetsById.get(w.widgetId);
            const type = meta?.widgetType ?? "table";
            const span = type === "kpi" ? "" : type === "chart" ? "sm:col-span-2" : "sm:col-span-2 lg:col-span-4";
            return (
              <div key={w.widgetId} className={span}>
                <WidgetView w={w} type={type} rows={meta?.config.rows} />
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-label-tertiary mt-6">Every widget is re-run when you open this page, with your own access. A widget you cannot run shows a message instead of data.</p>
      {sharing && <ShareDialog kind="dashboard" id={d.id} name={d.name} onClose={() => setSharing(false)} />}
    </div>
  );
}
