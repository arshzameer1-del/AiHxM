import { useEffect, useState } from "react";
import { hasAnyRoleKey, hasEssPortalRole, isSelfService } from "./shared/roles";
import { formatDay, formatPeriod, formatTime, todayIso } from "./shared/dates";
import { StarterSetupNudge } from "./admin/StarterSetupNudge";
import { EssTiles } from "./ess/EssLaunchpad";
import { Link } from "react-router-dom";
import {
  type LucideIcon,
  User,
  Users,
  UserPlus,
  Network,
  Settings2,
  ShieldCheck,
  Terminal,
  CalendarDays,
  Briefcase,
  Target,
  Wallet,
  Clock,
  Hourglass,
  FileText,
} from "lucide-react";
import type {
  LeaveBalanceView,
  LeaveRequestView,
  ModuleKey,
  OrganizationCommandCenterSummary,
  TenantRoleKey,
} from "@aihxm/shared-types";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/useTheme";
import { hueOf } from "../components/shell/hue";
import { WorkspaceHero } from "./WorkspaceHero";
import { ActionCentre } from "./ActionCentre";
import { api } from "../api/client";
import { leaveTypeLabel, STATUS_LABELS, STATUS_STYLES } from "./leave/leaveLabels";
import { MyAttendanceCard, MyTimesheetCard } from "./attendance/AttendanceCards";
import { DAY_KIND_LABELS, minutesText } from "./attendance/attendanceDays";
import { summariseShift } from "./attendance/scheduleText";
import { useMyAttendance, type MyAttendance } from "./attendance/useMyAttendance";

const ROLE_LABELS: Record<string, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee",
  ess_portal: "Employee Self Service",
};

// Theme alignment pass (2026-09-26) — kumail's reference screenshot shows
// the tenant home page as a grid of module cards (icon badge + title +
// one-line description), not the plain "modules enabled" pill list this
// page used to lead with. Mirrors buildNavItems()'s own gating in
// PortalLayout.tsx exactly (same role/module conditions, same routes) so a
// card here never links anywhere the sidebar itself wouldn't also show —
// deliberately NOT duplicating that function; a small parallel list is
// easier to keep honest than importing a function that returns nav-only
// shapes (icons/children) this page doesn't need. Per kumail's explicit
// instruction, these cards carry no status/phase badge — the reference
// prototype's "Phase 1/2/3" pills marked build order for a not-yet-built
// roadmap, which doesn't apply to features that are already live.
type HomeCard = { to: string; label: string; description: string; icon: LucideIcon };

function buildHomeCards(roleKeys: TenantRoleKey[], enabledModules: ModuleKey[]): HomeCard[] {
  const hasRole = (...keys: TenantRoleKey[]) => keys.some((k) => roleKeys.includes(k));
  const hasModule = (key: ModuleKey) => enabledModules.includes(key);
  const cards: HomeCard[] = [];

  if ((hasRole("hr_admin", "line_manager") || hasAnyRoleKey(roleKeys, "regional_hr")) && hasModule("employee")) {
    cards.push({ to: "/app/employees", label: "Employees", description: "Directory, records & profiles", icon: Users });
    if (hasRole("hr_admin")) cards.push({ to: "/app/hire", label: "Hire", description: "Guided hire, quick add & bulk hiring", icon: UserPlus });
  } else if (roleKeys.length > 0 && hasModule("employee")) {
    cards.push({ to: "/app/profile", label: "My Profile", description: "Your own employee record", icon: User });
  }

  if (hasModule("employee") && (hasRole("hr_admin") || hasRole("employee_self_service", "ess_portal", "line_manager"))) {
    if (hasRole("hr_admin")) cards.push({ to: "/app/organization", label: "Organization", description: "Org chart, positions & structure", icon: Network });
    else cards.push({ to: "/app/ess/org-chart", label: "My Org Chart", description: "My manager, colleagues and team", icon: Network });
  }

  if (hasRole("hr_admin", "system_admin")) {
    cards.push({ to: "/app/configuration-center", label: "Configuration Center", description: "Tenant setup & configuration", icon: Settings2 });
  }

  if (hasRole("hr_admin")) {
    cards.push({ to: "/app/admin", label: "Admin Center", description: "Policies, schedules & groups", icon: ShieldCheck });
  }

  if (hasRole("system_admin")) {
    cards.push({ to: "/app/system-admin", label: "System Admin", description: "Roles, workflow & platform rules", icon: Terminal });
  }

  if (hasModule("leave") && roleKeys.length > 0) {
    cards.push({ to: "/app/leave", label: "Leave Management", description: "Requests, balances & calendar", icon: CalendarDays });
    cards.push({ to: "/app/attendance", label: "Time & Attendance", description: "Clock, timesheet & corrections", icon: Clock });
  }

  if (hasRole("hr_admin") && hasModule("recruitment")) {
    cards.push({ to: "/app/recruitment", label: "Recruitment", description: "Requisitions, candidates & offers", icon: Briefcase });
  } else if (hasRole("line_manager") && hasModule("recruitment")) {
    cards.push({ to: "/app/my-hiring", label: "My Hiring", description: "Roles you hire for & your interviews", icon: Briefcase });
  }

  if (hasModule("performance") && roleKeys.length > 0) {
    cards.push({ to: "/app/performance", label: "Performance", description: "Goals & review cycles", icon: Target });
  }

  if (hasModule("payroll") && (hasRole("hr_admin", "employee_self_service", "ess_portal", "payroll_approver") || hasAnyRoleKey(roleKeys, "regional_payroll"))) {
    cards.push({ to: "/app/payroll", label: "Payroll", description: "Payslips & statutory calculations", icon: Wallet });
  }

  return cards;
}

