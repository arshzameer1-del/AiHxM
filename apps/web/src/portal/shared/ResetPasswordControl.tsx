import { FormEvent, useState } from "react";
import { api, ApiError } from "../../api/client";

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random 12-character temporary password (no look-alike characters) plus a digit and a symbol so it passes any strength rule. */
function generatePassword(): string {
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes.slice(0, 10), (n) => ALPHABET[n % ALPHABET.length]).join("");
  return `${body}${(bytes[10] % 8) + 2}${"@#$%&*"[bytes[11] % 6]}`;
}

/**
 * "Reset password" for an employee who already has a login: the admin types or generates a temporary password, it is shown once so it can
 * be shared directly, and the person is signed out everywhere. The server decides who may do this (System Admin; HR Admin for ordinary
 * logins only).
 */
export function ResetPasswordControl({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.resetEmployeePassword(employeeId, password);
      setDone(password);
      setOpen(false);
      setPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset the password.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1" role="status">
        <div className="font-semibold text-amber-900">Password changed for {employeeName}. Share this now, it will not be shown again:</div>
        <code className="block bg-white rounded px-2 py-1 font-mono select-all">{done}</code>
        <button type="button" onClick={() => setDone(null)} className="text-accent font-semibold hover:underline">
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 text-xs font-semibold text-accent hover:underline">
        Reset password
      </button>
    );
  }

  const id = `reset-password-${employeeId}`;
  return (
    <form onSubmit={submit} className="mt-2 space-y-2 bg-black/5 rounded-lg p-3">
      <label htmlFor={id} className="block text-xs font-medium">New temporary password (at least 8 characters)</label>
      <div className="flex gap-2 flex-wrap">
        <input
          id={id}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          className="flex-1 min-w-[200px] rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button type="button" onClick={() => setPassword(generatePassword())} className="text-xs font-semibold text-accent hover:underline">
          Generate
        </button>
      </div>
      <p className="text-xs text-label-tertiary">{employeeName} is signed out everywhere and must use this password next time.</p>
      {error && <div className="text-danger text-xs" role="alert">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy || password.length < 8} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {busy ? "Saving…" : "Set password"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="text-sm text-label-secondary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}
