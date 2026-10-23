import type { ReportRow } from "@aihxm/shared-types";
import { CURRENT_HEADCOUNT, Params, employeeConditions, prettyKey } from "../sql";
import { share, topWithOther, type ExecutorContext, type ExecutorOutput, type ReportExecutor } from "./types";

const scopeOf = (ctx: ExecutorContext, p: Params, alias = "e") =>
  employeeConditions(p, {
    alias,
    companyId: ctx.companyId,
    scope: ctx.scope,
    callerEmployeeId: ctx.callerEmployeeId,
    department: ctx.filters.department,
    location: ctx.filters.location,
    employmentType: ctx.filters.employmentType,
  });

const UNASSIGNED_NOTE = (n: number, what: string) =>
  n > 0 ? [`${n} employee${n === 1 ? " has" : "s have"} no ${what} on record. They are counted under "No ${what} set", not dropped and not spread across the others.`] : [];

/** Notes every headcount report carries when records are incomplete; missing data is surfaced, never counted as zero. */
async function dataQualityNotes(ctx: ExecutorContext, includeUndated = false): Promise<string[]> {
  const p = new Params();
  const where = scopeOf(ctx, p).join(" AND ");
  const today = p.add(ctx.today);
  const r = await ctx.client.query<{ undated: number; future: number }>(
    `SELECT COUNT(*) FILTER (WHERE e.employment_status = 'terminated' AND e.termination_date IS NULL)::int AS undated,
            COUNT(*) FILTER (WHERE e.employment_status <> 'terminated' AND e.date_of_joining > ${today}::date)::int AS future
       FROM employees e WHERE ${where}`,
    p.values
  );
  const { undated, future } = r.rows[0] ?? { undated: 0, future: 0 };
  const notes: string[] = [];
  if (future > 0) notes.push(`${future} employee${future === 1 ? " has" : "s have"} a joining date in the future and ${future === 1 ? "is" : "are"} not counted in headcount yet.`);
  if (includeUndated && undated > 0) notes.push(`${undated} terminated employee${undated === 1 ? " has" : "s have"} no termination date. ${undated === 1 ? "It is" : "They are"} left out of dated figures (joiners, leavers and the monthly trend) because the month of leaving is unknown.`);
  return notes;
}

type Group = { key: string | null; label: string; n: number };

async function headcountGrouped(ctx: ExecutorContext, kind: "department" | "location" | "employment_type"): Promise<{ groups: Group[]; total: number }> {
  const p = new Params();
  const where = scopeOf(ctx, p);
  const today = p.add(ctx.today);
  where.push(CURRENT_HEADCOUNT("e", `${today}::date`));
  let select: string;
  let join: string;
  let group: string;
  if (kind === "department") {
    select = "ou.id::text AS key, COALESCE(ou.name, 'No department set') AS label";
    join = "LEFT JOIN org_units ou ON ou.id = e.org_unit_id";
    group = "ou.id, ou.name";
  } else if (kind === "location") {
    select = "l.id::text AS key, COALESCE(l.name, 'No location set') AS label";
    join = "LEFT JOIN locations l ON l.id = e.location_id";
    group = "l.id, l.name";
  } else {
    select = "e.employment_type AS key, e.employment_type AS label";
    join = "";
    group = "e.employment_type";
  }
  const r = await ctx.client.query<{ key: string | null; label: string; n: number }>(
    `SELECT ${select}, COUNT(*)::int AS n FROM employees e ${join} WHERE ${where.join(" AND ")} GROUP BY ${group} ORDER BY n DESC, label ASC`,
    p.values
  );
  const groups = r.rows.map((g) => ({ ...g, label: kind === "employment_type" ? prettyKey(g.label) : g.label }));
  return { groups, total: groups.reduce((s, g) => s + g.n, 0) };
}

