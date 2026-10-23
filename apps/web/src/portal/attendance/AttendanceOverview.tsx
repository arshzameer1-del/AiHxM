import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarOff, Check, FileEdit, Hourglass, MapPinned, Send, Sun } from "lucide-react";
import type { TimesheetView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ProgressRing } from "../../components/ProgressRing";
import { LoadingNote } from "../shared/PageChrome";
import { todayIso } from "../shared/dates";
import { minutesText } from "./attendanceDays";
import { attendanceMonth, awayCounts, clockText, hoursAtWork, hoursText, punctuality, weekHours, WEEK_TARGET_MINUTES } from "./attendanceStats";
import type { MyAttendance } from "./useMyAttendance";

const GREEN = "rgb(var(--c-success))";
const BLUE = "rgb(var(--c-accent))";
const RED = "rgb(var(--c-danger))";
const PLUM = "rgb(var(--c-brand-secondary))";
const AMBER = "rgb(var(--c-warning))";

function percentText(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

function Row({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="inline-flex items-center gap-2 text-label-secondary">
        <span className="w-2 h-2 rounded-full" style={{ background: dot }} aria-hidden="true" />
        {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function RingCard({ title, ring, children, note, testId }: { title: string; ring: React.ReactNode; children: React.ReactNode; note?: string; testId: string }) {
  return (
    <section className="overview-card bg-card rounded-card shadow-sm border border-black/5 p-4 flex items-center gap-4" data-testid={testId}>
      {ring}
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-bold mb-1.5">{title}</h3>
        <div className="space-y-1">{children}</div>
        {note && <p className="text-xs text-label-tertiary mt-1.5">{note}</p>}
      </div>
    </section>
  );
}

/** The pipeline of this week's hours, from "not typed in yet" to "signed off". Until hours are typed in, the clock's hours stand in. */
function weekPipeline(sheet: TimesheetView | null, worked: number) {
  const entered = (sheet?.entries ?? []).reduce((s, e) => s + e.minutes, 0);
  const usingClock = entered === 0;
  const hours = usingClock ? worked : entered;
  const status = sheet?.status;
  const open = !status || status === "draft" || status === "returned" || status === "rejected" || status === "cancelled";
  return {
    notEntered: Math.max(0, WEEK_TARGET_MINUTES - hours),
    draft: open ? hours : 0,
    sent: status === "pending" ? hours : 0,
    approved: status === "approved" ? hours : 0,
    usingClock,
  };
}

type Tile = { key: string; label: string; value: string; sub: string; tone: string; icon: typeof Check; testId: string };

/**
 * The top of Time & Attendance, like One exD's "Time & Attendance" workspace section: four rings (this week, the last 30 days,
 * punctuality, hours at work) and a row of tiles that follow this week's timesheet from "not entered" to "approved",
 * then leave, public holidays and on-duty days from the last 30.
 */
export function AttendanceOverview({ employeeId, data, refreshKey = 0 }: { employeeId: string; data: MyAttendance; refreshKey?: number }) {
  const [sheet, setSheet] = useState<TimesheetView | null>(null);
  const [sheetFailed, setSheetFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .timesheetForWeek(employeeId, todayIso())
      .then((t) => !cancelled && (setSheet(t), setSheetFailed(false)))
      .catch(() => !cancelled && setSheetFailed(true));
    return () => {
      cancelled = true;
    };
  }, [employeeId, refreshKey]);

  const { days, today } = data;
  const week = useMemo(() => weekHours(days, today), [days, today]);
  const month = useMemo(() => attendanceMonth(days, today), [days, today]);
  const punct = useMemo(() => punctuality(days, today), [days, today]);
  const work = useMemo(() => hoursAtWork(days, today), [days, today]);
  const away = useMemo(() => awayCounts(days, today), [days, today]);
  const pipe = weekPipeline(sheet, week.workedMinutes);

  if (data.loading) return <LoadingNote what="your attendance overview" />;
  if (data.error) return null;

  const tiles: Tile[] = [
    { key: "not-entered", label: "Not entered", value: sheetFailed ? "—" : `${hoursText(pipe.notEntered)}h`, sub: "missing this week", tone: "gray", icon: Hourglass, testId: "pipe-not-entered" },
    { key: "draft", label: "Draft", value: `${hoursText(pipe.draft)}h`, sub: "not submitted", tone: "blue", icon: FileEdit, testId: "pipe-draft" },
    { key: "sent", label: "Sent for approval", value: `${hoursText(pipe.sent)}h`, sub: "with your approver", tone: "amber", icon: Send, testId: "pipe-sent" },
    { key: "approved", label: "Approved", value: `${hoursText(pipe.approved)}h`, sub: "signed off", tone: "green", icon: Check, testId: "pipe-approved" },
    { key: "duty", label: "On duty", value: String(away.onDutyDays), sub: "days, last 30", tone: "teal", icon: MapPinned, testId: "pipe-on-duty" },
    { key: "leave", label: "On leave", value: String(away.leaveDays), sub: "days, last 30", tone: "orange", icon: CalendarOff, testId: "pipe-leave" },
    { key: "holiday", label: "Public holidays", value: String(away.holidayDays), sub: "days, last 30", tone: "plum", icon: Sun, testId: "pipe-holiday" },
  ];

  return (
    <div className="mb-6" data-testid="attendance-overview">
      <div className="grid gap-3 md:grid-cols-2">
        <RingCard
          testId="ring-week"
          title="Hours this week"
          ring={<ProgressRing label={`${hoursText(week.workedMinutes)} of ${WEEK_TARGET_MINUTES / 60} hours this week`} segments={[{ fraction: week.fraction, color: BLUE }]} centre={hoursText(week.workedMinutes)} caption={`of ${WEEK_TARGET_MINUTES / 60}h`} />}
          note="This week"
        >
          <Row dot={GREEN} label="Remaining" value={`${hoursText(week.remainingMinutes)}h`} />
          <Row dot={BLUE} label="Per working day" value={`${hoursText(week.perRemainingDayMinutes)}h`} />
        </RingCard>

        <RingCard
          testId="ring-month"
          title="Attendance, 30 days"
          ring={
            <ProgressRing
              label={`Present ${percentText(month.presentPercent)} over the last 30 days`}
              segments={month.counted > 0 ? [{ fraction: (month.onTime + month.other) / month.counted, color: GREEN }, { fraction: month.late / month.counted, color: BLUE }, { fraction: month.absent / month.counted, color: RED }] : []}
              centre={percentText(month.presentPercent)}
              caption="present"
            />
          }
        >
          <Row dot={GREEN} label="On time" value={String(month.onTime)} />
          <Row dot={BLUE} label="Late" value={String(month.late)} />
          <Row dot={RED} label="Absent" value={String(month.absent)} />
        </RingCard>

        <RingCard
          testId="ring-punctuality"
          title="Punctuality"
          ring={<ProgressRing label={`Average check-in ${punct.averageIn === null ? "unknown" : clockText(punct.averageIn)}`} segments={[{ fraction: (punct.onTimePercent ?? 0) / 100, color: GREEN }]} centre={punct.averageIn === null ? "—" : clockText(punct.averageIn)} caption="avg in" />}
        >
          <Row dot={GREEN} label="On time" value={percentText(punct.onTimePercent)} />
          <Row dot={BLUE} label="Earliest" value={punct.earliestIn === null ? "—" : clockText(punct.earliestIn)} />
          <Row dot={PLUM} label="Latest" value={punct.latestIn === null ? "—" : clockText(punct.latestIn)} />
        </RingCard>

        <RingCard
          testId="ring-hours"
          title="Hours at work"
          ring={<ProgressRing label={`Average day ${minutesText(work.averageMinutes)}`} segments={[{ fraction: work.fraction, color: PLUM }]} centre={work.averageMinutes ? minutesText(work.averageMinutes) : "—"} caption="avg day" />}
          note={`target ${work.targetMinutes / 60}h a day`}
        >
          <Row dot={PLUM} label="Longest day" value={minutesText(work.longestMinutes)} />
          <Row dot={AMBER} label="Days checked in" value={String(work.daysCheckedIn)} />
        </RingCard>
      </div>

      <div className="pipeline grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mt-3" role="list" aria-label="This week's hours and the last 30 days">
        {tiles.map((t, i) => {
          const Icon = t.icon;
          return (
            <div key={t.key} role="listitem" className={`pipe-tile pipe-${t.tone} bg-card rounded-card shadow-sm border border-black/5 px-3 py-2.5 relative`} data-testid={t.testId}>
              <div className="flex items-center gap-1.5 text-xs text-label-secondary">
                <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
                <span className="truncate">{t.label}</span>
              </div>
              <div className="text-xl font-bold tabular-nums mt-0.5">{t.value}</div>
              <div className="text-[11px] text-label-tertiary truncate">{t.sub}</div>
              {i < 3 && <ArrowRight size={13} className="pipe-arrow hidden lg:block absolute -right-2.5 top-1/2 -translate-y-1/2 text-label-tertiary bg-surface rounded-full z-10" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
      {pipe.usingClock && !sheetFailed && (
        <p className="text-xs text-label-tertiary mt-2">
          Hours are taken from the clock until you type them into the <Link to="/app/attendance/timesheet" className="underline">timesheet</Link>.
        </p>
      )}
    </div>
  );
}
