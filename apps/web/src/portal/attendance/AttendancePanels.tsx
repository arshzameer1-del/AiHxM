import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import type { AttendanceCorrectionRequestView, AttendanceRecordView, EmployeeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { AttendanceCorrectionForm } from "./AttendanceCorrectionForm";
import { SapSection } from "../shared/FormSections";
import { describeError } from "../shared/describeError";
import { staleClockInHours, staleClockInMessage } from "./openClockIn";
import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_STATUS_STYLES, CORRECTION_STATUS_LABELS, CORRECTION_STATUS_STYLES } from "./attendanceLabels";
import { formatDay, formatTime } from "../shared/dates";
import { minutesText, runningText } from "./attendanceDays";
import { MyAttendanceCard } from "./AttendanceCards";
import { summariseShift } from "./scheduleText";
import { useMyAttendance } from "./useMyAttendance";

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
    Promise.all([api.getEmployee(employeeId), api.listAttendance(employeeId, 1), api.listAttendanceCorrections(employeeId)])
      .then(([emp, att, corr]) => {
        setEmployee(emp);
        setAttendance(att);
        setCorrections(corr);
      })
      .catch((err) => setError(describeError(err)));
  }, [employeeId, refreshKey]);
  return { employee, attendance, corrections, error };
}

function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Clock In / Out, laid out like the reference dashboard: today's shift, a live running time while clocked in, the
 * day's punches with first in / last out / worked, and the month of attendance below. The punch itself is the same
 * API call as before (clock-in / clock-out by employee number).
 */
