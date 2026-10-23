import type { ReportRow } from "@aihxm/shared-types";
import { isPayrollAreaInScope } from "../../../payroll/payroll-area-access";
import { prettyKey } from "../sql";
import { share, type ReportExecutor } from "./types";

const TERMINAL = new Set(["finalized", "closed", "cancelled", "reversed"]);
const ISO_DAY = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * F01 shows run progress only: counts, statuses and exception counts. It never selects a pay amount, so it is safe to
 * give to anyone who may follow payroll progress without seeing what people are paid.
 */
export const f01: ReportExecutor = async (ctx) => {
  const range = ctx.range as { from: string; to: string };
  const access = ctx.payrollAccess;
  const params: unknown[] = [ctx.companyId, range.from, range.to];
  let statusClause = "";
  if (ctx.filters.runStatus) {
    params.push(ctx.filters.runStatus);
    statusClause = `AND r.status = $${params.length}`;
  }
  const r = await ctx.client.query(
    `SELECT r.id, r.period_start, r.period_end, r.status, r.run_type, r.payroll_area_id, r.population_count, r.calculated_count, r.failed_count, r.warning_count,
            COALESCE(x.open_exceptions, 0)::int AS open_exceptions
       FROM payroll_runs r
       LEFT JOIN (SELECT payroll_run_id, COUNT(*) AS open_exceptions FROM payroll_exceptions WHERE company_id = $1::uuid AND status = 'open' GROUP BY payroll_run_id) x ON x.payroll_run_id = r.id
      WHERE r.company_id = $1::uuid AND r.is_simulation = false AND r.period_end BETWEEN $2::date AND $3::date ${statusClause}
      ORDER BY r.period_end DESC, r.created_at DESC
      LIMIT 2000`,
    params
  );
  const runs = r.rows.filter((x) => (access ? isPayrollAreaInScope(access, x.payroll_area_id) : false));
  const byStatus = new Map<string, number>();
  for (const x of runs) byStatus.set(x.status, (byStatus.get(x.status) ?? 0) + 1);
  const inProgress = runs.filter((x) => !TERMINAL.has(x.status)).length;
  const withProblems = runs.filter((x) => Number(x.failed_count) > 0 || x.open_exceptions > 0).length;
  const rows: ReportRow[] = runs.slice(0, ctx.rowLimit).map((x) => ({
    period: `${ISO_DAY(x.period_start)} to ${ISO_DAY(x.period_end)}`,
    type: prettyKey(x.run_type),
    status: prettyKey(x.status),
    employees: Number(x.population_count),
    calculated: Number(x.calculated_count),
    failed: Number(x.failed_count),
    warnings: Number(x.warning_count),
    openExceptions: x.open_exceptions,
  }));
  return {
    kpis: [
      { key: "runs", label: "Payroll runs", value: runs.length, unit: "count", note: `Periods ending ${range.from} to ${range.to}` },
      { key: "inProgress", label: "Still in progress", value: inProgress, unit: "count", note: "Not finalised, closed, cancelled or reversed" },
      { key: "problems", label: "With failures or open exceptions", value: withProblems, unit: "count" },
      { key: "share", label: "Share finalised or closed", value: share(runs.filter((x) => x.status === "finalized" || x.status === "closed").length, runs.length), unit: "percent" },
    ],
    charts: [
      {
        kind: "bar",
        title: "Payroll runs by status",
        unit: "runs",
        xKey: "label",
        series: [{ key: "runs", label: "Runs" }],
        data: [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ label: prettyKey(s), runs: n })),
      },
    ],
    columns: [
      { key: "period", label: "Pay period", type: "text" },
      { key: "type", label: "Run type", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "employees", label: "Employees", type: "number" },
      { key: "calculated", label: "Calculated", type: "number" },
      { key: "failed", label: "Failed", type: "number" },
      { key: "warnings", label: "Warnings", type: "number" },
      { key: "openExceptions", label: "Open exceptions", type: "number" },
    ],
    rows,
    totalRows: runs.length,
    truncated: runs.length > ctx.rowLimit,
    calculation: [
      "Runs are real payroll runs whose pay period ends inside the chosen range. Simulations are excluded.",
      "Only runs in payroll areas you are allowed to see are counted.",
      "In progress means any status other than finalised, closed, cancelled or reversed.",
      "This report shows counts and statuses only. It does not show any pay amounts.",
    ],
    notes: runs.length === 0 ? ["No payroll runs end in this range in the payroll areas you can see."] : r.rows.length === 2000 ? ["Only the 2,000 most recent runs were read; narrow the date range to see older ones."] : [],
  };
};