function HomeCardTile({ card }: { card: HomeCard }) {
  const Icon = card.icon;
  return (
    <Link
      to={card.to}
      className="flex flex-col gap-3 bg-card rounded-card p-4 shadow-sm ui-card"
    >
      <div className="home-tile-icon hue-chip w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center" data-hue={hueOf(card.label)}>
        <Icon size={20} strokeWidth={1.75} />
      </div>
      <div>
        <div className="font-semibold text-sm">{card.label}</div>
        <div className="text-xs text-label-tertiary mt-0.5">{card.description}</div>
      </div>
    </Link>
  );
}

// UI Re-skin Phase 4 (2026-10) — AiHxM Enterprise UI Design System Master
// Instruction, Part 2 category 1 ("Employee Dashboard / ESS Home"): "KPI
// row: leave balance, today's attendance, pending personal requests…
// Personal employee data only; enforce employee self-scope." This reads
// the exact same real endpoints LeavePage.tsx's own ESS section already
// uses (getLeaveBalances/listAttendance/listLeaveRequests, all
// server-scoped to the caller's own employeeId) — no new backend, no
// mock data, just a glance-sized summary of what's already real. Shown
// to anyone with an employeeId (every role is also a person with their
// own leave/attendance — not employee_self_service-only), never company-
// wide figures.

function useMyLeaveAndAttendanceSnapshot(employeeId: string | null) {
  const [balances, setBalances] = useState<LeaveBalanceView[] | null>(null);
  const [requests, setRequests] = useState<LeaveRequestView[] | null>(null);

  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    Promise.all([
      api.getLeaveBalances(employeeId).catch(() => [] as LeaveBalanceView[]),
      api.listLeaveRequests(employeeId).catch(() => [] as LeaveRequestView[]),
    ]).then(([b, r]) => {
      if (cancelled) return;
      setBalances(b);
      setRequests(r);
    });
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const pendingLeaveCount = requests ? requests.filter((r) => r.status === "pending").length : null;

  return { balances, requests, pendingLeaveCount };
}

