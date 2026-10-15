import { useEffect, useState } from "react";
import type { AttendanceCorrectionRequestView, AttendanceRecordView, EmployeeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { AttendanceCorrectionForm } from "./AttendanceCorrectionForm";
import { SapSection } from "../shared/FormSections";
import { describeError } from "../shared/describeError";
import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_STATUS_STYLES, CORRECTION_STATUS_LABELS, CORRECTION_STATUS_STYLES } from "./attendanceLabels";

/**
 * Pages of the Time & Attendance module. Each is one task on its own page (the launchpad tiles link here):
 * Clock In / Out, and Attendance Corrections. `attendance.record.self` is granted only to
 * `employee_self_service` (0016_leave_attendance_seed.sql), so the tiles only offer these to that role.
 */

function useAttendance(employeeId: string, refreshKey: number) {
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRecordView[] | null>(null);
  const [corrections, setCorrections] = useState<AttendanceCorrectionRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api.getEmployee(employeeId), api.listAttendance(employeeId), api.listAttendanceCorrections(employeeId)])
      .then(([emp, att, corr]) => {
        setEmployee(emp);
        setAttendance(att);
        setCorrections(corr);
      })
      .catch((err) => setError(describeError(err)));
  }, [employeeId, refreshKey]);
  return { employee, attendance, corrections, error };
}

export function ClockPanel({ employeeId, refreshKey, onChanged }: { employeeId: string; refreshKey: number; onChanged: () => void }) {
  const { employee, attendance, error } = useAttendance(employeeId, refreshKey);
  const [busy, setBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const clockedIn = Boolean(attendance && attendance.length > 0 && attendance[0].clockOutAt === null);

  async function handleClock() {
    if (!employee) return;
    setBusy(true);
    setClockError(null);
    try {
      if (clockedIn) await api.clockOut({ employeeNumber: employee.employeeNumber });
      else await api.clockIn({ employeeNumber: employee.employeeNumber, source: "manual" });
      onChanged();
    } catch (err) {
      setClockError(err instanceof ApiError ? err.message : "Could not record attendance.");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <div className="grid lg:grid-cols-2 gap-x-4 items-start">
      <SapSection title="Clock In / Out" collapsible={false}>
        <div className="flex items-center gap-4 flex-wrap">
          {employee && (
            <button
              type="button"
              onClick={handleClock}
              disabled={busy}
              className={`text-sm font-semibold rounded px-5 py-2 disabled:opacity-50 ${clockedIn ? "bg-danger/10 text-danger" : "bg-accent text-white"}`}
            >
              {busy ? "…" : clockedIn ? "Clock out" : "Clock in"}
            </button>
          )}
          {clockedIn && attendance && (
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs text-label-secondary">
                Clocked in since {new Date(attendance[0].clockInAt).toLocaleString()}
                {attendance[0].shiftName && ` · ${attendance[0].shiftName} shift`}
              </p>
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ATTENDANCE_STATUS_STYLES[attendance[0].status]}`}>
                {ATTENDANCE_STATUS_LABELS[attendance[0].status]}
              </span>
            </div>
          )}
          {!clockedIn && attendance && <p className="text-xs text-label-secondary">You are not clocked in.</p>}
        </div>
        {clockError && <p className="text-xs text-danger mt-3">{clockError}</p>}
      </SapSection>

      <SapSection title="Recent attendance" count={attendance?.length}>
        {!attendance ? (
          <p className="text-sm text-label-tertiary">Loading…</p>
        ) : attendance.length === 0 ? (
          <p className="text-sm text-label-tertiary">No attendance recorded yet.</p>
        ) : (
          <div className="space-y-2">
            {attendance.slice(0, 10).map((rec) => (
              <div key={rec.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-label-secondary">
                  {new Date(rec.clockInAt).toLocaleDateString()}
                  {rec.shiftName && <span className="text-label-tertiary"> · {rec.shiftName}</span>}
                </span>
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ATTENDANCE_STATUS_STYLES[rec.status]}`}>{ATTENDANCE_STATUS_LABELS[rec.status]}</span>
              </div>
            ))}
          </div>
        )}
      </SapSection>
    </div>
  );
}

export function CorrectionsPanel({ employeeId, refreshKey, onChanged }: { employeeId: string; refreshKey: number; onChanged: () => void }) {
  const { corrections, error } = useAttendance(employeeId, refreshKey);
  const [showForm, setShowForm] = useState(false);

  if (error) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-secondary">{error}</div>;

  return (
    <div className="grid lg:grid-cols-2 gap-x-4 items-start">
      <SapSection
        title="Request a correction"
        collapsible={false}
        actions={
          !showForm ? (
            <button type="button" onClick={() => setShowForm(true)} className="text-sm font-semibold text-accent hover:underline">
              Request correction
            </button>
          ) : undefined
        }
      >
        {showForm ? (
          <AttendanceCorrectionForm
            employeeId={employeeId}
            onCancel={() => setShowForm(false)}
            onSubmitted={() => {
              setShowForm(false);
              onChanged();
            }}
          />
        ) : (
          <p className="text-sm text-label-secondary">Missed a clock-in or clock-out, or one is wrong? Send a correction to your approver.</p>
        )}
      </SapSection>

      <SapSection title="Correction requests" count={corrections?.length}>
        {!corrections ? (
          <p className="text-sm text-label-tertiary">Loading…</p>
        ) : corrections.length === 0 ? (
          <p className="text-sm text-label-tertiary">You have not requested any corrections.</p>
        ) : (
          <div className="space-y-2">
            {corrections.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-label-secondary">
                  {c.requestedDate}
                  {c.reason && <span className="text-label-tertiary"> · &ldquo;{c.reason}&rdquo;</span>}
                </span>
                <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${CORRECTION_STATUS_STYLES[c.status]}`}>{CORRECTION_STATUS_LABELS[c.status]}</span>
              </div>
            ))}
          </div>
        )}
      </SapSection>
    </div>
  );
}