function groupedOutput(
  ctx: ExecutorContext,
  g: { groups: Group[]; total: number },
  o: { dimension: string; chartTitle: string; chartKind: "bar" | "donut"; max: number; calculation: string[]; notes: string[]; otherLabel: (n: number) => string; countNoun: string }
): ExecutorOutput {
  const rows: ReportRow[] = g.groups.slice(0, ctx.rowLimit).map((x) => ({ label: x.label, headcount: x.n, share: share(x.n, g.total) }));
  const topChart = topWithOther(g.groups, o.max, o.otherLabel);
  return {
    kpis: [
      { key: "headcount", label: "Headcount", value: g.total, unit: "count", note: `Employees working on ${ctx.today}` },
      { key: "groups", label: o.countNoun, value: g.groups.length, unit: "count" },
    ],
    charts: [{ kind: o.chartKind, title: o.chartTitle, unit: "employees", xKey: "label", series: [{ key: "headcount", label: "Employees" }], data: topChart.map((x) => ({ label: x.label, headcount: x.n })) }],
    columns: [
      { key: "label", label: o.dimension, type: "text" },
      { key: "headcount", label: "Headcount", type: "number" },
      { key: "share", label: "Share of headcount (%)", type: "percent" },
    ],
    rows,
    totalRows: g.groups.length,
    truncated: g.groups.length > ctx.rowLimit,
    calculation: o.calculation,
    notes: o.notes,
  };
}

const HEADCOUNT_DEF = "Headcount counts employees whose joining date is on or before today (company time) and whose employment status is not terminated.";

export const a03: ReportExecutor = async (ctx) => {
  const g = await headcountGrouped(ctx, "department");
  const unset = g.groups.find((x) => x.key === null)?.n ?? 0;
  return groupedOutput(ctx, g, {
    dimension: "Department",
    chartTitle: "Headcount by department",
    chartKind: "bar",
    max: 12,
    otherLabel: (n) => `Other (${n} departments)`,
    countNoun: "Departments with staff",
    calculation: [HEADCOUNT_DEF, "Each employee is counted once, under the organisation unit they are placed in.", "Share is the group's headcount divided by total headcount, to one decimal place."],
    notes: [...UNASSIGNED_NOTE(unset, "department"), ...(await dataQualityNotes(ctx))],
  });
};

export const a04: ReportExecutor = async (ctx) => {
  const g = await headcountGrouped(ctx, "location");
  const unset = g.groups.find((x) => x.key === null)?.n ?? 0;
  return groupedOutput(ctx, g, {
    dimension: "Location",
    chartTitle: "Headcount by location",
    chartKind: "bar",
    max: 12,
    otherLabel: (n) => `Other (${n} locations)`,
    countNoun: "Locations with staff",
    calculation: [HEADCOUNT_DEF, "Each employee is counted once, under their work location.", "Share is the group's headcount divided by total headcount, to one decimal place."],
    notes: [...UNASSIGNED_NOTE(unset, "location"), ...(await dataQualityNotes(ctx))],
  });
};

export const a05: ReportExecutor = async (ctx) => {
  const g = await headcountGrouped(ctx, "employment_type");
  return groupedOutput(ctx, g, {
    dimension: "Employment type",
    chartTitle: "Headcount by employment type",
    chartKind: "donut",
    max: 8,
    otherLabel: (n) => `Other (${n} types)`,
    countNoun: "Employment types in use",
    calculation: [HEADCOUNT_DEF, "Each employee is counted once, under their employment type.", "Share is the group's headcount divided by total headcount, to one decimal place."],
    notes: await dataQualityNotes(ctx),
  });
};

export const a06: ReportExecutor = async (ctx) => {
  const p = new Params();
  const where = scopeOf(ctx, p).join(" AND ");
  const r = await ctx.client.query<{ status: string; n: number }>(
    `SELECT e.employment_status AS status, COUNT(*)::int AS n FROM employees e WHERE ${where} GROUP BY e.employment_status ORDER BY n DESC, status`,
    p.values
  );
  const total = r.rows.reduce((s, x) => s + x.n, 0);
  const left = r.rows.filter((x) => x.status === "terminated").reduce((s, x) => s + x.n, 0);
  const working = total - left;
  return {
    kpis: [
      { key: "working", label: "Working", value: working, unit: "count", note: "Status is anything except terminated" },
      { key: "left", label: "Left", value: left, unit: "count", note: "Status is terminated" },
      { key: "workingShare", label: "Share still working", value: share(working, total), unit: "percent", note: total === 0 ? "No employee records" : undefined },
    ],
    charts: [
      {
        kind: "donut",
        title: "Employee records by status",
        unit: "employees",
        xKey: "label",
        series: [{ key: "employees", label: "Employees" }],
        data: r.rows.map((x) => ({ label: prettyKey(x.status), employees: x.n })),
      },
    ],
    columns: [
      { key: "label", label: "Employment status", type: "text" },
      { key: "employees", label: "Employees", type: "number" },
      { key: "share", label: "Share of all records (%)", type: "percent" },
    ],
    rows: r.rows.slice(0, ctx.rowLimit).map((x) => ({ label: prettyKey(x.status), employees: x.n, share: share(x.n, total) })),
    totalRows: r.rows.length,
    truncated: r.rows.length > ctx.rowLimit,
    calculation: [
      "Every employee record in scope is counted once, under its employment status, whatever the joining date.",
      "Working means any status other than terminated (active and probation both count as working). Left means terminated.",
    ],
    notes: [],
  };
};

