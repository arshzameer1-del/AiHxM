import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, History, Pause, Play, Send, Trash2 } from "lucide-react";
import type {
  ReportCatalogEntry,
  ReportDatePreset,
  ReportDeliverySummary,
  ReportExportFormat,
  ReportInboxItem,
  ReportScheduleFrequency,
  ReportScheduleSummary,
  SavedReportSummary,
  ShareTargets,
} from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { formatDateTime } from "../shared/dates";
import { PRESET_OPTIONS } from "./reportFormat";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
const cadence = (s: Pick<ReportScheduleSummary, "frequency" | "dayOfWeek" | "dayOfMonth" | "hourLocal">) =>
  `${s.frequency === "daily" ? "Every day" : s.frequency === "weekly" ? `Every ${DAYS[s.dayOfWeek ?? 1]}` : `On day ${s.dayOfMonth} of every month`} at ${hourLabel(s.hourLocal)}`;
const FORMAT_LABEL: Record<ReportExportFormat, string> = { xlsx: "Excel", csv: "CSV", pdf: "PDF" };

const STATUS_TONE: Record<string, string> = { active: "bg-success/10 text-success", paused: "bg-black/5 text-label-secondary", failed: "bg-danger/10 text-danger" };

type Form = {
  name: string;
  source: string; // "r:A03" or "s:<uuid>"
  preset: ReportDatePreset | "";
  frequency: ReportScheduleFrequency;
  dayOfWeek: number;
  dayOfMonth: number;
  hourLocal: number;
  format: ReportExportFormat;
  recipients: Set<string>;
};
const BLANK: Form = { name: "", source: "", preset: "", frequency: "weekly", dayOfWeek: 1, dayOfMonth: 1, hourLocal: 7, format: "xlsx", recipients: new Set() };

