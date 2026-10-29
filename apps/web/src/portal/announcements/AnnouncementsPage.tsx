import { useCallback, useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import type { AnnouncementPriority, AnnouncementView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

export const PRIORITY_STYLES: Record<AnnouncementPriority, { label: string; cls: string }> = {
  normal: { label: "", cls: "" },
  important: { label: "Important", cls: "bg-amber-100 text-amber-800" },
  urgent: { label: "Urgent", cls: "bg-red-100 text-red-800" },
};

/** The notice board: what HR announced to me. Opening an announcement marks it read; some ask for a confirmation. */
export function AnnouncementsPage() {
  const [items, setItems] = useState<AnnouncementView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listMyAnnouncements().then(setItems).catch((err) => { setItems([]); setError(err instanceof ApiError ? err.message : "Could not load the announcements."); });
  }, []);
  useEffect(load, [load]);

  async function toggle(a: AnnouncementView) {
    const next = open === a.id ? null : a.id;
    setOpen(next);
    if (next && !a.read) {
      try {
        await api.markAnnouncementRead(a.id);
        setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, read: true } : x)) ?? null);
      } catch {
        /* reading is best effort; the next visit tries again */
      }
    }
  }

  async function confirm(a: AnnouncementView) {
    setError(null);
    try {
      await api.acknowledgeAnnouncement(a.id);
      setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, read: true, acknowledged: true } : x)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record your confirmation.");
    }
  }

  return (
    <div data-testid="announcements">
      <PageHeader title="Announcements" subtitle="Notices from HR and your company." />
      {error && <div className="text-sm text-danger mb-3" role="alert">{error}</div>}
      {items === null ? (
        <LoadingNote what="announcements" />
      ) : items.length === 0 ? (
        <p className="text-sm text-label-tertiary" data-testid="no-announcements">There are no announcements right now.</p>
      ) : (
        <div className="space-y-3">
          {items.map((a) => {
            const pr = PRIORITY_STYLES[a.priority];
            const expanded = open === a.id;
            return (
              <article key={a.id} className="bg-card rounded-card shadow-sm" data-testid="announcement-card">
                <button type="button" onClick={() => toggle(a)} aria-expanded={expanded} className="w-full text-left p-4 flex items-start gap-3">
                  <Megaphone className="w-5 h-5 text-accent shrink-0 mt-0.5" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`text-sm ${a.read ? "font-medium" : "font-semibold"}`}>{a.title}</span>
                      {!a.read && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent text-white">New</span>}
                      {pr.label && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${pr.cls}`}>{pr.label}</span>}
                      {a.pinned && <span className="text-[10px] text-label-tertiary">Pinned</span>}
                      {a.requireAck && !a.acknowledged && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-black/5">Please confirm</span>}
                    </span>
                    <span className="block text-xs text-label-tertiary mt-0.5">{formatDateTime(a.publishedAt)}</span>
                  </span>
                </button>
                {expanded && (
                  <div className="px-4 pb-4 pl-12">
                    <p className="text-sm whitespace-pre-wrap">{a.body}</p>
                    {a.requireAck &&
                      (a.acknowledged ? (
                        <p className="text-xs text-accent mt-3">You confirmed that you have read this.</p>
                      ) : (
                        <button type="button" onClick={() => confirm(a)} className="mt-3 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium">I have read this</button>
                      ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