export const a01: ReportExecutor = async (ctx) => {
  const p = new Params();
  const where = scopeOf(ctx, p).join(" AND ");
  const today = `${p.add(ctx.today)}::date`;
  const k = await ctx.client.query<{ headcount: number; joiners: number; leavers: number }>(
    `SELECT COUNT(*) FILTER (WHERE ${CURRENT_HEADCOUNT("e", today)})::int AS headcount,
            COUNT(*) FILTER (WHERE e.date_of_joining > ${today} - 30 AND e.date_of_joining <= ${today})::int AS joiners,
            COUNT(*) FILTER (WHERE e.termination_date > ${today} - 30 AND e.termination_date <= ${today})::int AS leavers
       FROM employees e WHERE ${where}`,
    p.values
  );
  const { headcount, joiners, leavers } = k.rows[0] ?? { headcount: 0, joiners: 0, leavers: 0 };
  const g = await headcountGrouped(ctx, "employment_type");
  return {
    kpis: [
      { key: "headcount", label: "Headcount today", value: headcount, unit: "count", note: `As of ${ctx.today}` },
      { key: "joiners", label: "Joined in the last 30 days", value: joiners, unit: "count" },
      { key: "leavers", label: "Left in the last 30 days", value: leavers, unit: "count" },
      { key: "net", label: "Net change, 30 days", value: joiners - leavers, unit: "count", note: "Joiners minus leavers" },
    ],
    charts: [
      {
        kind: "donut",
        title: "Headcount by employment type",
        unit: "employees",
        xKey: "label",
        series: [{ key: "headcount", label: "Employees" }],
        data: g.groups.map((x) => ({ label: x.label, headcount: x.n })),
      },
    ],
    columns: [
      { key: "label", label: "Employment type", type: "text" },
      { key: "headcount", label: "Headcount", type: "number" },
      { key: "share", label: "Share of headcount (%)", type: "percent" },
    ],
    rows: g.groups.map((x) => ({ label: x.label, headcount: x.n, share: share(x.n, g.total) })),
    totalRows: g.groups.length,
    truncated: false,
    calculation: [
      HEADCOUNT_DEF,
      "Joined means a joining date in the 30 days up to and including today. Left means a termination date in the same 30 days.",
      "Net change is joiners minus leavers; it is not the same as the change in headcount if people were rehired or dates were corrected.",
    ],
    notes: await dataQualityNotes(ctx, true),
  };
};

