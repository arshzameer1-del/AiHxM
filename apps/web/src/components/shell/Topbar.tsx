import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, LogOut, Search } from "lucide-react";

export type QuickJumpItem = { to: string; label: string; group?: string };

/**
 * UI Re-skin Phase 2 (2026-10) — shared topbar for every AiHxM app shell
 * (tenant PortalLayout and the Platform Admin Layout). Per the AiHxM
 * Enterprise UI Design System Master Instruction, Section 6.3 ("Topbar"):
 * "global search/AI command field, notifications, help, context switcher
 * where required, profile menu."
 *
 * This ships the two pieces that have a real implementation behind them —
 * a quick-jump search over this shell's own nav items (click, or ⌘K/Ctrl+K
 * from anywhere) and a profile menu (role label + sign-out) — and
 * deliberately leaves out a notifications bell and an AI command
 * affordance. Neither has a backend yet (no cross-module notification
 * center, no AI assistant service), and an icon with nothing real behind
 * it is worse than no icon. Both are open items on the same UI re-skin
 * plan, not forgotten — see claude/ui-reskin-design-system-and-migration-
 * plan-2026-10.md.
 */
export function Topbar({
  items,
  userName,
  userEmail,
  roleLabel,
  contextLabel,
  onLogout,
}: {
  items: QuickJumpItem[];
  userName: string;
  userEmail: string;
  roleLabel: string;
  contextLabel?: string | null;
  onLogout: () => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 8);
    return items
      .filter((item) => item.label.toLowerCase().includes(q) || item.group?.toLowerCase().includes(q))
      .slice(0, 8);
  }, [items, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery("");
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [paletteOpen]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handlePaletteKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && results[activeIndex]) {
      navigate(results[activeIndex].to);
      setPaletteOpen(false);
    }
  }

  const initials =
    userName
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <>
      <header className="h-16 shrink-0 bg-card border-b border-border flex items-center justify-between gap-4 px-6">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-2.5 w-full max-w-sm px-3.5 py-2 rounded-lg border border-border bg-surface text-left text-sm text-label-secondary hover:border-accent/40 transition-colors"
        >
          <Search size={16} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 truncate">Search pages, actions…</span>
          <kbd className="text-[11px] font-semibold text-label-secondary bg-card border border-border rounded px-1.5 py-0.5">
            ⌘K
          </kbd>
        </button>

        {contextLabel && (
          <div className="hidden md:block text-sm text-label-secondary truncate">{contextLabel}</div>
        )}

        <div className="relative shrink-0" ref={profileRef}>
          <button
            type="button"
            onClick={() => setProfileOpen((v) => !v)}
            aria-expanded={profileOpen}
            aria-label="Account menu"
            className="flex items-center gap-2.5 pl-1.5 pr-2.5 py-1.5 rounded-lg hover:bg-surface transition-colors"
          >
            <span className="w-8 h-8 rounded-full bg-accent/10 text-accent font-semibold text-xs flex items-center justify-center shrink-0">
              {initials}
            </span>
            <span className="hidden sm:flex flex-col items-start leading-tight">
              <span className="text-sm font-medium text-label-primary truncate max-w-[140px]">{userName}</span>
              <span className="text-xs text-label-secondary truncate max-w-[140px]">{roleLabel}</span>
            </span>
            <ChevronDown size={16} className="text-label-secondary shrink-0" />
          </button>

          {profileOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-card border border-border rounded-xl shadow-lg py-1.5 z-30">
              <div className="px-3.5 py-2 border-b border-border">
                <div className="text-sm font-medium text-label-primary truncate">{userName}</div>
                <div className="text-xs text-label-secondary truncate">{userEmail}</div>
              </div>
              <button
                type="button"
                onClick={onLogout}
                className="w-full flex items-center gap-2 px-3.5 py-2 text-sm text-danger hover:bg-danger/5 transition-colors"
              >
                <LogOut size={15} strokeWidth={1.75} />
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {paletteOpen && (
        <div
          role="presentation"
          className="fixed inset-0 bg-black/30 z-40 flex items-start justify-center pt-[12vh] px-4"
          onClick={() => setPaletteOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-card rounded-xl shadow-2xl border border-border overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
              <Search size={16} className="text-label-secondary shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Search pages, actions…"
                aria-label="Search pages and actions"
                className="flex-1 outline-none text-sm text-label-primary placeholder:text-label-tertiary bg-transparent"
              />
              <kbd className="text-[11px] font-semibold text-label-secondary bg-surface border border-border rounded px-1.5 py-0.5">
                Esc
              </kbd>
            </div>
            <div className="max-h-80 overflow-y-auto py-1.5">
              {results.length === 0 && (
                <div className="px-4 py-6 text-sm text-label-secondary text-center">No matching pages.</div>
              )}
              {results.map((item, idx) => (
                <button
                  key={item.to}
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    navigate(item.to);
                    setPaletteOpen(false);
                  }}
                  className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between transition-colors ${
                    idx === activeIndex ? "bg-accent/10 text-accent" : "text-label-primary"
                  }`}
                >
                  <span>{item.label}</span>
                  {item.group && <span className="text-xs text-label-secondary">{item.group}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
