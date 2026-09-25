import { FormEvent, useState } from "react";

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. Rendered by
 * useStepUp.tsx whenever a request comes back with StepUpGuard's
 * "step_up_required" shape — same visual language as ReasonModal (this
 * app's other "confirm before a sensitive action" modal), for a different
 * kind of confirmation: proving the second factor again, not stating why.
 */
export function StepUpModal({
  onVerify,
  onCancel,
}: {
  onVerify: (credential: { totpCode?: string; recoveryCode?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onVerify(useRecoveryCode ? { recoveryCode: code.trim() } : { totpCode: code.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
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
        <h2 className="font-bold text-lg">Confirm your identity</h2>
        <p className="text-sm text-label-secondary">
          This action is sensitive enough to need your authenticator app again, even though you're already
          signed in. This only takes a moment and won't be asked again for a few minutes.
        </p>

        <div>
          <label className="block text-xs font-medium mb-1">
            {useRecoveryCode ? "Recovery code" : "6-digit code from your authenticator app"}
          </label>
          <input
            autoFocus
            required
            inputMode={useRecoveryCode ? "text" : "numeric"}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={useRecoveryCode ? 32 : 6}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder={useRecoveryCode ? "ABCDE-FGHJK" : "000000"}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            setUseRecoveryCode((v) => !v);
            setCode("");
            setError(null);
          }}
          className="text-xs font-medium text-accent hover:underline"
        >
          {useRecoveryCode ? "Use an authenticator code instead" : "Use a recovery code instead"}
        </button>

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
            disabled={busy || code.trim().length === 0}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white bg-accent disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify & continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
