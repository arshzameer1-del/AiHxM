import type { PoolClient } from "pg";
import type { ReportFilterValues, ReportResult, ReportScope } from "@aihxm/shared-types";
import type { PayrollAreaAccess } from "../../../payroll/payroll-area-access";

export type ExecutorContext = {
  client: PoolClient;
  companyId: string;
  scope: ReportScope;
  /** The caller's own employee record; only meaningful for team scope. */
  callerEmployeeId: string | null;
  filters: ReportFilterValues;
  range: { from: string; to: string } | null;
  /** Today's date in the company's timezone (yyyy-mm-dd). */
  today: string;
  /** Rows to return: 500 on screen, more for an export. One extra is read to learn whether the list was cut. */
  rowLimit: number;
  /** Payroll area access, resolved by the service for payroll reports only. */
  payrollAccess: PayrollAreaAccess | null;
  /** The report catalog as plain facts (id, title, category, domain, status), for the reports about the reports themselves. */
  catalog: readonly CatalogFact[];
};

export type CatalogFact = { id: string; title: string; category: string; categoryLabel: string; domain: string; status: string };

export type ExecutorOutput = Pick<ReportResult, "kpis" | "charts" | "columns" | "rows" | "totalRows" | "truncated" | "calculation" | "notes">;
export type ReportExecutor = (ctx: ExecutorContext) => Promise<ExecutorOutput>;

export const share = (n: number, total: number): number | null => (total > 0 ? Math.round((n / total) * 1000) / 10 : null);

/** Chart helper: keep the largest `max` groups and fold the rest into one "Other" bar so labels stay readable. */
export function topWithOther<T extends { label: string; n: number }>(rows: T[], max: number, otherLabel: (count: number) => string): { label: string; n: number }[] {
  if (rows.length <= max) return rows.map((r) => ({ label: r.label, n: r.n }));
  const head = rows.slice(0, max - 1).map((r) => ({ label: r.label, n: r.n }));
  const rest = rows.slice(max - 1);
  return [...head, { label: otherLabel(rest.length), n: rest.reduce((s, r) => s + r.n, 0) }];
}
