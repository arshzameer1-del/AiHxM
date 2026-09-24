import { FormEvent, useState } from "react";

/**
 * Shared confirmation modal for every "High-risk action" the Tenant
 * Management spec calls out (Suspend, Lock, deletion request, Force
 * Logout, Revoke) — all of which the spec's "How To Use" sheet requires
 * to go through "explicit permission, confirmation, reason and audit
 * logging". This is the confirmation + reason half; the backend is what
 * actually enforces "reason required" and writes the audit_log row, this
 * modal just makes it impossible to fire the action without supplying one.
 */
export function ReasonModal({
  title,
  description,
  confirmLabel,
  danger,
  extraField,
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  /** An optional second field rendered above the reason box (e.g. grace period days). */
  extraField?: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number };
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length === 0) {
      setError("A reason is required for this action.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "This action failed.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={onCancel}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-card rounded-card p-6 shadow-lg max-w-md w-full space-y-4"
      >
        <h2 className="font-bold text-lg">{title}</h2>
        {description && <p className="text-sm text-label-secondary">{description}</p>}

        {extraField && (
          <div>
            <label className="block text-xs font-medium mb-1">{extraField.label}</label>
            <input
              type="number"
              min={extraField.min ?? 1}
              max={extraField.max ?? 365}
              value={extraField.value}
              onChange={(e) => extraField.onChange(Number(e.target.value))}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium mb-1">Reason (required, audit-logged)</label>
          <textarea
            autoFocus
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Why is this action being taken?"
          />
        </div>

        {error && <div className="text-danger text-sm">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-label-secondary hover:bg-black/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
              danger ? "bg-danger" : "bg-accent"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
