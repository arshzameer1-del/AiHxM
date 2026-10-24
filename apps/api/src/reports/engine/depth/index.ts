import type { ReportSectionSpec } from "../report-spec";
import { ESS_AUDIT_DEPTH } from "./ess-audit";
import { PLATFORM_GOVERNANCE_DEPTH } from "./platform-governance";
import { PERFORMANCE_DEPTH } from "./performance";
import { PAYROLL_DEPTH } from "./payroll";
import { TALENT_DEPTH } from "./talent";
import { TIME_LEAVE_DEPTH } from "./time-leave";
import { WORKFLOW_DEPTH } from "./workflow";
import { WORKFORCE_DEPTH } from "./workforce";

/**
 * The extra tables ("sections") under each report, by report id: breakdowns, trends and the individual records behind the
 * figures. Kept apart from the reports themselves so a report's own query stays short and each domain's depth can be
 * reviewed in one file. report-depth-coverage.spec.ts fails if an available report has none.
 */
export const DEPTH_SECTIONS: Readonly<Record<string, readonly ReportSectionSpec[]>> = {
  ...WORKFORCE_DEPTH,
  ...TALENT_DEPTH,
  ...TIME_LEAVE_DEPTH,
  ...PAYROLL_DEPTH,
  ...PERFORMANCE_DEPTH,
  ...WORKFLOW_DEPTH,
  ...ESS_AUDIT_DEPTH,
  ...PLATFORM_GOVERNANCE_DEPTH,
};

/** Reports that read only the catalog held in code: their extra tables may read nothing but values passed to unnest(). */
export const STATIC_DEPTH_REPORTS: ReadonlySet<string> = new Set(["O12"]);
