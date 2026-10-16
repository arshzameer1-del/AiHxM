import type { OffCycleReason, PayrollRunSelection, PayrollRunType, PayrollRunView } from "@aihxm/shared-types";

export type RunSummary = { payslipCount: number; totalGrossPay: number; totalNetPay: number };
export const ZERO_RUN_SUMMARY: RunSummary = { payslipCount: 0, totalGrossPay: 0, totalNetPay: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value === null || value === undefined) return null;
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoDate(value: any): string {
  if (typeof value === "string") return value;
  return value?.toISOString ? value.toISOString().slice(0, 10) : value;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** payroll_runs row -> PayrollRunView. The single mapper for every payroll service. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToRunView(row: any, summary: RunSummary = ZERO_RUN_SUMMARY): PayrollRunView {
  const hasTotals = row.total_gross !== null && row.total_gross !== undefined;
  return {
    id: row.id,
    companyId: row.company_id,
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    status: row.status,
    payrollPeriodId: row.payroll_period_id ?? null,
    runType: row.run_type as PayrollRunType,
    offCycleReason: (row.off_cycle_reason ?? null) as OffCycleReason | null,
    targetEmployeeId: row.target_employee_id ?? null,
    workflowInstanceId: row.workflow_instance_id,
    createdByUserAccountId: row.created_by_user_account_id,
    finalizedAt: toIso(row.finalized_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
    payslipCount: summary.payslipCount,
    totalGrossPay: summary.totalGrossPay,
    totalNetPay: summary.totalNetPay,
    selection: selectionView(row.selection),
    reversedAt: toIso(row.reversed_at),
    reversedByUserAccountId: row.reversed_by_user_account_id ?? null,
    reversalReason: row.reversal_reason ?? null,
    correctiveRunId: row.corrective_run_id ?? null,
    payrollAreaId: row.payroll_area_id ?? null,
    isSimulation: row.is_simulation === true,
    currencyCode: row.currency_code ?? "PKR",
    roundingPrecision: Number(row.rounding_precision ?? 2),
    idempotencyKey: row.idempotency_key ?? null,
    ruleSnapshotId: row.rule_snapshot_id ?? null,
    calculationSequence: Number(row.calculation_sequence ?? 0),
    calculatedAt: toIso(row.calculated_at),
    calculationMode: (row.calculation_mode ?? "sync") as "sync" | "async",
    totals: hasTotals
      ? {
          gross: Number(row.total_gross),
          net: Number(row.total_net),
          incomeTax: Number(row.total_income_tax),
          employeeDeductions: Number(row.total_employee_deductions),
          employerContributions: Number(row.total_employer_contributions),
          employerCost: Number(row.total_employer_cost),
        }
      : null,
    populationCount: Number(row.population_count ?? 0),
    calculatedCount: Number(row.calculated_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    warningCount: Number(row.warning_count ?? 0),
    cancelledAt: toIso(row.cancelled_at),
    cancelReason: row.cancel_reason ?? null,
    closedAt: toIso(row.closed_at),
  };
}
void numOrNull;

/** The selection as the screens see it: the choices plus how many employees the chosen groups held. */
function selectionView(raw: unknown): PayrollRunSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { employeeIds: list(s.employeeIds), payrollAreaIds: list(s.payrollAreaIds), employeeGroupIds: list(s.employeeGroupIds), groupMemberCount: list(s.groupMemberIds).length };
}
