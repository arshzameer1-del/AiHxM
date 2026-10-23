import type { ReportRow } from "@aihxm/shared-types";
import { Params, employeeConditions, prettyKey } from "../sql";
import { share, type ExecutorContext, type ReportExecutor } from "./types";

const scopeOf = (ctx: ExecutorContext, p: Params) =>
  employeeConditions(p, {
    alias: "e",
    companyId: ctx.companyId,
    scope: ctx.scope,
    callerEmployeeId: ctx.callerEmployeeId,
    department: ctx.filters.department,
    location: ctx.filters.location,
  });

const round2 = (n: number) => Math.round(n * 100) / 100;

export const e02: ReportExecutor = async (ctx) => {
  const range = ctx.range as { from: string; to: string };
  const p = new Params();
  const where = scopeOf(ctx, p);
  const from = `${p.add(range.from)}::date`;
  const to = `${p.add(range.to)}::date`;
  where.push("lr.status = 'approved'", `lr.start_date <= ${to}`, `lr.end_date >= ${from}`);
  if (ctx.filters.leaveType) where.push(`lr.leave_type = ${p.add(ctx.filters.leaveType)}`);
  const r = await ctx.client.query<{ code: string; name: string | null; requests: number; days: string; people: number }>(
    `SELECT lr.leave_type AS code, lt.name, COUNT(*)::int AS requests, COUNT(DISTINCT lr.employee_id)::int AS people,
            SUM(CASE WHEN lr.start_date >= ${from} AND lr.end_date <= ${to} THEN lr.days_requested
                     ELSE lr.days_requested * ((LEAST(lr.end_date, ${to}) - GREATEST(lr.start_date, ${from}) + 1)::numeric / (lr.end_date - lr.start_date + 1)) END)::text AS days
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       LEFT JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
      WHERE ${where.join(" AND ")}
      GROUP BY lr.leave_type, lt.name
      ORDER BY SUM(lr.days_requested) DESC, lr.leave_type`,
    p.values
  );
  const p2 = new Params();
  const w2 = scopeOf(ctx, p2);
  const f2 = `${p2.add(range.from)}::date`;
  const t2 = `${p2.add(range.to)}::date`;
  w2.push("lr.status = 'approved'", `lr.start_date <= ${t2}`, `lr.end_date >= ${f2}`);
  if (ctx.filters.leaveType) w2.push(`lr.leave_type = ${p2.add(ctx.filters.leaveType)}`);
  const distinct = await ctx.client.query<{ people: number }>(`SELECT COUNT(DISTINCT lr.employee_id)::int AS people FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE ${w2.join(" AND ")}`, p2.values);

  const data = r.rows.map((x) => ({ label: x.name ?? prettyKey(x.code), requests: x.requests, days: round2(Number(x.days)) }));
  const totalDays = round2(data.reduce((s, x) => s + x.days, 0));
  const totalReq = data.reduce((s, x) => s + x.requests, 0);
  const rows: ReportRow[] = data.slice(0, ctx.rowLimit).map((x) => ({ label: x.label, requests: x.requests, days: x.days, share: share(x.days, totalDays) }));
  return {
    kpis: [
      { key: "days", label: "Approved leave days", value: totalDays, unit: "days", note: `${range.from} to ${range.to}` },
      { key: "requests", label: "Approved requests", value: totalReq, unit: "count" },
      { key: "people", label: "People who took leave", value: distinct.rows[0]?.people ?? 0, unit: "count", note: "Each person counted once" },
    ],
    charts: [{ kind: "bar", title: "Approved leave days by type", unit: "days", xKey: "label", series: [{ key: "days", label: "Days" }], data: data.map((x) => ({ label: x.label, days: x.days })) }],
    columns: [
      { key: "label", label: "Leave type", type: "text" },
      { key: "requests", label: "Approved requests", type: "number" },
      { key: "days", label: "Days", type: "number" },
      { key: "share", label: "Share of days (%)", type: "percent" },
    ],
    rows,
    totalRows: data.length,
    truncated: data.length > ctx.rowLimit,
    calculation: [
      "Only approved requests count. Pending, rejected and cancelled requests are excluded.",
      "A request that sits wholly inside the range contributes its full days_requested. A request that straddles the start or end of the range contributes that figure in proportion to the calendar days inside the range, so weekends and holidays inside a long request are spread evenly.",
      "People who took leave counts each employee once, however many requests they have.",
    ],
    notes: data.length === 0 ? ["No approved leave falls in this range for the employees you can see."] : [],
  };
};

export const e03: ReportExecutor = async (ctx) => {
  const range = ctx.range as { from: string; to: string };
  const p = new Params();
  const where = scopeOf(ctx, p);
  where.push(`lr.start_date BETWEEN ${p.add(range.from)}::date AND ${p.add(range.to)}::date`);
  if (ctx.filters.leaveType) where.push(`lr.leave_type = ${p.add(ctx.filters.leaveType)}`);
  const r = await ctx.client.query<{ status: string; n: number; days: string }>(
    `SELECT lr.status, COUNT(*)::int AS n, SUM(lr.days_requested)::text AS days
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
      WHERE ${where.join(" AND ")} GROUP BY lr.status ORDER BY n DESC, lr.status`,
    p.values
  );
  const total = r.rows.reduce((s, x) => s + x.n, 0);
  const by = (s: string) => r.rows.find((x) => x.status === s)?.n ?? 0;
  const decided = by("approved") + by("rejected");
  const rows: ReportRow[] = r.rows.map((x) => ({ label: prettyKey(x.status), requests: x.n, days: round2(Number(x.days)), share: share(x.n, total) }));
  return {
    kpis: [
      { key: "total", label: "Requests", value: total, unit: "count", note: `Starting ${range.from} to ${range.to}` },
      { key: "pending", label: "Waiting for a decision", value: by("pending"), unit: "count" },
      { key: "approvalRate", label: "Approval rate", value: share(by("approved"), decided), unit: "percent", note: decided === 0 ? "Nothing approved or rejected yet" : "Approved out of approved plus rejected" },
    ],
    charts: [{ kind: "donut", title: "Leave requests by status", unit: "requests", xKey: "label", series: [{ key: "requests", label: "Requests" }], data: rows.map((x) => ({ label: x.label, requests: x.requests })) }],
    columns: [
      { key: "label", label: "Status", type: "text" },
      { key: "requests", label: "Requests", type: "number" },
      { key: "days", label: "Days requested", type: "number" },
      { key: "share", label: "Share of requests (%)", type: "percent" },
    ],
    rows,
    totalRows: rows.length,
    truncated: false,
    calculation: [
      "A request belongs to the range when its first day of leave falls inside it.",
      "Days requested is the days_requested figure on each request, summed.",
      "Approval rate is approved requests divided by approved plus rejected. Pending and cancelled requests are left out of the rate because no decision has been made on them.",
    ],
    notes: total === 0 ? ["No leave requests start in this range for the employees you can see."] : [],
  };
};