function ScheduleForm({ initial, editingId, catalog, saved, targets, onDone, onCancel }: {
  initial: Form;
  editingId: string | null;
  catalog: ReportCatalogEntry[];
  saved: SavedReportSummary[];
  targets: ShareTargets | null;
  onDone: (warnings: string[]) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const isCatalog = f.source.startsWith("r:");
  const entry = isCatalog ? catalog.find((e) => e.id === f.source.slice(2)) : undefined;
  const hasDates = !!entry?.filters.includes("dateRange");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: f.name.trim(),
      reportId: isCatalog ? f.source.slice(2) : null,
      savedReportId: !isCatalog && f.source ? f.source.slice(2) : null,
      preset: isCatalog && f.preset ? f.preset : null,
      frequency: f.frequency,
      dayOfWeek: f.frequency === "weekly" ? f.dayOfWeek : null,
      dayOfMonth: f.frequency === "monthly" ? f.dayOfMonth : null,
      hourLocal: f.hourLocal,
      format: f.format,
      recipientUserIds: [...f.recipients],
    };
    try {
      const s = editingId ? await api.updateReportSchedule(editingId, body) : await api.createReportSchedule(body);
      onDone(s.warnings ?? []);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  const input = "rounded border border-black/25 px-2 py-1.5 text-sm";
  return (
    <form onSubmit={submit} className="bg-card rounded-card p-5 shadow-sm space-y-4" aria-label={editingId ? "Edit schedule" : "New schedule"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="s-name" className="block text-xs text-label-tertiary mb-1">Name</label>
          <input id="s-name" required maxLength={120} value={f.name} onChange={(e) => set({ name: e.target.value })} className={`${input} w-full`} placeholder="e.g. Monday leave summary" />
        </div>
        <div>
          <label htmlFor="s-source" className="block text-xs text-label-tertiary mb-1">Report</label>
          <select id="s-source" required value={f.source} onChange={(e) => set({ source: e.target.value, preset: "" })} className={`${input} w-full`}>
            <option value="">Choose a report…</option>
            {saved.filter((s) => s.isOwner).length > 0 && (
              <optgroup label="My saved reports">
                {saved.filter((s) => s.isOwner).map((s) => (
                  <option key={s.id} value={`s:${s.id}`}>{s.name}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Report library">
              {catalog.filter((e) => e.canExport).map((e) => (
                <option key={e.id} value={`r:${e.id}`}>{e.id} · {e.title}</option>
              ))}
            </optgroup>
          </select>
        </div>
        {hasDates && (
          <div>
            <label htmlFor="s-preset" className="block text-xs text-label-tertiary mb-1">Period covered each time</label>
            <select id="s-preset" value={f.preset} onChange={(e) => set({ preset: e.target.value as ReportDatePreset | "" })} className={`${input} w-full`}>
              <option value="">Report default</option>
              {PRESET_OPTIONS.filter((p) => p.value !== "custom").map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label htmlFor="s-freq" className="block text-xs text-label-tertiary mb-1">How often</label>
          <select id="s-freq" value={f.frequency} onChange={(e) => set({ frequency: e.target.value as ReportScheduleFrequency })} className={input}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </select>
        </div>
        {f.frequency === "weekly" && (
          <div>
            <label htmlFor="s-dow" className="block text-xs text-label-tertiary mb-1">On</label>
            <select id="s-dow" value={f.dayOfWeek} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })} className={input}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </div>
        )}
        {f.frequency === "monthly" && (
          <div>
            <label htmlFor="s-dom" className="block text-xs text-label-tertiary mb-1">On day</label>
            <select id="s-dom" value={f.dayOfMonth} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} className={input}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="s-hour" className="block text-xs text-label-tertiary mb-1">At (company time)</label>
          <select id="s-hour" value={f.hourLocal} onChange={(e) => set({ hourLocal: Number(e.target.value) })} className={input}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="s-format" className="block text-xs text-label-tertiary mb-1">File</label>
          <select id="s-format" value={f.format} onChange={(e) => set({ format: e.target.value as ReportExportFormat })} className={input}>
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
            <option value="pdf">PDF</option>
          </select>
        </div>
      </div>
      <fieldset>
        <legend className="text-xs text-label-tertiary mb-1">Also send to (you always receive it)</legend>
        {!targets ? (
          <p className="text-sm text-label-tertiary">Loading people…</p>
        ) : (
          <div className="max-h-44 overflow-y-auto grid sm:grid-cols-2 gap-x-4">
            {targets.users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={f.recipients.has(u.id)} onChange={(e) => { const n = new Set(f.recipients); if (e.target.checked) n.add(u.id); else n.delete(u.id); set({ recipients: n }); }} />
                {u.label}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-label-tertiary mt-1">A file made with your access is sent only to people who can already see everything in it, so no one receives more than they could open themselves.</p>
      </fieldset>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !f.source || !f.name.trim()} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : editingId ? "Save changes" : "Create schedule"}</button>
        <button type="button" onClick={onCancel} className="rounded border border-black/25 px-4 py-1.5 text-sm font-semibold">Cancel</button>
      </div>
    </form>
  );
}

function History_({ id, onDownload }: { id: string; onDownload: (deliveryId: string) => void }) {
  const [rows, setRows] = useState<ReportDeliverySummary[] | null>(null);
  useEffect(() => {
    api.getReportScheduleDeliveries(id).then(setRows).catch(() => setRows([]));
  }, [id]);
  if (!rows) return <p className="text-xs text-label-tertiary mt-2">Loading…</p>;
  if (rows.length === 0) return <p className="text-xs text-label-tertiary mt-2">Nothing has been delivered yet.</p>;
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="text-left text-label-tertiary uppercase tracking-wide"><th className="py-1 pr-3 font-semibold">When</th><th className="py-1 pr-3 font-semibold">Result</th><th className="py-1 pr-3 font-semibold">Rows</th><th className="py-1 font-semibold">People</th><th /></tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id} className="border-t border-border">
            <td className="py-1 pr-3">{formatDateTime(d.runAt)}</td>
            <td className="py-1 pr-3">{d.status === "sent" ? "Emailed" : d.status === "stored" ? "Ready in the app" : d.status === "skipped" ? "Skipped" : `Failed${d.errorCategory ? ` (${d.errorCategory.replace(/_/g, " ")})` : ""}`}</td>
            <td className="py-1 pr-3 tabular-nums">{d.rowCount ?? "—"}</td>
            <td className="py-1 tabular-nums">{d.recipientCount}{d.skippedRecipients ? ` (+${d.skippedRecipients} skipped)` : ""}</td>
            <td className="py-1 text-right">{d.downloadable && <button type="button" onClick={() => onDownload(d.id)} className="text-accent font-semibold hover:underline">Download</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SchedulesPage() {
  const [params] = useSearchParams();
  const [schedules, setSchedules] = useState<ReportScheduleSummary[] | null>(null);
  const [inbox, setInbox] = useState<ReportInboxItem[]>([]);
  const [catalog, setCatalog] = useState<ReportCatalogEntry[]>([]);
  const [saved, setSaved] = useState<SavedReportSummary[]>([]);
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<{ initial: Form; editingId: string | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const reload = () =>
    api
      .listReportSchedules()
      .then(setSchedules)
      .catch((e) => {
        if (e?.status === 403) setForbidden(true);
        else setError(describeError(e));
        setSchedules([]);
      });
  useEffect(() => {
    void reload();
    api.getReportInbox().then(setInbox).catch(() => undefined);
    api.getReportCatalog().then((c) => setCatalog(c.entries.filter((e) => e.status === "available"))).catch(() => undefined);
    api.listSavedReports().then((s) => setSaved([...s.mine, ...s.shared])).catch(() => undefined);
    api.getReportShareTargets().then(setTargets).catch(() => setTargets({ users: [], roles: [] }));
  }, []);
  useEffect(() => {
    const s = params.get("saved");
    const r = params.get("report");
    if (s || r) setForm({ initial: { ...BLANK, recipients: new Set(), source: s ? `s:${s}` : `r:${r}` }, editingId: null });
  }, [params]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  };
  const download = (deliveryId: string) => api.downloadReportDelivery(deliveryId).catch((e) => setError(describeError(e)));

  const edit = (s: ReportScheduleSummary) =>
    setForm({
      editingId: s.id,
      initial: {
        name: s.name,
        source: s.savedReportId ? `s:${s.savedReportId}` : `r:${s.reportId}`,
        preset: "",
        frequency: s.frequency,
        dayOfWeek: s.dayOfWeek ?? 1,
        dayOfMonth: s.dayOfMonth ?? 1,
        hourLocal: s.hourLocal,
        format: s.format,
        recipients: new Set(s.recipients.map((r) => r.id)),
      },
    });

  if (!schedules) return <LoadingNote what="schedules" />;
  if (forbidden && inbox.length === 0)
    return (
      <div className="max-w-3xl">
        <PageHeader title="Scheduled reports" />
        <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary" role="alert">You do not have permission to schedule reports.</p>
      </div>
    );

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Scheduled reports"
        subtitle="Get a report on a regular day and time. It is emailed to you when email is set up, and always kept here for 14 days."
        actions={!forbidden && !form ? <button type="button" onClick={() => setForm({ initial: { ...BLANK, recipients: new Set() }, editingId: null })} className="bg-accent text-white rounded px-3 py-1.5 text-sm font-semibold">New schedule</button> : undefined}
      />
      {error && <div className="text-danger text-sm mb-3" role="alert">{error}</div>}
      {notice && <p className="text-success text-sm mb-3" role="status">{notice}</p>}

      {form && (
        <div className="mb-6">
          <ScheduleForm
            initial={form.initial}
            editingId={form.editingId}
            catalog={catalog}
            saved={saved}
            targets={targets}
            onCancel={() => setForm(null)}
            onDone={(warnings) => {
              setForm(null);
              setNotice(warnings.length ? `Schedule saved. ${warnings.join(" ")}` : "Schedule saved.");
              void reload();
            }}
          />
        </div>
      )}

      {inbox.length > 0 && (
        <section aria-labelledby="inbox-h" className="mb-8">
          <h2 id="inbox-h" className="text-sm font-semibold mb-2">Delivered to me ({inbox.length})</h2>
          <ul className="space-y-2">
            {inbox.map((i) => (
              <li key={i.deliveryId} className="bg-card rounded-card p-3 shadow-sm flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[12rem]">
                  <p className="text-sm font-semibold">{i.reportTitle}</p>
                  <p className="text-xs text-label-tertiary">{i.scheduleName}{i.ownerName ? ` · from ${i.ownerName}` : ""} · {formatDateTime(i.runAt)}{i.expiresAt ? ` · available until ${formatDateTime(i.expiresAt)}` : ""}</p>
                </div>
                <button type="button" onClick={() => download(i.deliveryId)} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold"><Download size={14} aria-hidden="true" /> Download</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!forbidden && (
        <section aria-labelledby="mine-h">
          <h2 id="mine-h" className="text-sm font-semibold mb-2">My schedules ({schedules.length})</h2>
          {schedules.length === 0 ? (
            <p className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">No schedules yet. Create one, or choose “Schedule” on a saved report.</p>
          ) : (
            <ul className="space-y-3">
              {schedules.map((s) => (
                <li key={s.id} className="bg-card rounded-card p-4 shadow-sm" data-testid={`schedule-${s.id}`}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="flex-1 min-w-[12rem]">
                      <p className="font-semibold">{s.name} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[s.status]}`}>{s.status === "active" ? "Active" : s.status === "paused" ? "Paused" : "Stopped after failures"}</span></p>
                      <p className="text-xs text-label-secondary mt-0.5">{s.reportTitle} · {cadence(s)} · {FORMAT_LABEL[s.format]}</p>
                      <p className="text-xs text-label-tertiary mt-0.5">
                        {s.status === "active" && s.nextRunAt ? `Next: ${formatDateTime(s.nextRunAt)}` : ""}
                        {s.lastRunAt ? ` · Last: ${formatDateTime(s.lastRunAt)} (${s.lastStatus ?? "—"})` : " · Not sent yet"}
                      </p>
                      <p className="text-xs text-label-tertiary mt-0.5">To: {s.recipients.map((r) => r.label).join(", ") || "you"}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => act(() => api.runReportScheduleNow(s.id), "Sent. It is in the history below.")} className="inline-flex items-center gap-1 rounded border border-black/25 px-2.5 py-1.5 text-xs font-semibold"><Send size={13} aria-hidden="true" /> Send now</button>
                      <button type="button" onClick={() => act(() => api.setReportScheduleStatus(s.id, s.status === "active" ? "paused" : "active"))} className="inline-flex items-center gap-1 rounded border border-black/25 px-2.5 py-1.5 text-xs font-semibold">
                        {s.status === "active" ? <><Pause size={13} aria-hidden="true" /> Pause</> : <><Play size={13} aria-hidden="true" /> Resume</>}
                      </button>
                      <button type="button" onClick={() => edit(s)} className="rounded border border-black/25 px-2.5 py-1.5 text-xs font-semibold">Edit</button>
                      <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id} className="inline-flex items-center gap-1 rounded border border-black/25 px-2.5 py-1.5 text-xs font-semibold"><History size={13} aria-hidden="true" /> History</button>
                      <button type="button" aria-label={`Delete ${s.name}`} onClick={() => window.confirm(`Delete the schedule “${s.name}”?`) && act(() => api.deleteReportSchedule(s.id))} className="rounded border border-black/25 px-2 py-1.5 text-danger"><Trash2 size={13} aria-hidden="true" /></button>
                    </div>
                  </div>
                  {open === s.id && <History_ id={s.id} onDownload={download} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
