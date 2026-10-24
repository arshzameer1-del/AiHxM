import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import type { BuilderCatalogResponse, BuilderDatasetInfo, ReportExportFormat, ReportResult } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { ExportMenu } from "./ExportMenu";
import { ResultView } from "./ResultView";
import { AGGREGATE_LABEL, EMPTY_FORM, OPS_BY_TYPE, aggregatesFor, describeForm, fromDefinition, outputColumns, toDefinition, type BuilderForm } from "./builderModel";

const inputCls = "rounded border border-black/25 px-2 py-1.5 text-sm";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card rounded-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="text-xs text-label-tertiary mt-0.5 mb-3">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

/** Build a table or chart over an allowlisted set of company data. Nothing here is free-form SQL: the server accepts only the fields it lists. */
export function BuilderPage() {
  const { savedId } = useParams();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<BuilderCatalogResponse | null>(null);
  const [form, setForm] = useState<BuilderForm>(EMPTY_FORM);
  const [name, setName] = useState("");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [values, setValues] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .getBuilderDatasets()
      .then(async (c) => {
        if (cancelled) return;
        setCatalog(c);
        if (savedId) {
          const s = await api.getSavedReport(savedId);
          if (cancelled || !s.definition) return;
          setForm(fromDefinition(s.definition));
          setName(s.name);
        } else if (c.datasets[0]) {
          setForm((f) => ({ ...f, dataset: c.datasets[0]!.key }));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [savedId]);

  const dataset: BuilderDatasetInfo | undefined = useMemo(() => catalog?.datasets.find((d) => d.key === form.dataset), [catalog, form.dataset]);
  const definition = useMemo(() => toDefinition(form, dataset), [form, dataset]);
  const outputs = useMemo(() => outputColumns(form, dataset), [form, dataset]);
  const set = (patch: Partial<BuilderForm>) => setForm((f) => ({ ...f, ...patch }));

  const loadValues = (field: string) => {
    if (!dataset || values[`${dataset.key}.${field}`]) return;
    api.getBuilderFieldValues(dataset.key, field).then((v) => setValues((m) => ({ ...m, [`${dataset.key}.${field}`]: v }))).catch(() => undefined);
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      setResult(await api.runBuilder(definition, name || undefined));
    } catch (e) {
      setResult(null);
      setError(describeError(e));
    } finally {
      setRunning(false);
    }
  };
  const save = async () => {
    if (!name.trim()) {
      setError("Give the report a name before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), kind: "custom" as const, definition };
      const s = savedId ? await api.updateSavedReport(savedId, body) : await api.saveReport(body);
      setNotice(`Saved “${s.name}”.`);
      if (!savedId) navigate(`/app/reports/builder/${s.id}`, { replace: true });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  const doExport = async (format: ReportExportFormat) => {
    setExporting(true);
    setError(null);
    try {
      await api.exportBuilder(definition, format, name || undefined);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  if (forbidden)
    return (
      <div className="max-w-2xl">
        <PageHeader title="Report Builder" />
        <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary" role="alert">You do not have permission to use the Report Builder. Ask your HR administrator for the “Create reports with the Report Builder” right.</p>
      </div>
    );
  if (!catalog && !error) return <LoadingNote what="data sets" />;
  if (!catalog) return <div className="text-danger text-sm" role="alert">{error}</div>;

  const fields = dataset?.fields ?? [];
  const canRun = form.mode === "list" ? form.columns.length > 0 : form.measures.some((m) => m.aggregate === "count" || m.field);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={savedId ? "Edit report" : "Report Builder"}
        subtitle="Choose what to report on, how to group it and what to leave out. You only ever see the records you are allowed to see."
        actions={<Link to="/app/reports/saved" className="text-sm font-semibold text-accent hover:underline">My reports</Link>}
      />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr] items-start">
        <div className="space-y-3">
          <Section title="1. What is it about?">
            <label htmlFor="b-dataset" className="sr-only">Data set</label>
            <select id="b-dataset" value={form.dataset} onChange={(e) => setForm({ ...EMPTY_FORM, dataset: e.target.value, mode: form.mode })} className={`${inputCls} w-full`}>
              {catalog.datasets.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
            {dataset && <p className="text-xs text-label-tertiary mt-2">{dataset.description}{dataset.scope === "team" ? " Limited to your direct reports." : ""}</p>}
          </Section>

          <Section title="2. What do you want to see?">
            <div role="radiogroup" aria-label="Report type" className="flex gap-1 mb-3">
              {(["summary", "list"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={form.mode === m} onClick={() => set({ mode: m, sortBy: "" })} className={`flex-1 rounded px-3 py-1.5 text-sm font-semibold border ${form.mode === m ? "bg-accent text-white border-accent" : "border-black/25 text-label-secondary"}`}>
                  {m === "summary" ? "Totals and counts" : "List of records"}
                </button>
              ))}
            </div>
            {form.mode === "list" ? (
              <fieldset>
                <legend className="sr-only">Columns</legend>
                {fields.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" checked={form.columns.includes(f.key)} onChange={(e) => set({ columns: e.target.checked ? [...form.columns, f.key] : form.columns.filter((c) => c !== f.key) })} />
                    {f.label}
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="space-y-4">
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Group by (up to 3)</h3>
                  {form.groups.map((g, i) => {
                    const info = fields.find((f) => f.key === g.field);
                    return (
                      <div key={i} className="flex gap-1 mb-1">
                        <select aria-label={`Group ${i + 1}`} value={g.field} onChange={(e) => set({ groups: form.groups.map((x, j) => (j === i ? { field: e.target.value, bucket: "" } : x)) })} className={`${inputCls} flex-1 min-w-0`}>
                          <option value="">Choose…</option>
                          {fields.filter((f) => f.groupable).map((f) => (
                            <option key={f.key} value={f.key}>{f.label}</option>
                          ))}
                        </select>
                        {info?.type === "date" && (
                          <select aria-label={`Group ${i + 1} period`} value={g.bucket} onChange={(e) => set({ groups: form.groups.map((x, j) => (j === i ? { ...x, bucket: e.target.value as "" | "month" | "year" } : x)) })} className={inputCls}>
                            <option value="month">by month</option>
                            <option value="year">by year</option>
                            <option value="">exact day</option>
                          </select>
                        )}
                        <button type="button" aria-label={`Remove group ${i + 1}`} onClick={() => set({ groups: form.groups.filter((_, j) => j !== i) })} className="p-1.5 text-label-tertiary hover:text-danger"><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                  {form.groups.length < 3 && (
                    <button type="button" onClick={() => set({ groups: [...form.groups, { field: "", bucket: "" }] })} className="text-sm font-semibold text-accent inline-flex items-center gap-1"><Plus size={14} /> Add a group</button>
                  )}
                </div>
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Figures</h3>
                  {form.measures.map((m, i) => {
                    const info = fields.find((f) => f.key === m.field);
                    const aggs = aggregatesFor(info);
                    return (
                      <div key={i} className="flex gap-1 mb-1">
                        <select aria-label={`Figure ${i + 1} calculation`} value={m.aggregate} onChange={(e) => set({ measures: form.measures.map((x, j) => (j === i ? { ...x, aggregate: e.target.value as typeof m.aggregate } : x)) })} className={inputCls}>
                          {(["count", "sum", "avg", "min", "max"] as const).map((a) => (
                            <option key={a} value={a}>{AGGREGATE_LABEL[a]}</option>
                          ))}
                        </select>
                        <select aria-label={`Figure ${i + 1} field`} value={m.field} onChange={(e) => {
                          const f = fields.find((x) => x.key === e.target.value);
                          const ok = aggregatesFor(f);
                          set({ measures: form.measures.map((x, j) => (j === i ? { field: e.target.value, aggregate: ok.includes(x.aggregate) ? x.aggregate : "count" } : x)) });
                        }} className={`${inputCls} flex-1 min-w-0`}>
                          <option value="">{m.aggregate === "count" ? "records" : "Choose…"}</option>
                          {fields.filter((f) => (m.aggregate === "count" ? true : aggregatesFor(f).includes(m.aggregate))).map((f) => (
                            <option key={f.key} value={f.key}>{f.label}</option>
                          ))}
                        </select>
                        <button type="button" aria-label={`Remove figure ${i + 1}`} onClick={() => set({ measures: form.measures.filter((_, j) => j !== i) })} className="p-1.5 text-label-tertiary hover:text-danger" disabled={form.measures.length === 1}><Trash2 size={14} /></button>
                        {m.field && !aggs.includes(m.aggregate) && <span className="sr-only">Not available for this field</span>}
                      </div>
                    );
                  })}
                  {form.measures.length < 6 && (
                    <button type="button" onClick={() => set({ measures: [...form.measures, { aggregate: "sum", field: "" }] })} className="text-sm font-semibold text-accent inline-flex items-center gap-1"><Plus size={14} /> Add a figure</button>
                  )}
                </div>
              </div>
            )}
          </Section>

          <Section title="3. Leave out" hint="Only records that match every line are included.">
            {form.filters.map((f, i) => {
              const info = fields.find((x) => x.key === f.field);
              const ops = OPS_BY_TYPE[info?.type ?? "text"] ?? OPS_BY_TYPE.text!;
              const listId = `vals-${i}`;
              const needsValue = f.op !== "isNull" && f.op !== "notNull";
              return (
                <div key={i} className="flex flex-wrap gap-1 mb-2">
                  <select aria-label={`Filter ${i + 1} field`} value={f.field} onChange={(e) => { const nf = fields.find((x) => x.key === e.target.value); set({ filters: form.filters.map((x, j) => (j === i ? { field: e.target.value, op: (OPS_BY_TYPE[nf?.type ?? "text"] ?? OPS_BY_TYPE.text!)[0]!.op, value: "" } : x)) }); if (nf?.type === "text" && nf.groupable) loadValues(nf.key); }} className={`${inputCls} flex-1 min-w-[8rem]`}>
                    <option value="">Field…</option>
                    {fields.map((x) => (
                      <option key={x.key} value={x.key}>{x.label}</option>
                    ))}
                  </select>
                  <select aria-label={`Filter ${i + 1} condition`} value={f.op} onChange={(e) => set({ filters: form.filters.map((x, j) => (j === i ? { ...x, op: e.target.value as typeof f.op } : x)) })} className={inputCls}>
                    {ops.map((o) => (
                      <option key={o.op} value={o.op}>{o.label}</option>
                    ))}
                  </select>
                  {needsValue && (
                    <>
                      <input aria-label={`Filter ${i + 1} value`} list={listId} type={info?.type === "date" && f.op !== "in" ? "date" : "text"} value={f.value} placeholder={f.op === "in" ? "a, b, c" : "value"} onChange={(e) => set({ filters: form.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={`${inputCls} w-full`} />
                      {info && <datalist id={listId}>{(values[`${dataset?.key}.${info.key}`] ?? []).map((v) => <option key={v} value={v} />)}</datalist>}
                    </>
                  )}
                  <button type="button" aria-label={`Remove filter ${i + 1}`} onClick={() => set({ filters: form.filters.filter((_, j) => j !== i) })} className="p-1.5 text-label-tertiary hover:text-danger"><Trash2 size={14} /></button>
                </div>
              );
            })}
            {form.filters.length < 20 && (
              <button type="button" onClick={() => set({ filters: [...form.filters, { field: "", op: "eq", value: "" }] })} className="text-sm font-semibold text-accent inline-flex items-center gap-1"><Plus size={14} /> Add a filter</button>
            )}
          </Section>

          <Section title="4. Order and size">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="b-sort" className="block text-xs text-label-tertiary mb-1">Sort by</label>
                <select id="b-sort" value={form.sortBy} onChange={(e) => set({ sortBy: e.target.value })} className={`${inputCls} w-full`}>
                  <option value="">Default</option>
                  {outputs.map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="b-dir" className="block text-xs text-label-tertiary mb-1">Direction</label>
                <select id="b-dir" value={form.sortDir} onChange={(e) => set({ sortDir: e.target.value as "asc" | "desc" })} className={`${inputCls} w-full`}>
                  <option value="desc">Largest first</option>
                  <option value="asc">Smallest first</option>
                </select>
              </div>
              <div>
                <label htmlFor="b-limit" className="block text-xs text-label-tertiary mb-1">Most rows (1–1000)</label>
                <input id="b-limit" inputMode="numeric" value={form.limit} onChange={(e) => set({ limit: e.target.value.replace(/\D/g, "") })} className={`${inputCls} w-full`} placeholder="All" />
              </div>
              {form.mode === "summary" && (
                <div>
                  <label htmlFor="b-chart" className="block text-xs text-label-tertiary mb-1">Chart</label>
                  <select id="b-chart" value={form.chart} onChange={(e) => set({ chart: e.target.value as BuilderForm["chart"] })} className={`${inputCls} w-full`}>
                    <option value="auto">Pick for me</option>
                    <option value="bar">Bars</option>
                    <option value="line">Line over time</option>
                    <option value="donut">Share of total</option>
                    <option value="none">No chart</option>
                  </select>
                </div>
              )}
            </div>
          </Section>
        </div>

        <div className="space-y-4 min-w-0">
          <div className="bg-card rounded-card p-4 shadow-sm flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[12rem]">
              <label htmlFor="b-name" className="block text-xs text-label-tertiary mb-1">Report name</label>
              <input id="b-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full`} placeholder="e.g. Headcount by department" />
            </div>
            <button type="button" onClick={run} disabled={running || !canRun} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{running ? "Running…" : "Run"}</button>
            <button type="button" onClick={save} disabled={saving || !canRun} className="rounded border border-black/25 px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : savedId ? "Save changes" : "Save"}</button>
            <ExportMenu onExport={doExport} disabled={!canRun} busy={exporting} title="Download the report. Needs export permission; every export is recorded." />
            <p className="basis-full text-xs text-label-tertiary" aria-live="polite">{describeForm(form, dataset)}</p>
          </div>
          {notice && <p className="text-sm text-success" role="status">{notice}</p>}
          {error && <div className="bg-card rounded-card p-4 shadow-sm text-sm text-danger" role="alert" data-testid="report-error">{error}</div>}
          {!result && !running && !error && <p className="bg-card rounded-card p-8 shadow-sm text-sm text-label-secondary text-center">Choose what you want to see, then press Run. Nothing is shown until you do, and nothing is stored until you save.</p>}
          {result && <ResultView result={result} sourceNote="Report Builder" />}
        </div>
      </div>
    </div>
  );
}
