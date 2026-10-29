import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AnnouncementAdminView,
  AnnouncementAudienceType,
  AnnouncementPriority,
  AnnouncementReceiptView,
  LocationView,
  MessagingChannelsView,
  OrgUnitView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime, formatDay } from "../shared/dates";
import { PRIORITY_STYLES } from "./AnnouncementsPage";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const label = "block text-xs font-medium text-label-secondary mb-1";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const quiet = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

type Form = {
  title: string; body: string; priority: AnnouncementPriority; audienceType: AnnouncementAudienceType; audienceIds: string[];
  pinned: boolean; requireAck: boolean; expiresOn: string; sendEmail: boolean; sendSms: boolean; sendWhatsapp: boolean;
};
const empty: Form = {
  title: "", body: "", priority: "normal", audienceType: "all", audienceIds: [], pinned: false, requireAck: false, expiresOn: "",
  sendEmail: false, sendSms: false, sendWhatsapp: false,
};

/** HR: write, publish and withdraw announcements, and see who has read them. */
export function AnnouncementsAdminPage() {
  const [items, setItems] = useState<AnnouncementAdminView[] | null>(null);
  const [channels, setChannels] = useState<MessagingChannelsView | null>(null);
  const [units, setUnits] = useState<OrgUnitView[]>([]);
  const [places, setPlaces] = useState<LocationView[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; status: "draft" | "published" } | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipts, setReceipts] = useState<{ id: string; rows: AnnouncementReceiptView[] } | null>(null);

  const load = useCallback(() => {
    api.listAnnouncementsAdmin().then(setItems).catch((err) => { setItems([]); setError(err instanceof ApiError ? err.message : "Could not load the announcements."); });
  }, []);
  useEffect(() => {
    load();
    api.announcementChannels().then(setChannels).catch(() => setChannels(null));
    api.listOrgUnits().then(setUnits).catch(() => setUnits([]));
    api.listLocations().then(setPlaces).catch(() => setPlaces([]));
  }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const startNew = () => { setEditing({ id: null, status: "draft" }); setForm(empty); setError(null); setNotice(null); };
  const startEdit = (a: AnnouncementAdminView) => {
    setEditing({ id: a.id, status: a.status === "published" ? "published" : "draft" });
    setForm({
      title: a.title, body: a.body, priority: a.priority, audienceType: a.audienceType, audienceIds: a.audienceIds, pinned: a.pinned,
      requireAck: a.requireAck, expiresOn: a.expiresOn ?? "", sendEmail: a.sendEmail, sendSms: a.sendSms, sendWhatsapp: a.sendWhatsapp,
    });
    setError(null);
    setNotice(null);
  };

  async function save(e: FormEvent, publish: boolean) {
    e.preventDefault();
    if (!form.title.trim()) return setError("Give the announcement a title.");
    if (!form.body.trim()) return setError("Write the announcement.");
    setBusy(true);
    setError(null);
    const payload = { ...form, expiresOn: form.expiresOn || null, publish };
    try {
      const saved = editing?.id ? await api.updateAnnouncement(editing.id, payload) : await api.createAnnouncement(payload);
      setEditing(null);
      setNotice(publish ? `Published to ${saved.audienceCount} people.` : "Saved as a draft.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the announcement.");
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await fn();
      setNotice(done);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not do that.");
    }
  }

  async function showReceipts(id: string) {
    if (receipts?.id === id) return setReceipts(null);
    try {
      setReceipts({ id, rows: await api.announcementReceipts(id) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load who has read it.");
    }
  }

  const choices = form.audienceType === "org_unit" ? units.filter((u) => u.status === "active") : places.filter((l) => l.status === "active");
  const published = editing?.status === "published";

  return (
    <div data-testid="announcements-admin">
      <PageHeader
        title="Announcements"
        subtitle="Write notices for everyone, a department or a location, and see who has read them."
        actions={!editing ? <button className={btn} onClick={startNew}>New announcement</button> : undefined}
      />
      {notice && <div className="text-sm text-accent mb-3" role="status">{notice}</div>}
      {error && <div className="text-sm text-danger mb-3" role="alert">{error}</div>}

      {editing && (
        <form onSubmit={(e) => save(e, false)} className="bg-card rounded-card p-5 shadow-sm mb-5 space-y-3" aria-label="Announcement">
          <h2 className="font-semibold text-sm">{editing.id ? (published ? "Edit published announcement" : "Edit draft") : "New announcement"}</h2>
          <div>
            <label htmlFor="ann-title" className={label}>Title</label>
            <input id="ann-title" className={field} maxLength={200} value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div>
            <label htmlFor="ann-body" className={label}>Announcement</label>
            <textarea id="ann-body" className={field} rows={5} maxLength={10000} value={form.body} onChange={(e) => set("body", e.target.value)} />
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="ann-priority" className={label}>Priority</label>
              <select id="ann-priority" className={field} value={form.priority} onChange={(e) => set("priority", e.target.value as AnnouncementPriority)}>
                <option value="normal">Normal</option>
                <option value="important">Important</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label htmlFor="ann-audience" className={label}>Who should see it?</label>
              <select id="ann-audience" className={field} value={form.audienceType} disabled={published}
                onChange={(e) => setForm((f) => ({ ...f, audienceType: e.target.value as AnnouncementAudienceType, audienceIds: [] }))}>
                <option value="all">Everyone</option>
                <option value="org_unit">Chosen departments</option>
                <option value="location">Chosen locations</option>
              </select>
            </div>
            <div>
              <label htmlFor="ann-expires" className={label}>Hide after (optional)</label>
              <input id="ann-expires" type="date" className={field} value={form.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} />
            </div>
          </div>
          {form.audienceType !== "all" && (
            <fieldset disabled={published} className="border border-black/10 rounded-lg p-3">
              <legend className="text-xs font-medium text-label-secondary px-1">{form.audienceType === "org_unit" ? "Departments" : "Locations"}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {choices.length === 0 && <span className="text-xs text-label-tertiary">None set up yet.</span>}
                {choices.map((c) => (
                  <label key={c.id} className="text-sm flex items-center gap-1.5">
                    <input type="checkbox" checked={form.audienceIds.includes(c.id)}
                      onChange={(e) => set("audienceIds", e.target.checked ? [...form.audienceIds, c.id] : form.audienceIds.filter((x) => x !== c.id))} />
                    {c.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={form.pinned} onChange={(e) => set("pinned", e.target.checked)} /> Keep at the top</label>
            <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={form.requireAck} disabled={published} onChange={(e) => set("requireAck", e.target.checked)} /> Ask people to confirm they read it</label>
          </div>
          <fieldset disabled={published} className="border border-black/10 rounded-lg p-3">
            <legend className="text-xs font-medium text-label-secondary px-1">Also send by (everyone also gets it in the bell and on the notice board)</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={form.sendEmail} onChange={(e) => set("sendEmail", e.target.checked)} /> Email</label>
              <label className="text-sm flex items-center gap-1.5" title={channels?.sms.configured ? "" : "No SMS provider is connected yet"}>
                <input type="checkbox" checked={form.sendSms} disabled={!channels?.sms.configured} onChange={(e) => set("sendSms", e.target.checked)} /> SMS{channels?.sms.configured ? "" : " (not set up)"}
              </label>
              <label className="text-sm flex items-center gap-1.5" title={channels?.whatsapp.configured ? "" : "WhatsApp is not connected yet"}>
                <input type="checkbox" checked={form.sendWhatsapp} disabled={!channels?.whatsapp.configured} onChange={(e) => set("sendWhatsapp", e.target.checked)} /> WhatsApp{channels?.whatsapp.configured ? "" : " (not set up)"}
              </label>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            {!published && <button type="button" className={btn} disabled={busy} onClick={(e) => save(e as unknown as FormEvent, true)}>{busy ? "Working…" : "Publish now"}</button>}
            <button type="submit" className={published ? btn : quiet} disabled={busy}>{published ? "Save changes" : "Save as draft"}</button>
            <button type="button" className={quiet} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      {items === null ? (
        <LoadingNote what="announcements" />
      ) : items.length === 0 ? (
        <p className="text-sm text-label-tertiary" data-testid="no-announcements-admin">No announcements yet.</p>
      ) : (
        <div className="space-y-3">
          {items.map((a) => {
            const pr = PRIORITY_STYLES[a.priority];
            const s = a.deliverySummary;
            return (
              <div key={a.id} className="bg-card rounded-card p-4 shadow-sm" data-testid="announcement-admin-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold flex flex-wrap items-center gap-2">
                      {a.title}
                      {pr.label && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${pr.cls}`}>{pr.label}</span>}
                    </div>
                    <div className="text-xs text-label-tertiary mt-0.5">
                      {a.status === "draft" ? "Draft" : a.status === "archived" ? "Archived" : `Published ${formatDateTime(a.publishedAt)}`} · to{" "}
                      {a.audienceType === "all" ? "everyone" : a.audienceNames.join(", ")} ({a.audienceCount} people)
                      {a.expiresOn ? ` · hidden after ${formatDay(a.expiresOn)}` : ""}
                    </div>
                    <p className="text-sm mt-1 line-clamp-2 whitespace-pre-wrap">{a.body}</p>
                    {a.status !== "draft" && (
                      <div className="text-xs text-label-secondary mt-1">
                        Read by {a.readCount} of {a.audienceCount}
                        {a.requireAck ? ` · confirmed by ${a.acknowledgedCount}` : ""}
                        {s.email !== undefined ? ` · emailed ${s.email}` : ""}
                        {s.smsSent !== undefined ? ` · SMS sent ${s.smsSent}${s.smsFailed ? `, failed ${s.smsFailed}` : ""}` : ""}
                        {s.whatsappSent !== undefined ? ` · WhatsApp sent ${s.whatsappSent}${s.whatsappFailed ? `, failed ${s.whatsappFailed}` : ""}` : ""}
                        {s.noPhone ? ` · ${s.noPhone} without a valid mobile number` : ""}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {a.status === "draft" && <button className={btn} onClick={() => act(() => api.publishAnnouncement(a.id), "Published.")}>Publish</button>}
                  {a.status !== "archived" && <button className={quiet} onClick={() => startEdit(a)}>Edit</button>}
                  {a.status !== "draft" && <button className={quiet} onClick={() => showReceipts(a.id)}>{receipts?.id === a.id ? "Hide readers" : "Who has read it"}</button>}
                  {a.status !== "archived" && <button className={quiet} onClick={() => act(() => api.archiveAnnouncement(a.id), "Withdrawn from the notice board.")}>{a.status === "draft" ? "Discard" : "Withdraw"}</button>}
                </div>
                {receipts?.id === a.id && (
                  <ul className="mt-3 text-xs divide-y divide-black/5" data-testid="receipts">
                    {receipts.rows.map((r) => (
                      <li key={r.employeeId} className="py-1.5 flex justify-between gap-3">
                        <span>{r.employeeNumber} · {r.employeeName}</span>
                        <span className={r.readAt ? "text-accent" : "text-label-tertiary"}>
                          {r.acknowledgedAt ? "Confirmed" : r.readAt ? "Read" : "Not read yet"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
