import { useState } from "react";
import type { AttendanceCorrectionRequestView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * Attendance Policies increment 1 (see the project roadmap doc's Part 4)
 * — a self-service employee asking for a missed/wrong punch to be fixed.
 * `requestedDate` isn't its own field here: it's derived from whichever
 * corrected time the employee actually filled in, the same "derive it,
 * don't ask the user to enter something the system already knows"
 * discipline the rest of this portal follows.
 */
export function AttendanceCorrectionForm({
  employeeId,
  onCancel,
  onSubmitted,
}: {
  employeeId: string;
  onCancel: () => void;
  onSubmitted: (result: AttendanceCorrectionRequestView) => void;
}) {
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clockIn && !clockOut) {
      setError("Enter a corrected clock-in and/or clock-out time.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.submitAttendanceCorrection({
        employeeId,
        requestedDate: (clockIn || clockOut).slice(0, 10),
        requestedClockIn: clockIn ? new Date(clockIn).toISOString() : undefined,
        requestedClockOut: clockOut ? new Date(clockOut).toISOString() : undefined,
        reason,
      });
      setClockIn("");
      setClockOut("");
      setReason("");
      onSubmitted(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the correction request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/[0.03] rounded-lg p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-label-tertiary">
          Corrected clock-in
          <input
            type="datetime-local"
            value={clockIn}
            onChange={(e) => setClockIn(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="text-xs text-label-tertiary">
          Corrected clock-out
          <input
            type="datetime-local"
            value={clockOut}
            onChange={(e) => setClockOut(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
      </div>
      <label className="block text-xs text-label-tertiary">
        Reason
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          placeholder="e.g. Biometric device was down that morning"
          className="mt-1 w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-3 items-center">
        <button
          type="submit"
          disabled={busy}
          className="text-sm font-semibold rounded-lg px-3 py-1.5 bg-accent text-white disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Submit request"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-label-tertiary">
          Cancel
        </button>
      </div>
    </form>
  );
}
