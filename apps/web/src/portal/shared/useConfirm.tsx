import { useCallback, useState, type ReactNode } from "react";
import { SapConfirm } from "./FormSections";

/**
 * Asks "are you sure?" before something that removes a saved record. Use the returned `dialog` once in the page and call
 * `ask(message, action)` from the button; nothing happens until the person confirms, and Cancel changes nothing.
 */
export function useConfirm(): { dialog: ReactNode; ask: (message: string, onYes: () => void, confirmLabel?: string) => void } {
  const [pending, setPending] = useState<{ message: string; onYes: () => void; confirmLabel: string } | null>(null);
  const ask = useCallback((message: string, onYes: () => void, confirmLabel = "Remove") => setPending({ message, onYes, confirmLabel }), []);
  const dialog = pending ? (
    <SapConfirm
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      cancelLabel="Cancel"
      onConfirm={() => { const run = pending.onYes; setPending(null); run(); }}
      onCancel={() => setPending(null)}
    />
  ) : null;
  return { dialog, ask };
}
