import type { ReportExecutor } from "./types";
import { runSections, type ReportMeta } from "../report-spec";
import { DEPTH_SECTIONS, STATIC_DEPTH_REPORTS } from "../depth";
import type { DefaultRange } from "../filters";
import { a01, a03, a04, a05, a06, a07, a08 } from "./people";
import { e02, e03 } from "./leave";
import { f01 } from "./payroll";
import * as workforcePeople from "./workforce-people";
import * as masterData from "./master-data";
import * as workforcePlanning from "./workforce-planning";
import * as recruitment from "./recruitment";
import * as attendance from "./attendance";
import * as leaveReports from "./leave-reports";
import * as payrollReports from "./payroll-reports";
import * as payrollStatements from "./payroll-statements";
import * as performance from "./performance";
import * as workflow from "./workflow";
import * as essService from "./ess-service";
import * as auditSecurity from "./audit-security";
import * as learning from "./learning";
import * as governance from "./governance";
import * as platformOps from "./platform-ops";

/**
 * Every report with a query behind it. Two kinds:
 *   - declarative reports (sqlReport / groupedReport / listReport), exported by id from the domain files below. They carry
 *     their own metadata (description, filters, charts, default range), which the catalog adopts, so a report cannot be
 *     described one way and behave another;
 *   - the first ten hand-written executors, whose metadata lives in the catalog.
 * report-catalog.spec.ts keeps "available" and "has an executor" in step in both directions.
 */
type Declared = { run: ReportExecutor; meta: ReportMeta };
const MODULES: Array<Record<string, unknown>> = [workforcePeople, masterData, workforcePlanning, recruitment, attendance, leaveReports, payrollReports, payrollStatements, performance, workflow, essService, auditSecurity, learning, governance, platformOps];

const declared = new Map<string, Declared>();
for (const mod of MODULES) {
  for (const [key, value] of Object.entries(mod)) {
    if (!/^([A-O](0[1-9]|1[0-5])|B(1[6-9]|20)|F(1[1-9]|2[0-9]|30))$/.test(key)) continue;
    if (declared.has(key)) throw new Error(`Report ${key} is defined twice`);
    declared.set(key, value as Declared);
  }
}

const LEGACY: Record<string, ReportExecutor> = { A01: a01, A03: a03, A04: a04, A05: a05, A06: a06, A07: a07, A08: a08, E02: e02, E03: e03, F01: f01 };
const LEGACY_RANGES: Record<string, DefaultRange | null> = { A07: "last12Months", A08: "last12Months", E02: "yearToDate", E03: "yearToDate", F01: "last12Months" };

/**
 * Adds the extra tables defined in engine/depth to a report. They run after the report's own query, under the same scope
 * rules, and are left out of the earlier period of a comparison (which only needs the figures).
 */
function withDepth(id: string, run: ReportExecutor): ReportExecutor {
  const extra = DEPTH_SECTIONS[id];
  if (!extra || extra.length === 0) return run;
  return async (ctx) => {
    const out = await run(ctx);
    if (ctx.skipSections) return out;
    const more = await runSections(extra, ctx, STATIC_DEPTH_REPORTS.has(id));
    return { ...out, sections: [...(out.sections ?? []), ...more] };
  };
}

export const EXECUTORS: Readonly<Record<string, ReportExecutor>> = Object.fromEntries(
  Object.entries({
    ...LEGACY,
    ...Object.fromEntries([...declared].map(([id, d]) => [id, d.run])),
  }).map(([id, run]) => [id, withDepth(id, run)])
);

/** Metadata declared by the report itself (absent for the ten hand-written ones). */
export const REPORT_META: Readonly<Record<string, ReportMeta>> = Object.fromEntries([...declared].map(([id, d]) => [id, d.meta]));

/** Where each report's date range starts when the caller picks none. */
export const DEFAULT_RANGES: Readonly<Record<string, DefaultRange | null>> = {
  ...LEGACY_RANGES,
  ...Object.fromEntries([...declared].map(([id, d]) => [id, d.meta.defaultRange])),
};
