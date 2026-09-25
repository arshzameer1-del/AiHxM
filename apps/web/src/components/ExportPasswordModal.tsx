import { FormEvent, useState } from "react";

/**
 * Phase 2 gap-fill item #6 — prompts for the password a data export was
 * encrypted under, at download time. Same visual language as ReasonModal
 * — a small confirm-and-collect-one-field modal — for a different job:
 * decrypting, not authorizing.
 */
export function ExportPasswordModal({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not download this export.");
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
        <h2 className="font-bold text-lg">Password-protected export</h2>
        <p className="text-sm text-label-secondary">
          This export was encrypted with a password at request time. Enter it to decrypt and download.
        </p>

        <div>
          <label className="block text-xs font-medium mb-1">Password</label>
          <input
            autoFocus
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
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
            disabled={busy || password.length === 0}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white bg-accent disabled:opacity-50"
          >
            {busy ? "Decrypting…" : "Download"}
          </button>
        </div>
      </form>
    </div>
  );
}
