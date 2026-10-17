import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttendanceDailyResultView, AttendanceRecordView, ResolvedWorkScheduleView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { localDayKey } from "../shared/dates";
import { buildDays, type DayRow } from "./attendanceDays";

export type MyAttendance = {
  loading: boolean;
  error: string | null;
  records: AttendanceRecordView[];
  days: Map<string, DayRow>;
  today: string;
  /** Today's resolved work schedule (shift hours, breaks, holiday), null when it could not be read. */
  schedule: ResolvedWorkScheduleView | null;
  reload: () => void;
};

/**
 * Everything the attendance cards need for one person, read once: the last punches, the processed days the
 * nightly run produced (best effort), and today's schedule (best effort). Only the punches are essential.
 */
export function useMyAttendance(employeeId: string | undefined, refreshKey = 0): MyAttendance {
  const [records, setRecords] = useState<AttendanceRecordView[] | null>(null);
  const [results, setResults] = useState<AttendanceDailyResultView[]>([]);
  const [schedule, setSchedule] = useState<ResolvedWorkScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const today = localDayKey(new Date());

  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    const from = localDayKey(new Date(Date.now() - 34 * 86400000));
    Promise.all([
      api.listAttendance(employeeId, 80),
      api.attendanceResults(employeeId, from, today).catch(() => [] as AttendanceDailyResultView[]),
      api.getEmployeeWorkSchedule(employeeId, today).catch(() => null),
    ])
      .then(([r, res, sched]) => {
        if (cancelled) return;
        setRecords(r);
        setResults(res);
        setSchedule(sched);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your attendance.");
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, refreshKey, tick, today]);

  const days = useMemo(() => buildDays(records ?? [], results), [records, results]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { loading: records === null && !error, error, records: records ?? [], days, today, schedule, reload };
}
