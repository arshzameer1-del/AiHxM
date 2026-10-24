import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { uploadProblem } from "./employeeDocuments";

/**
 * BACKLOG50 - the round picture on My Profile. Shows the approved photograph, or the initials. "Change photo" uploads a new
 * one; HR approves it before it replaces the current one.
 */
export function ProfilePhoto({ employeeId, initials }: { employeeId: string; initials: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    api.getEmployeePhotoUrl(employeeId).then((u) => {
      if (cancelled) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      made = u;
      setUrl(u);
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [employeeId]);

  async function choose(file: File | null) {
    if (!file) return;
    setMessage(null);
    const problem = uploadProblem(file, "photograph");
    if (problem) return setMessage(problem);
    setBusy(true);
    try {
      await api.uploadEmployeeDocument(employeeId, { file, documentType: "photograph", own: true });
      setMessage("Sent. HR will approve your new photo before it shows.");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not upload the photo.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      {url ? (
        <img src={url} alt="Your profile photo" className="w-14 h-14 rounded-full object-cover" data-testid="profile-photo" />
      ) : (
        <div className="w-14 h-14 rounded-full bg-accent/10 text-accent font-semibold text-lg flex items-center justify-center">{initials}</div>
      )}
      <button type="button" onClick={() => input.current?.click()} disabled={busy} className="text-[11px] font-medium text-accent hover:underline disabled:opacity-50">
        {busy ? "Sending…" : "Change photo"}
      </button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose a new profile photo" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      {message && <div className="text-[11px] text-label-secondary max-w-40 text-center" role="status">{message}</div>}
    </div>
  );
}
