import { Menu, Pin, PinOff } from "lucide-react";

/** The two buttons in the top-left corner: show/hide the side menu, and pin it open. */
export function SidebarToggle({ visible, pinned, onToggle, onTogglePin }: { visible: boolean; pinned: boolean; onToggle: () => void; onTogglePin: () => void }) {
  const button = "w-9 h-9 rounded-lg flex items-center justify-center text-label-secondary hover:bg-surface hover:text-label-primary transition-colors";
  return (
    <div className="h-16 shrink-0 bg-card border-b border-border flex items-center gap-0.5 pl-3 pr-1">
      <button type="button" onClick={onToggle} aria-label={visible ? "Close menu" : "Open menu"} aria-expanded={visible} aria-controls="app-sidebar" className={button}>
        <Menu size={20} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={pinned ? "Unpin menu" : "Pin menu open"}
        aria-pressed={pinned}
        title={pinned ? "Unpin: the menu closes after you pick a page" : "Pin: keep the menu open beside the page"}
        className={`${button} ${pinned ? "text-accent bg-accent/10 hover:bg-accent/15 hover:text-accent" : ""}`}
      >
        {pinned ? <PinOff size={17} strokeWidth={1.75} /> : <Pin size={17} strokeWidth={1.75} />}
      </button>
    </div>
  );
}
