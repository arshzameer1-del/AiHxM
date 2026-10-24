import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { EmployeeView } from "@aihxm/shared-types";
import { formatTime } from "./shared/dates";
import { useMyAttendance } from "./attendance/useMyAttendance";
import { useEmployeePhoto } from "./employees/employeePhoto";
import { bannerBackground } from "./employees/appearance";
import { useCompanyAppearance } from "./employees/useCompanyAppearance";

/**
 * The One exD "My Workspace" header: greeting, name, employee number chip, job line and four fact chips
 * (today, status, manager, work email). Shown on the home page in the One exD theme only.
 */

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return "Good morning,";
  if (h < 17) return "Good afternoon,";
  return "Good evening,";
}

function todayText(now: Date): string {
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const month = now.toLocaleDateString("en-US", { month: "long" });
  return `${weekday}, ${now.getDate()} ${month}`;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

export function WorkspaceHero({
  fullName,
  companyName,
  email,
  employeeId,
}: {
  fullName: string;
  companyName: string | null;
  email: string;
  employeeId: string | null;
}) {
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [managerName, setManagerName] = useState<string | null>(null);
  const attendance = useMyAttendance(employeeId ?? undefined);
  const photo = useEmployeePhoto(employeeId);
  const appearance = useCompanyAppearance();
  const background = bannerBackground(appearance?.view ?? null, appearance?.imageUrl ?? null);
  const now = new Date();
  const todayRow = attendance.days.get(attendance.today);
  let statusText: string | undefined;
  if (employeeId && !attendance.loading && !attendance.error) {
    if (todayRow?.open && todayRow.firstIn) statusText = `Clocked in ${formatTime(todayRow.firstIn)}`;
    else if (todayRow?.firstIn) statusText = `In ${formatTime(todayRow.firstIn)}`;
    else statusText = "Not clocked in";
  }

  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    api
      .getEmployee(employeeId)
      .then(async (e) => {
        if (cancelled) return;
        setEmployee(e);
        if (e.managerId) {
          try {
            const m = await api.getEmployee(e.managerId);
            if (!cancelled) setManagerName(`${m.firstName} ${m.lastName}`.trim());
          } catch {
            // The manager's record may be outside this viewer's scope; the chip then shows a dash.
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const jobLine = [employee?.designation, employee?.department].filter(Boolean).join(" / ") || companyName || "";
  const facts: { label: string; value: string; dot?: "on" | "off" }[] = [
    { label: "Today", value: todayText(now) },
    ...(statusText ? [{ label: "Status", value: statusText, dot: (todayRow?.open ? "on" : "off") as "on" | "off" }] : []),
    ...(employeeId ? [{ label: "Manager", value: managerName ?? "—" }] : []),
    { label: "Work email", value: employee?.email ?? email },
  ];

  return (
    <section className="ws-hero" aria-label="My workspace" style={background ? { background } : undefined} data-testid="ws-hero">
      <div className="ws-hero-avatar" aria-hidden={photo ? undefined : "true"}>
        {photo ? <img src={photo} alt="" className="ws-hero-photo" data-testid="hero-photo" /> : initialsOf(fullName)}
      </div>
      <div className="ws-hero-body">
        <div className="ws-hero-greet">{greeting(now)}</div>
        <div className="ws-hero-name">
          <h1>{fullName}</h1>
          {employee?.employeeNumber && <span className="ws-hero-empno">{employee.employeeNumber}</span>}
        </div>
        {jobLine && <div className="ws-hero-job">{jobLine}</div>}
        <dl className="ws-hero-facts">
          {facts.map((f) => (
            <div key={f.label} className="ws-hero-fact">
              <dt>{f.label}</dt>
              <dd>{f.dot && <span className={`ws-dot ws-dot-${f.dot}`} aria-hidden="true" />}{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
