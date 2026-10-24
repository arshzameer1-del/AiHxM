import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";

const BUTTON = "w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-sidebar-muted hover:bg-sidebar-hover/5 hover:text-sidebar-fg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/** The one button that collapses and widens the side menu (inside the menu's own header, as in the Claude app). */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand menu" : "Collapse menu";
  return (
    <button type="button" onClick={onToggle} aria-label={label} title={label} aria-expanded={!collapsed} aria-controls="app-sidebar" className={BUTTON}>
      {collapsed ? <PanelLeftOpen size={19} strokeWidth={1.75} /> : <PanelLeftClose size={19} strokeWidth={1.75} />}
    </button>
  );
}

/** Phone only: sits at the left of the top bar and opens the menu drawer. */
export function MobileMenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? "Close menu" : "Open menu"}
      aria-expanded={open}
      aria-controls="app-sidebar"
      className="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center text-label-secondary hover:bg-surface hover:text-label-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <Menu size={20} strokeWidth={1.75} />
    </button>
  );
}
