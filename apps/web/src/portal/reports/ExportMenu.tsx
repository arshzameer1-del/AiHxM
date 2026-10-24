import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import type { ReportExportFormat } from "@aihxm/shared-types";

const FORMATS: { key: ReportExportFormat; label: string; hint: string }[] = [
  { key: "xlsx", label: "Excel (.xlsx)", hint: "Formatted, with a sheet explaining the report" },
  { key: "csv", label: "CSV", hint: "Plain rows for other tools" },
  { key: "pdf", label: "PDF", hint: "To print or share, first 2,000 rows" },
];

/** One button that offers CSV, Excel or PDF. The server builds and audits the file; the button only asks for it. */
export function ExportMenu({
  onExport,
  disabled,
  busy,
  title,
}: {
  onExport: (format: ReportExportFormat) => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        className="inline-flex items-center gap-1.5 rounded bg-accent text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
      >
        <Download size={15} aria-hidden="true" /> {busy ? "Preparing…" : "Export"} <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 z-20 mt-1 w-64 rounded-card bg-card shadow-lg border border-border py-1">
          {FORMATS.map((f) => (
            <li key={f.key} role="none">
              <button
                type="button"
                role="menuitem"
                className="w-full text-left px-3 py-2 hover:bg-black/5 focus-visible:bg-black/5 outline-none"
                onClick={() => {
                  setOpen(false);
                  onExport(f.key);
                }}
              >
                <span className="block text-sm font-semibold">{f.label}</span>
                <span className="block text-xs text-label-tertiary">{f.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
