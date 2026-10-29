import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, Menu } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useT } from "../../i18n/i18n";
import { hueOf } from "./hue";

export type HamburgerItem = { to: string; label: string; end?: boolean; icon?: LucideIcon; children?: HamburgerItem[] };

const isOn = (pathname: string, item: { to: string; end?: boolean }) => (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`));

/**
 * The "AiHxM Menu Bar" theme's menu: a three-line button in the top bar that opens the whole menu as a drop-down list under it.
 * Entries with sub-pages show a small arrow and open their pages in place. The page you are on is outlined. It closes on a click
 * outside, on Escape and after a page is chosen. Same entries, same permissions as the side menu - it is given the same list.
 */
export function HamburgerNav({ items, onNavigate }: { items: HamburgerItem[]; onNavigate?: (to: string) => void }) {
  const t = useT();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (holder.current && !holder.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening shows the group of the current page already open.
  useEffect(() => {
    if (open) setExpanded(items.find((i) => i.children && [i, ...i.children].some((e) => isOn(pathname, e)))?.to ?? null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (to: string) => {
    setOpen(false);
    onNavigate?.(to);
  };
  const rowClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] text-label-primary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isActive ? "bg-accent/10 font-semibold ring-2 ring-accent/60" : ""}`;

  return (
    <div ref={holder} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? t("Close menu") : t("Open menu")}
        aria-expanded={open}
        aria-controls="hamburger-menu"
        data-testid="hamburger-button"
        className="w-10 h-10 rounded-lg flex items-center justify-center text-label-primary hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <Menu size={24} strokeWidth={1.75} />
      </button>

      {open && (
        <nav
          id="hamburger-menu"
          aria-label={t("Main")}
          data-testid="hamburger-menu"
          className="app-topbar-menu absolute start-0 top-full mt-3 z-40 w-[19rem] max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-5.5rem)] overflow-y-auto rounded-xl border border-border bg-card p-2 shadow-xl"
        >
          <span aria-hidden="true" className="absolute -top-1.5 start-4 h-3 w-3 rotate-45 border-s border-t border-border bg-card" />
          <ul className="relative flex flex-col gap-0.5">
            {items.map((item) => {
              const Icon = item.icon;
              const chip = Icon ? (
                <span className="hue-chip rail-ic shrink-0" data-hue={hueOf(item.label)}>
                  <Icon size={20} strokeWidth={1.75} />
                </span>
              ) : null;
              if (!item.children) {
                return (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} className={rowClass} onClick={() => choose(item.to)}>
                      {chip}
                      <span className="truncate">{t(item.label)}</span>
                    </NavLink>
                  </li>
                );
              }
              const isOpen = expanded === item.to;
              const inside = [item, ...item.children].some((e) => isOn(pathname, e));
              return (
                <li key={item.to}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : item.to)}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] text-start text-label-primary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${inside ? "font-semibold" : ""}`}
                  >
                    {chip}
                    <span className="flex-1 truncate">{t(item.label)}</span>
                    <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-label-secondary transition-transform ${isOpen ? "rotate-180" : "-rotate-90 rtl:rotate-90"}`} />
                  </button>
                  {isOpen && (
                    <ul className="ms-6 mt-0.5 mb-1 border-s border-border ps-2 flex flex-col gap-0.5">
                      <li>
                        <NavLink to={item.to} end={item.end} className={rowClass} onClick={() => choose(item.to)}>
                          <span className="truncate">{t(item.label)}</span>
                        </NavLink>
                      </li>
                      {item.children.map((child) => (
                        <li key={child.to}>
                          <NavLink to={child.to} end={child.end} className={rowClass} onClick={() => choose(child.to)}>
                            <span className="truncate">{t(child.label)}</span>
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