/** Month starts covered by a range, as ['2026-01-01', ...]. */
function monthStarts(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export const a07: ReportExecutor = async (ctx) => {
  const range = ctx.range as { from: string; to: string };
  const months = monthStarts(range.from, range.to);
  const p = new Params();
  const where = scopeOf(ctx, p).join(" AND ");
  const today = `${p.add(ctx.today)}::date`;
  const first = p.add(months[0]);
  const last = p.add(months[months.length - 1]);
  const r = await ctx.client.query<{ m: string; n: number }>(
    `WITH months AS (
       SELECT gs::date AS ms,
              LEAST((gs + interval '1 month - 1 day')::date, ${today}) AS point
         FROM generate_series(${first}::date, ${last}::date, interval '1 month') gs)
     SELECT to_char(months.ms, 'YYYY-MM') AS m, COUNT(e.id)::int AS n
       FROM months
       LEFT JOIN employees e
         ON ${where}
        AND e.date_of_joining <= months.point
        AND NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL)
        AND (e.termination_date IS NULL OR e.termination_date > months.point)
      GROUP BY months.ms ORDER BY months.ms`,
    p.values
  );
  const rows: ReportRow[] = r.rows.map((x, i) => ({ month: x.m, headcount: x.n, change: i === 0 ? null : x.n - r.rows[i - 1].n }));
  const startN = r.rows[0]?.n ?? null;
  const endN = r.rows[r.rows.length - 1]?.n ?? null;
  const growth = startN !== null && endN !== null && startN > 0 ? Math.round(((endN - startN) / startN) * 1000) / 10 : null;
  return {
    kpis: [
      { key: "start", label: `Headcount, ${rows[0]?.month ?? ""}`, value: startN, unit: "count" },
      { key: "end", label: `Headcount, ${rows[rows.length - 1]?.month ?? ""}`, value: endN, unit: "count" },
      { key: "change", label: "Change over the range", value: startN !== null && endN !== null ? endN - startN : null, unit: "count" },
      { key: "growth", label: "Growth over the range", value: growth, unit: "percent", note: startN === 0 ? "No headcount at the start, so no percentage" : "Change divided by starting headcount" },
    ],
    charts: [{ kind: "line", title: "Headcount at month end", unit: "employees", xKey: "month", series: [{ key: "headcount", label: "Headcount" }], data: rows }],
    columns: [
      { key: "month", label: "Month", type: "text" },
      { key: "headcount", label: "Headcount at month end", type: "number" },
      { key: "change", label: "Change from previous month", type: "number" },
    ],
    rows,
    totalRows: rows.length,
    truncated: false,
    calculation: [
      "For each month, headcount is the number of employees who had joined on or before the last day of the month and had not left by then (no termination date, or a termination date after that day).",
      "The current month is measured as of today, not the month end, because the month is not over.",
      "Employees marked terminated with no termination date are left out of every month, because the month they left is unknown.",
      "Growth is the change between the first and last month divided by the first month's headcount.",
    ],
    notes: await dataQualityNotes(ctx, true),
  };
};

export const a08: ReportExecutor = async (ctx) => {
  const range = ctx.range as { from: string; to: string };
  const months = monthStarts(range.from, range.to);
  const p = new Params();
  const where = scopeOf(ctx, p).join(" AND ");
  const from = p.add(range.from);
  const to = p.add(range.to);
  const first = p.add(months[0]);
  const last = p.add(months[months.length - 1]);
  const r = await ctx.client.query<{ m: string; joiners: number; leavers: number }>(
    `WITH months AS (SELECT gs::date AS ms FROM generate_series(${first}::date, ${last}::date, interval '1 month') gs),
          j AS (SELECT date_trunc('month', e.date_of_joining)::date AS ms, COUNT(*)::int AS n FROM employees e
                 WHERE ${where} AND e.date_of_joining BETWEEN ${from}::date AND ${to}::date GROUP BY 1),
          l AS (SELECT date_trunc('month', e.termination_date)::date AS ms, COUNT(*)::int AS n FROM employees e
                 WHERE ${where} AND e.termination_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1)
     SELECT to_char(months.ms, 'YYYY-MM') AS m, COALESCE(j.n, 0) AS joiners, COALESCE(l.n, 0) AS leavers
       FROM months LEFT JOIN j ON j.ms = months.ms LEFT JOIN l ON l.ms = months.ms ORDER BY months.ms`,
    p.values
  );
  const rows: ReportRow[] = r.rows.map((x) => ({ month: x.m, joiners: x.joiners, leavers: x.leavers, net: x.joiners - x.leavers }));
  const joiners = rows.reduce((s, x) => s + Number(x.joiners), 0);
  const leavers = rows.reduce((s, x) => s + Number(x.leavers), 0);
  return {
    kpis: [
      { key: "joiners", label: "Joiners", value: joiners, unit: "count", note: `${range.from} to ${range.to}` },
      { key: "leavers", label: "Leavers", value: leavers, unit: "count" },
      { key: "net", label: "Net change", value: joiners - leavers, unit: "count", note: "Joiners minus leavers" },
    ],
    charts: [
      {
        kind: "stackedBar",
        title: "Joiners and leavers by month",
        unit: "employees",
        xKey: "month",
        series: [
          { key: "joiners", label: "Joiners" },
          { key: "leavers", label: "Leavers" },
        ],
        data: rows,
      },
    ],
    columns: [
      { key: "month", label: "Month", type: "text" },
      { key: "joiners", label: "Joiners", type: "number" },
      { key: "leavers", label: "Leavers", type: "number" },
      { key: "net", label: "Net change", type: "number" },
    ],
    rows,
    totalRows: rows.length,
    truncated: false,
    calculation: [
      "A joiner is counted in the month of their joining date. A leaver is counted in the month of their termination date.",
      "Only dates inside the chosen range are counted, so the first and last month may be partial months.",
      "A month with nobody joining or leaving shows 0, which is a real zero. Employees with no termination date cannot be placed in a month and are not counted as leavers.",
    ],
    notes: await dataQualityNotes(ctx, true),
  };
};
