import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { uploadProblem } from "./employeeDocuments";
import { photoChanged, useEmployeePhoto } from "./employeePhoto";

/**
 * The round picture on My Profile and on the HR employee page. Shows the current photograph, or the initials.
 * "Change photo" uploads a new one. HR (`mode="hr"`) changes it directly. The employee (`mode="self"`) changes their own:
 * it shows at once, unless the company asks for HR approval first (System Admin > Appearance), in which case it waits.
 */
export function ProfilePhoto({ employeeId, initials, mode = "self" }: { employeeId: string; initials: string; mode?: "self" | "hr" }) {
  const url = useEmployeePhoto(employeeId);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function choose(file: File | null) {
    if (!file) return;
    setMessage(null);
    const problem = uploadProblem(file, "photograph");
    if (problem) return setMessage(problem);
    setBusy(true);
    try {
      const doc = await api.uploadEmployeeDocument(employeeId, { file, documentType: "photograph", own: mode === "self" });
      if (doc.reviewStatus === "pending") {
        setMessage("Sent. HR will approve your new photo before it shows.");
      } else {
        photoChanged(employeeId);
        setMessage("Photo updated.");
      }
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
        <img src={url} alt={mode === "hr" ? "Profile photo" : "Your profile photo"} className="w-14 h-14 rounded-full object-cover" data-testid="profile-photo" />
      ) : (
        <div className="w-14 h-14 rounded-full bg-accent/10 text-accent font-semibold text-lg flex items-center justify-center" data-testid="profile-initials">{initials}</div>
      )}
      <button type="button" onClick={() => input.current?.click()} disabled={busy} className="text-[11px] font-medium text-accent hover:underline disabled:opacity-50">
        {busy ? "Uploading…" : "Change photo"}
      </button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose a new profile photo" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      {message && <div className="text-[11px] text-label-secondary max-w-40 text-center" role="status">{message}</div>}
    </div>
  );
}
