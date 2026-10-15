import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess } from "./payroll-area-access";
import type { PayrollDashboardRunView, PayrollDashboardView, PayrollRunStatus } from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
const ACTIVE_STATUSES: PayrollRunStatus[] = ["draft", "pre_validated", "calculating", "calculated", "validated", "pending_approval", "approved"];
const RECENT_DAYS = 90;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * PAY-25 - the payroll dashboard's data, derived entirely from what already exists: the runs, their calculation
 * partitions (progress, throughput, an estimate of the time left), the background job behind each run, open
 * exceptions, the latest payment batch and the latest journal. Nothing here is stored, so it cannot drift; it is
 * scoped to the payroll areas the caller may see.
 */
@Injectable()
export class PayrollDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService
  ) {}

  async get(claims: RequestClaims): Promise<PayrollDashboardView> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES);
    const approver = !access && (await this.rbac.can(claims, "payroll.approve.all"));
    if (!access && !approver) throw new ForbiddenException("Not permitted to view the payroll dashboard");
    const inScope = (areaId: string | null) => (access ? isPayrollAreaInScope(access, areaId) : true);

    return this.db.withClaims(claims, async (client) => {
      const counts = await client.query(
        "SELECT status, payroll_area_id, COUNT(*)::int AS n FROM payroll_runs WHERE is_simulation = false AND created_at > now() - interval '12 months' GROUP BY status, payroll_area_id"
      );
      const runsByStatus: Record<string, number> = {};
      for (const c of counts.rows) if (inScope(c.payroll_area_id)) runsByStatus[c.status] = (runsByStatus[c.status] ?? 0) + c.n;

      const runsQ = await client.query(
        `SELECT * FROM payroll_runs
          WHERE is_simulation = false AND status <> 'cancelled'
            AND (status = ANY($1::text[]) OR updated_at > now() - ($2::int * interval '1 day'))
          ORDER BY updated_at DESC LIMIT 150`,
        [ACTIVE_STATUSES, RECENT_DAYS]
      );
      const runs = runsQ.rows.filter((r) => inScope(r.payroll_area_id));
      const ids = runs.map((r) => r.id as string);

      const parts = ids.length
        ? await client.query(
            `SELECT payroll_run_id, calculation_sequence, state, COUNT(*)::int AS n, COALESCE(SUM(employee_count), 0)::int AS employees,
                    COALESCE(SUM(calculated_count + failed_count), 0)::int AS done, MIN(started_at) AS started, MAX(completed_at) AS finished
               FROM payroll_run_partitions WHERE payroll_run_id = ANY($1::uuid[]) GROUP BY payroll_run_id, calculation_sequence, state`,
            [ids]
          )
        : { rows: [] };
      const jobIds = runs.map((r) => r.calculation_job_id).filter(Boolean);
      const jobs = jobIds.length ? await client.query("SELECT id, status, dead_lettered, locked_until FROM background_jobs WHERE id = ANY($1::uuid[])", [jobIds]) : { rows: [] };
      const exc = ids.length
        ? await client.query("SELECT payroll_run_id, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE severity = 'error')::int AS errors FROM payroll_exceptions WHERE payroll_run_id = ANY($1::uuid[]) AND status = 'open' GROUP BY payroll_run_id", [ids])
        : { rows: [] };
      const pay = ids.length
        ? await client.query("SELECT DISTINCT ON (payroll_run_id) payroll_run_id, status FROM payroll_payment_batches WHERE payroll_run_id = ANY($1::uuid[]) AND status <> 'voided' ORDER BY payroll_run_id, generated_at DESC", [ids])
        : { rows: [] };
      const jnl = ids.length
        ? await client.query("SELECT DISTINCT ON (payroll_run_id) payroll_run_id, status FROM payroll_journals WHERE payroll_run_id = ANY($1::uuid[]) AND journal_kind = 'run' AND status <> 'discarded' ORDER BY payroll_run_id, generated_at DESC", [ids])
        : { rows: [] };
      const variances = ids.length
        ? await client.query("SELECT payroll_run_id, COUNT(*)::int AS n FROM payroll_reconciliations WHERE payroll_run_id = ANY($1::uuid[]) AND status = 'variance' GROUP BY payroll_run_id", [ids])
        : { rows: [] };

      const attention: PayrollDashboardView["attention"] = [];
      const views: PayrollDashboardRunView[] = runs.map((r) => {
        // the newest calculation's partitions (the run row only learns its sequence once the job has started)
        const ofRun = parts.rows.filter((p) => p.payroll_run_id === r.id);
        const latest = ofRun.reduce((m, p) => Math.max(m, Number(p.calculation_sequence)), 0);
        const mine = ofRun.filter((p) => Number(p.calculation_sequence) === latest);
        const byState: Record<string, number> = {};
        let total = 0;
        let employeesDone = 0;
        let employeesLeft = 0;
        let started: Date | null = null;
        let finished: Date | null = null;
        for (const p of mine) {
          byState[p.state] = (byState[p.state] ?? 0) + p.n;
          total += p.n;
          if (p.state === "completed") employeesDone += p.done;
          else employeesLeft += p.employees;
          if (p.started && (!started || p.started < started)) started = p.started;
          if (p.state === "completed" && p.finished && (!finished || p.finished > finished)) finished = p.finished;
        }
        const calculating = r.status === "calculating";
        const elapsedMin = started ? Math.max(((calculating ? Date.now() : (finished ?? new Date()).getTime()) - new Date(started).getTime()) / 60000, 1 / 60) : 0;
        const throughput = employeesDone > 0 && elapsedMin > 0 ? Number((employeesDone / elapsedMin).toFixed(1)) : null;
        const eta = calculating && throughput && throughput > 0 ? Math.round((employeesLeft / throughput) * 60) : null;
        const completed = byState.completed ?? 0;
        const population = Number(r.population_count);
        const progress = calculating
          ? total > 0 ? Math.round((completed / total) * 100) : 0
          : ACTIVE_STATUSES.indexOf(r.status) >= ACTIVE_STATUSES.indexOf("calculated") || !ACTIVE_STATUSES.includes(r.status) ? 100 : population > 0 ? Math.round(((Number(r.calculated_count) + Number(r.failed_count)) / population) * 100) : 0;
        const job = jobs.rows.find((j) => j.id === r.calculation_job_id);
        const e = exc.rows.find((x) => x.payroll_run_id === r.id);

        const label = `${day(r.period_start)} to ${day(r.period_end)}`;
        if (byState.failed) attention.push({ runId: r.id, kind: "failed_partitions", message: `${byState.failed} calculation partition(s) failed for the run ${label}` });
        if (job?.dead_lettered) attention.push({ runId: r.id, kind: "dead_lettered_job", message: `The calculation job for the run ${label} gave up after repeated failures` });
        if (calculating && job?.locked_until && new Date(job.locked_until).getTime() < Date.now() && job.status === "running") attention.push({ runId: r.id, kind: "stalled_job", message: `The calculation of the run ${label} has not reported for a while` });
        if (e?.errors) attention.push({ runId: r.id, kind: "open_exceptions", message: `${e.errors} open error(s) for the run ${label}` });
        const v = variances.rows.find((x) => x.payroll_run_id === r.id);
        if (v) attention.push({ runId: r.id, kind: "reconciliation_variance", message: `${v.n} unresolved reconciliation variance(s) for the run ${label}` });

        return {
          runId: r.id,
          runType: r.run_type,
          payrollAreaId: r.payroll_area_id ?? null,
          periodStart: day(r.period_start),
          periodEnd: day(r.period_end),
          status: r.status,
          calculationMode: r.calculation_mode,
          populationCount: population,
          calculatedCount: Number(r.calculated_count),
          failedCount: Number(r.failed_count),
          openExceptions: e?.n ?? 0,
          partitions: { total, byState },
          progressPercent: Math.min(100, progress),
          throughputPerMinute: throughput,
          estimatedSecondsRemaining: eta,
          jobStatus: job?.status ?? null,
          paymentStatus: pay.rows.find((x) => x.payroll_run_id === r.id)?.status ?? null,
          postingStatus: jnl.rows.find((x) => x.payroll_run_id === r.id)?.status ?? null,
          totalGross: num(r.total_gross),
          totalNet: num(r.total_net),
          totalEmployerCost: num(r.total_employer_cost),
        };
      });

      return {
        generatedAt: new Date().toISOString(),
        runsByStatus,
        active: views.filter((v) => ACTIVE_STATUSES.includes(v.status)),
        recent: views.filter((v) => !ACTIVE_STATUSES.includes(v.status)).slice(0, 20),
        attention,
      };
    });
  }
}