function MyDayKpiRow({
  balances,
  attendance,
  pendingLeaveCount,
  attendanceLink,
}: {
  balances: LeaveBalanceView[] | null;
  attendance: MyAttendance;
  pendingLeaveCount: number | null;
  /** Where the attendance tile opens (the Clock In / Out page for people who can punch, the module otherwise). */
  attendanceLink: string;
}) {
  const totalRemainingLeave = balances?.reduce((sum, b) => sum + b.remainingDays, 0) ?? null;
  const todayRow = attendance.days.get(attendance.today);
  const shift = summariseShift(attendance.schedule);
  const clockedIn = Boolean(todayRow?.open);

  let attendanceValue = "…";
  if (!attendance.loading) {
    if (attendance.error) attendanceValue = "Unavailable";
    else if (clockedIn && todayRow?.firstIn) attendanceValue = `Clocked in ${formatTime(todayRow.firstIn)}`;
    else if (todayRow?.firstIn) attendanceValue = `${DAY_KIND_LABELS[todayRow.kind]} · ${minutesText(todayRow.workedMinutes)}`;
    else if (!shift.working && attendance.schedule) attendanceValue = shift.title;
    else attendanceValue = "Not clocked in";
  }
  const attendanceSub = shift.hours ? `${shift.title} · ${shift.hours}` : shift.title;
  const lateToday = todayRow?.kind === "late" || todayRow?.kind === "early";

  const cards: { label: string; value: string; sub?: string; to: string; icon: LucideIcon; tone: "accent" | "success" | "warning"; testId: string }[] = [
    {
      label: "Leave balance",
      value: totalRemainingLeave === null ? "…" : `${totalRemainingLeave} days`,
      to: "/app/leave",
      icon: CalendarDays,
      tone: "accent",
      testId: "kpi-leave",
    },
    {
      label: "Today's attendance",
      value: attendanceValue,
      sub: attendance.loading || attendance.error ? undefined : attendanceSub,
      to: attendanceLink,
      icon: Clock,
      tone: lateToday ? "warning" : "success",
      testId: "kpi-attendance",
    },
    {
      label: "Pending requests",
      value: pendingLeaveCount === null ? "…" : String(pendingLeaveCount),
      to: "/app/leave",
      icon: Hourglass,
      tone: pendingLeaveCount && pendingLeaveCount > 0 ? "warning" : "accent",
      testId: "kpi-pending",
    },
  ];

  const toneClasses: Record<string, string> = {
    accent: "bg-accent/10 text-accent",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
  };

  const tileClasses = ["kpi-tile-indigo", "kpi-tile-green", "kpi-tile-plum"];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
      {cards.map((card, index) => {
        const Icon = card.icon;
        return (
          <Link
            key={card.label}
            to={card.to}
            data-testid={card.testId}
            className={`kpi-tile ${tileClasses[index % tileClasses.length]} bg-card rounded-card p-4 shadow-sm ui-card flex items-center gap-3`}
          >
            <div className={`kpi-tile-icon w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${toneClasses[card.tone]}`}>
              <Icon size={20} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-lg font-bold tabular-nums truncate">{card.value}</div>
              <div className="text-xs text-label-tertiary truncate">{card.label}</div>
              {card.sub && <div className="text-xs text-label-secondary truncate" data-testid="kpi-attendance-shift">{card.sub}</div>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Part 2 category 1's "Quick actions: Apply Leave, Attendance
 * Regularization, View Payslip, Submit Expense, Documents." Expense
 * Management doesn't exist in AiHxM yet (flagged separately, not
 * fabricated here); "Documents" routes to the My Profile Documents tab
 * shipped alongside this. Every action here is a plain route the sidebar
 * already exposes — this is a shortcut to the same destinations the
 * module tiles below link to, not a second navigation system or any new
 * logic of its own.
 */
function QuickActionsRow({ enabledModules, roleKeys }: { enabledModules: ModuleKey[]; roleKeys: TenantRoleKey[] }) {
  const actions: { to: string; label: string; icon: LucideIcon }[] = [
    { to: "/app/leave", label: "Apply Leave", icon: CalendarDays },
  ];
  if (enabledModules.includes("payroll") && isSelfService(roleKeys)) {
    actions.push({ to: "/app/payroll", label: "View Payslip", icon: Wallet });
  }
  actions.push({ to: "/app/profile", label: "Documents", icon: FileText });

  return (
    <div className="flex flex-wrap gap-3 mb-6">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <Link
            key={action.to + action.label}
            to={action.to}
            className="flex items-center gap-2 bg-card rounded-lg px-3.5 py-2.5 shadow-sm ui-card text-sm font-medium"
          >
            <Icon size={16} strokeWidth={1.75} className="text-accent" />
            {action.label}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Part 2 category 1's "Lower sections: upcoming leave/events, recent
 * requests…" Both read off the same `requests` list `MyDayKpiRow`'s
 * pending count already derives from — no extra fetch, no new backend.
 */
function UpcomingAndRecentLeave({ requests }: { requests: LeaveRequestView[] | null }) {
  if (!requests) return null;

  const today = todayIso();
  const upcoming = requests
    .filter((r) => r.status === "approved" && r.startDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 3);
  const recent = [...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);

  if (upcoming.length === 0 && recent.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
      <section className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Upcoming Leave</h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-label-tertiary">No upcoming approved leave.</p>
        ) : (
          <div className="space-y-2">
            {upcoming.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-label-secondary">
                  {leaveTypeLabel(r.leaveType)} · {formatPeriod(r.startDate, r.endDate)}
                </span>
                <span className="font-mono text-xs text-label-tertiary shrink-0">
                  {r.daysRequested} day{r.daysRequested === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Recent Requests</h2>
        <div className="space-y-2">
          {recent.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-label-secondary truncate">
                {leaveTypeLabel(r.leaveType)} · {formatDay(r.startDate)}
              </span>
              <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[r.status]}`}>
                {STATUS_LABELS[r.status]}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function MyDaySection({ employeeId, enabledModules, roleKeys }: { employeeId: string; enabledModules: ModuleKey[]; roleKeys: TenantRoleKey[] }) {
  const { balances, requests, pendingLeaveCount } = useMyLeaveAndAttendanceSnapshot(employeeId);
  const attendance = useMyAttendance(employeeId);
  const canPunch = isSelfService(roleKeys);

  return (
    <>
      <MyDayKpiRow balances={balances} attendance={attendance} pendingLeaveCount={pendingLeaveCount} attendanceLink={canPunch ? "/app/attendance/clock" : "/app/attendance"} />
      <QuickActionsRow enabledModules={enabledModules} roleKeys={roleKeys} />
      <div className={`grid gap-4 mb-6 ${canPunch ? "xl:grid-cols-2" : ""}`}>
        {canPunch && <MyTimesheetCard employeeId={employeeId} />}
        <MyAttendanceCard data={attendance} expandTo={canPunch ? "/app/attendance/clock" : "/app/attendance"} />
      </div>
      <UpcomingAndRecentLeave requests={requests} />
    </>
  );
}

const REORG_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  validated: "Validated",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  failed: "Failed",
};

export function PortalHomePage() {
  const { identity } = useAuth();
  const theme = useTheme();
  const [commandCenter, setCommandCenter] = useState<OrganizationCommandCenterSummary | null>(null);

  // Organization Management Phase 6 — the scoped Command Center panel.
  // Mirrors Tenant Management's own Platform Health panel: loaded
  // alongside the rest of the home page, not gated behind it. Gated on
  // the exact same condition PortalLayout's own nav uses for every other
  // Organization Management surface (`employee` module enabled + at
  // least one role) — within that gate, every role the seed data grants
  // (hr_admin/line_manager/employee_self_service) already holds
  // `org_unit.view.all`, so a 403 here would mean something is actually
  // wrong, not just "this viewer shouldn't see it" — in which case hiding
  // the panel silently (rather than showing an error box) is still the
  // right call for a glance panel nobody explicitly asked to open.
  // HR Admin only: the panel composes cost centers, profit centers and reorganizations (migration 0155).
  const canSeeCommandCenter = (identity?.enabledModules.includes("employee") ?? false) && (identity?.roleKeys.includes("hr_admin") ?? false);

  useEffect(() => {
    if (!canSeeCommandCenter) return;
    api.getOrganizationCommandCenterSummary().then(setCommandCenter).catch(() => undefined);
  }, [canSeeCommandCenter]);

  if (!identity) return null;

  const { fullName, companyName, roleKeys, enabledModules } = identity;
  const homeCards = buildHomeCards(roleKeys, enabledModules);

  return (
    <div>
      {theme === "onexd" ? (
        <div className="mb-6">
          <WorkspaceHero fullName={fullName} companyName={companyName} email={identity.email} employeeId={identity.employeeId} />
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Good to see you, {fullName}</h1>
          <p className="text-sm text-label-tertiary mb-6">{companyName}</p>
        </>
      )}

      {roleKeys.includes("hr_admin") && <StarterSetupNudge />}

      {identity.employeeId && enabledModules.includes("leave") && (
        <MyDaySection employeeId={identity.employeeId} enabledModules={enabledModules} roleKeys={roleKeys} />
      )}

      {identity.employeeId && enabledModules.includes("leave") && <ActionCentre employeeId={identity.employeeId} />}

      {hasEssPortalRole(roleKeys) ? (
        <div className="mb-6">
          <EssTiles />
        </div>
      ) : homeCards.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          {homeCards.map((card) => (
            <HomeCardTile key={card.to} card={card} />
          ))}
        </div>
      )}

      {roleKeys.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm border border-amber-200">
          <h2 className="text-base font-semibold mb-1">No role assigned yet</h2>
          <p className="text-sm text-label-secondary">
            Your login exists, but you haven't been granted an HR Admin, Manager, or Employee role in
            AI HXM yet. Ask your company's HR Admin (or your Platform Admin, if this is a brand-new
            company) to grant you one.
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-card p-6 shadow-sm mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
            Your roles
          </h2>
          <div className="flex flex-wrap gap-2">
            {roleKeys.map((key) => (
              <span
                key={key}
                className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent"
              >
                {ROLE_LABELS[key] ?? key}
              </span>
            ))}
          </div>
        </div>
      )}

      {canSeeCommandCenter && commandCenter && (
        <div className="bg-card rounded-card p-4 shadow-sm mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Organization Command Center</h2>
            <span className="text-xs text-label-tertiary">
              Updated {formatTime(commandCenter.generatedAt)}
            </span>
          </div>

          <div className="flex flex-wrap gap-8 mb-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Org units</div>
              <div className="text-xl font-bold">{commandCenter.totalOrgUnits}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Positions</div>
              <div className="text-xl font-bold">{commandCenter.totalPositions}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Vacant</div>
              <div className="text-xl font-bold text-warning">{commandCenter.vacantPositions}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Filled</div>
              <div className="text-xl font-bold">{commandCenter.filledPositions}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Active assignments</div>
              <div className="text-xl font-bold">{commandCenter.activeAssignments}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Reorgs in flight</div>
              <div className="text-xl font-bold">{commandCenter.reorganizationsInFlight}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Locations</div>
              <div className="text-xl font-bold">{commandCenter.totalLocations}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Cost centers</div>
              <div className="text-xl font-bold">{commandCenter.totalCostCenters}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Profit centers</div>
              <div className="text-xl font-bold">{commandCenter.totalProfitCenters}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-label-tertiary">Data quality issues</div>
              <div className={`text-xl font-bold ${commandCenter.dataQualityIssues > 0 ? "text-warning" : ""}`}>
                {commandCenter.dataQualityIssues}
              </div>
            </div>
          </div>

          {commandCenter.integrityWarnings.some((w) => w.count > 0) && (
            <div className="mb-3">
              <div className="text-xs uppercase tracking-wide text-label-tertiary mb-1.5">Warnings</div>
              <ul className="space-y-1">
                {commandCenter.integrityWarnings
                  .filter((w) => w.count > 0)
                  .map((w) => (
                    <li key={w.code} className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-warning">
                        <span aria-hidden="true">⚠</span> {w.label}
                      </span>
                      <span className="font-semibold tabular-nums">{w.count}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {commandCenter.recentReorganizations.length === 0 ? (
            <div className="text-sm text-label-secondary">No reorganizations yet.</div>
          ) : (
            <ul className="divide-y divide-black/5">
              {commandCenter.recentReorganizations.map((c) => (
                <li key={c.id} className="py-2 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Link to="/app/organization/reorganizations" className="font-semibold text-sm hover:underline truncate">
                      {c.title}
                    </Link>
                    <div className="text-xs text-label-tertiary">
                      {REORG_STATUS_LABELS[c.status] ?? c.status} · Effective {formatDay(c.effectiveDate)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="bg-card rounded-card p-6 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Modules enabled for {companyName}
        </h2>
        {enabledModules.length === 0 ? (
          <p className="text-sm text-label-tertiary">No modules are currently licensed for this company.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {enabledModules.map((key) => (
              <span
                key={key}
                className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-black/5 text-label-secondary capitalize"
              >
                {key}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
