import { useState } from "react";
import { api, ApiError } from "../../api/client";

const OPTIONS = [
  { value: "single", label: "Single" },
  { value: "married", label: "Married" },
  { value: "divorced", label: "Divorced" },
  { value: "widowed", label: "Widowed" },
];

/** BACKLOG48 - ask HR to change the marital status on the personal record. */
export function MaritalStatusRequest({ current }: { current?: string | null }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function send() {
    setSaving(true);
    setError(null);
    try {
      await api.submitEmployeeChangeRequest({ requestType: "marital_status", action: "update", payload: { maritalStatus: value } });
      setOpen(false);
      setNote("Sent to HR for approval. You can follow it under My change requests.");
      window.dispatchEvent(new Event("change-request-sent"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-black/5 text-sm">
      {!open && (
        <button className="text-xs font-semibold text-accent hover:underline" onClick={() => { setNote(null); setOpen(true); }}>
          Ask HR to change my marital status
        </button>
      )}
      {note && <div className="text-xs text-accent mt-1" role="status">{note}</div>}
      {open && (
        <div className="bg-black/5 rounded-lg p-3 space-y-3 max-w-sm">
          <label className="block text-xs font-medium" htmlFor="marital-request">New marital status</label>
          <select
            id="marital-request"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
          >
            <option value="">Choose…</option>
            {OPTIONS.filter((o) => o.value !== current).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {error && <div className="text-danger text-xs">{error}</div>}
          <div className="flex gap-3">
            <button disabled={!value || saving} onClick={send} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
              {saving ? "Sending…" : "Send to HR"}
            </button>
            <button onClick={() => setOpen(false)} className="text-xs font-medium text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