export function ClockPanel({ employeeId, refreshKey, onChanged }: { employeeId: string; refreshKey: number; onChanged: () => void }) {
  const data = useMyAttendance(employeeId, refreshKey);
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [employeeError, setEmployeeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  useEffect(() => {
    api.getEmployee(employeeId).then(setEmployee).catch((err) => setEmployeeError(describeError(err)));
  }, [employeeId]);

  const latest = data.records[0] ?? null;
  const clockedIn = Boolean(latest && latest.clockOutAt === null);
  const now = useNow(clockedIn);
  const todayRow = data.days.get(data.today);
  // One clock-in and one clock-out per day: once today has a finished punch pair, the button is switched off.
  const doneForToday = !clockedIn && Boolean(todayRow?.lastOut);
  const autoClosedIns = new Set(data.records.filter((r) => r.autoClosed).map((r) => new Date(r.clockInAt).getTime()));
  const shift = summariseShift(data.schedule);
  const staleHours = clockedIn && latest ? staleClockInHours(latest.clockInAt) : null;

  async function punch(kind: "in" | "out") {
    if (!employee) return;
    setBusy(true);
    setClockError(null);
    try {
      if (kind === "out") await api.clockOut({ employeeNumber: employee.employeeNumber });
      else await api.clockIn({ employeeNumber: employee.employeeNumber, source: "manual" });
      data.reload();
      onChanged();
    } catch (err) {
      setClockError(err instanceof ApiError ? err.message : "Could not record attendance.");
    } finally {
      setBusy(false);
    }
  }

  // Two buttons, each used once a day: Clock in switches off after the clock-in, Clock out after the clock-out. The next day starts both fresh.
  const canClockIn = !clockedIn && !doneForToday;
  const canClockOut = clockedIn;
  const inTime = todayRow?.firstIn ? formatTime(todayRow.firstIn) : null;
  const outTime = !clockedIn && todayRow?.lastOut ? formatTime(todayRow.lastOut) : null;

  if (employeeError) return <div className="bg-white rounded-md p-5 shadow-sm text-sm text-label-secondary">{employeeError}</div>;

  const todaySessions = todayRow?.sessions ?? [];

  return (
    <div className="grid xl:grid-cols-2 gap-4 items-start">
      <section className="bg-card rounded-card shadow-sm border border-black/5 overflow-hidden" data-testid="clock-card">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-black/5">
          <Clock size={18} strokeWidth={1.75} className="text-accent" aria-hidden />
          <h2 className="text-base font-bold">Clock In / Out</h2>
        </header>
        <div className="p-4 space-y-4">
          <div className="rounded-lg bg-black/[0.03] border border-black/5 px-4 py-3" data-testid="shift-today">
            <div className="text-xs uppercase tracking-wide text-label-tertiary">Today's shift</div>
            <div className="text-base font-bold mt-0.5">{shift.title}</div>
            {shift.hours && <div className="text-sm tabular-nums mt-0.5" data-testid="shift-hours">{shift.hours}</div>}
            {shift.detail && <div className="text-xs text-label-secondary mt-0.5">{shift.detail}</div>}
          </div>

          <div className="grid grid-cols-2 gap-3" data-testid="clock-buttons">
            <div className="flex flex-col items-stretch gap-1.5">
              <button
                type="button"
                onClick={() => punch("in")}
                disabled={busy || !employee || data.loading || !canClockIn}
                data-testid="clock-in-button"
                className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy && canClockIn ? "…" : "Clock in"}
              </button>
              <p className="text-xs text-center tabular-nums text-label-secondary" data-testid="clock-in-time">{inTime ? `In at ${inTime}` : "Not clocked in yet"}</p>
            </div>
            <div className="flex flex-col items-stretch gap-1.5">
              <button
                type="button"
                onClick={() => punch("out")}
                disabled={busy || !employee || data.loading || !canClockOut}
                data-testid="clock-out-button"
                className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-danger/10 text-danger disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy && canClockOut ? "…" : "Clock out"}
              </button>
              <p className="text-xs text-center tabular-nums text-label-secondary" data-testid="clock-out-time">{outTime ? `Out at ${outTime}` : clockedIn ? "Still working" : "—"}</p>
            </div>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="min-w-0">
              {data.loading ? (
                <p className="text-xs text-label-secondary">Checking your attendance…</p>
              ) : clockedIn && latest ? (
                <>
                  <p className="text-xs text-label-secondary">
                    Clocked in since {formatTime(latest.clockInAt)}
                    {latest.shiftName && ` · ${latest.shiftName}`}
                  </p>
                  <p className="text-xl font-bold tabular-nums" aria-live="off" data-testid="running-time">
                    {runningText(latest.clockInAt, now)}
                  </p>
                </>
              ) : todayRow?.lastOut ? (
                <p className="text-xs text-label-secondary" data-testid="done-for-today">
                  You clocked in and out for today (one per day). Clock-out at {formatTime(todayRow.lastOut)}.
                </p>
              ) : (
                <p className="text-xs text-label-secondary">You are not clocked in.</p>
              )}
            </div>
            {clockedIn && latest && (
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ATTENDANCE_STATUS_STYLES[latest.status]}`}>{ATTENDANCE_STATUS_LABELS[latest.status]}</span>
            )}
          </div>
          {staleHours !== null && latest && (
            <p className="text-xs text-warning" role="alert" data-testid="stale-clock-in">
              {staleClockInMessage(staleHours)}{" "}
              <Link to="/app/attendance/corrections" className="font-semibold underline">Ask for a correction</Link>
            </p>
          )}
          {clockError && <p className="text-xs text-danger">{clockError}</p>}

          <div className="grid grid-cols-3 gap-2 text-center rounded-lg border border-black/5 px-3 py-3" data-testid="today-summary">
            <TodayStat label="Check-in" value={todayRow?.firstIn ? formatTime(todayRow.firstIn) : "—"} />
            <TodayStat label="Check-out" value={clockedIn ? "Working…" : todayRow?.lastOut ? formatTime(todayRow.lastOut) : "—"} />
            <TodayStat label="Worked" value={todayRow ? minutesText(todayRow.workedMinutes) : "—"} />
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-label-tertiary font-semibold mb-1.5">Today's punches{todaySessions.length > 0 && ` (${todaySessions.length})`}</h3>
            {todaySessions.length === 0 ? (
              <p className="text-sm text-label-tertiary">No punches yet today.</p>
            ) : (
              <ul className="divide-y divide-black/5 text-sm tabular-nums" data-testid="today-punches">
                {todaySessions.map((s, i) => (
                  <li key={s.inAt} className="flex items-center justify-between py-1.5">
                    <span>
                      <span className="text-label-tertiary mr-2">{i + 1}.</span>
                      {formatTime(s.inAt)} – {s.outAt ? formatTime(s.outAt) : "now"}
                      {autoClosedIns.has(new Date(s.inAt).getTime()) && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-warning/10 text-warning" title="No clock-out was recorded, so the system set it to the shift end time" data-testid="auto-clock-out">
                          Auto clock-out
                        </span>
                      )}
                    </span>
                    <span className="text-label-secondary">{s.outAt ? minutesText(Math.round((new Date(s.outAt).getTime() - new Date(s.inAt).getTime()) / 60000)) : "running"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <MyAttendanceCard data={data} />
    </div>
  );
}

function TodayStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-label-tertiary">{label}</div>
      <div className="text-base font-bold mt-0.5">{value}</div>
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
          <LoadingNote />
        ) : corrections.length === 0 ? (
          <p className="text-sm text-label-tertiary">You have not requested any corrections.</p>
        ) : (
          <div className="space-y-2">
            {corrections.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-label-secondary">
                  {formatDay(c.requestedDate)}
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
