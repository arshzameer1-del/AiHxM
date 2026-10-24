import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import type { UserNotificationInbox, UserNotificationView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { formatDateTime } from "../../portal/shared/dates";

const POLL_MS = 60_000;

/**
 * BACKLOG51 - the bell. Shows what HR decided on your requests (or what is waiting for you, for HR), keeps itself current while the
 * tab is visible, and opens the page an item is about.
 */
export function NotificationBell({ accountPath }: { accountPath?: string }) {
  const [inbox, setInbox] = useState<UserNotificationInbox | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api.getNotificationInbox().then(setInbox).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function openItem(item: UserNotificationView) {
    setOpen(false);
    if (!item.readAt) {
      setInbox((cur) => (cur ? { unreadCount: Math.max(0, cur.unreadCount - 1), items: cur.items.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)) } : cur));
      api.markNotificationsRead([item.id]).catch(() => undefined);
    }
    if (item.link) navigate(item.link);
  }

  async function markAll() {
    setInbox((cur) => (cur ? { unreadCount: 0, items: cur.items.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) } : cur));
    api.markNotificationsRead().catch(() => undefined);
  }

  const unread = inbox?.unreadCount ?? 0;
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        data-testid="notification-bell"
        className="relative w-10 h-10 flex items-center justify-center rounded-lg hover:bg-surface transition-colors text-label-secondary"
      >
        <Bell size={18} strokeWidth={1.75} />
        {unread > 0 && (
          <span data-testid="notification-count" className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="app-topbar-menu absolute right-0 mt-2 w-80 max-w-[calc(100vw-1.5rem)] bg-card border border-border rounded-xl shadow-lg z-30" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
            <div className="text-sm font-semibold text-label-primary">Notifications</div>
            {unread > 0 && (
              <button type="button" onClick={markAll} className="text-xs font-medium text-accent hover:underline">Mark all read</button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {inbox && inbox.items.length === 0 && <div className="px-4 py-8 text-sm text-label-secondary text-center">You are all caught up.</div>}
            {inbox?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openItem(item)}
                className={`w-full text-left px-3.5 py-2.5 border-b border-border last:border-b-0 hover:bg-surface transition-colors ${item.readAt ? "" : "bg-accent/5"}`}
                data-testid="notification-item"
              >
                <div className="flex items-start gap-2">
                  {!item.readAt && <span className="mt-1.5 w-2 h-2 rounded-full bg-accent shrink-0" aria-label="Unread" />}
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-label-primary">{item.title}</div>
                    {item.body && <div className="text-xs text-label-secondary mt-0.5 break-words">{item.body}</div>}
                    <div className="text-[11px] text-label-tertiary mt-1">{formatDateTime(item.createdAt)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          {accountPath && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate(`${accountPath}?tab=notifications`);
              }}
              className="w-full px-3.5 py-2 text-xs font-medium text-accent hover:bg-surface border-t border-border rounded-b-xl text-left"
            >
              Choose what you are notified about
            </button>
          )}
        </div>
      )}
    </div>
  );
}
