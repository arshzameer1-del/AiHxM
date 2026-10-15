import { ReactNode, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Building blocks for the leave pages: white sections with a bold title and a rule under it (optionally
 * collapsible), SAP-style label-left form rows, a bottom action bar, and a small confirmation dialog.
 */

/** White section: bold title with a rule under it; click the chevron to collapse. */
export function SapSection({
  title,
  count,
  collapsible = true,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  count?: number;
  collapsible?: boolean;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="bg-white rounded-md shadow-sm mb-3">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-black/20">
        {collapsible && (
          <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${title}`} onClick={() => setOpen(!open)} className="text-accent p-0.5">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        )}
        <h2 className="text-sm font-bold flex-1">
          {title}
          {count !== undefined && <span className="font-normal text-label-tertiary"> ({count})</span>}
        </h2>
        {actions}
      </div>
      {open && <div className="px-4 py-3">{children}</div>}
    </section>
  );
}

/** One form row: the label on the left, right-aligned and muted, the field on the right (stacks on a phone). */
export function SapField({ label, htmlFor, required, children, hint }: { label: string; htmlFor?: string; required?: boolean; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-x-3 gap-y-1 items-start py-1">
      <label htmlFor={htmlFor} className="sm:text-right text-xs text-label-secondary sm:pt-2">
        {label}
        {required && <span className="text-danger">*</span>}
        <span className="hidden sm:inline">:</span>
      </label>
      <div className="min-w-0">
        {children}
        {hint && <div className="text-xs text-label-secondary mt-1">{hint}</div>}
      </div>
    </div>
  );
}

/** Action bar at the bottom of a form page; stays in view while the form scrolls. */
export function SapFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 px-1 pt-2 pb-2 bg-gradient-to-t from-surface via-surface to-transparent">
      <div className="flex items-center justify-end gap-2 bg-white border border-black/15 rounded-md shadow px-3 py-2">{children}</div>
    </div>
  );
}

/** Small modal question with two buttons ("Cancel and discard all changes?" in the reference app). */
export function SapConfirm({ message, confirmLabel = "OK", cancelLabel = "Cancel", onConfirm, onCancel }: { message: string; confirmLabel?: string; cancelLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" role="alertdialog" aria-modal="true" aria-label="Confirmation">
      <div className="bg-white rounded-md shadow-lg w-[min(420px,92vw)] p-4">
        <p className="text-sm mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onConfirm} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold">
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel} className="border border-accent text-accent rounded px-4 py-1.5 text-sm font-semibold">
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
