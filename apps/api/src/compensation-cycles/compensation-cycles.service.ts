import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CompCycleView, SaveCompCycleItemsRequest, SaveCompCycleRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const MANAGE = "compensation_cycle.manage";
const APPROVE = "compensation_cycle.approve";
const r2 = (n: number) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASIC_NOW = `(SELECT sum(cc.amount) FROM employee_compensation_components cc JOIN compensation_components k ON k.id = cc.component_id
                    WHERE cc.employee_id = e.id AND k.key = 'basic_salary' AND cc.effective_to IS NULL)`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Compensation planning. HR opens a cycle, loads the people with a Basic Salary on file, types proposed amounts, and submits.
 * A person with the approve permission approves it (within the budget if one was set) and then, as a separate click, applies it:
 * only then is each changed Basic Salary written, through the same routine HR uses by hand. Nothing is applied by itself,
 * employees are not told, and arrears for a past effective date are not calculated here.
 */
@Injectable()
export class CompensationCyclesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly compensation: EmployeeCompensationService
  ) {}

  async list(claims: RequestClaims): Promise<CompCycleView[]> {
    await this.require(claims, [MANAGE, APPROVE]);
    return this.db.withClaims(claims, async (c) => {
      const rows = (await c.query("SELECT * FROM comp_cycles WHERE company_id = $1 ORDER BY created_at DESC LIMIT 30", [claims.company_id])).rows;
      const out: CompCycleView[] = [];
      for (const r of rows) out.push(await this.view(c, r));
      return out;
    });
  }

  async create(claims: RequestClaims, input: SaveCompCycleRequest): Promise<CompCycleView> {
    await this.require(claims, [MANAGE]);
    const name = (input.name ?? "").trim();
    if (!name || name.length > 120) throw new BadRequestException("Give the cycle a name");
    if (!DATE.test(input.effectiveFrom ?? "")) throw new BadRequestException("Enter the date the new salaries start");
    const budget = input.budgetAmount === null || input.budgetAmount === undefined ? null : Number(input.budgetAmount);
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) throw new BadRequestException("The budget cannot be negative");
    return this.db.withClaims(claims, async (c) => {
      const r = (await c.query("INSERT INTO comp_cycles (company_id, name, effective_from, budget_amount, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *", [claims.company_id, name, input.effectiveFrom, budget, claims.sub])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.create", target: r.id, metadata: { name } });
      return this.view(c, r);
    });
  }

  /** Adds everyone with a Basic Salary on file, proposed = current. People already in the cycle are left alone. */
  async loadPeople(claims: RequestClaims, id: string): Promise<{ cycle: CompCycleView; withoutBasic: number }> {
    await this.require(claims, [MANAGE]);
    return this.db.withClaims(claims, async (c) => {
      const cyc = await this.lock(c, id, ["draft"]);
      const r = await c.query(`SELECT e.id, ${BASIC_NOW} AS basic FROM employees e WHERE e.company_id = $1 AND e.employment_status = 'active'`, [claims.company_id]);
      let without = 0;
      for (const e of r.rows) {
        if (e.basic === null) { without += 1; continue; }
        await c.query("INSERT INTO comp_cycle_items (cycle_id, company_id, employee_id, current_basic, proposed_basic) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (cycle_id, employee_id) DO NOTHING", [id, claims.company_id, e.id, e.basic]);
      }
      return { cycle: await this.view(c, cyc), withoutBasic: without };
    });
  }

  async saveItems(claims: RequestClaims, id: string, input: SaveCompCycleItemsRequest): Promise<CompCycleView> {
    await this.require(claims, [MANAGE]);
    for (const i of input.items ?? []) {
      if (!Number.isFinite(i.proposedBasic) || i.proposedBasic < 0) throw new BadRequestException("A proposed salary cannot be negative");
      if (i.reason && i.reason.length > 300) throw new BadRequestException("A reason can be up to 300 characters");
    }
    return this.db.withClaims(claims, async (c) => {
      const cyc = await this.lock(c, id, ["draft"]);
      for (const i of input.items ?? []) {
        const r = await c.query("UPDATE comp_cycle_items SET proposed_basic = $3, reason = $4 WHERE cycle_id = $1 AND employee_id = $2", [id, i.employeeId, r2(i.proposedBasic), i.reason?.trim() || null]);
        if (!r.rowCount) throw new NotFoundException("One of the people is not in this cycle");
      }
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.items", target: id, metadata: { count: input.items?.length ?? 0 } });
      return this.view(c, cyc);
    });
  }

  async submit(claims: RequestClaims, id: string): Promise<CompCycleView> {
    await this.require(claims, [MANAGE]);
    return this.db.withClaims(claims, async (c) => {
      await this.lock(c, id, ["draft"]);
      const changed = (await c.query("SELECT count(*)::int AS n FROM comp_cycle_items WHERE cycle_id = $1 AND proposed_basic <> current_basic", [id])).rows[0].n as number;
      if (changed === 0) throw new BadRequestException("No salary has been changed yet");
      const r = (await c.query("UPDATE comp_cycles SET status = 'submitted', submitted_by = $2 WHERE id = $1 RETURNING *", [id, claims.sub])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.submit", target: id, metadata: { changed } });
      return this.view(c, r);
    });
  }

  async withdraw(claims: RequestClaims, id: string): Promise<CompCycleView> {
    await this.require(claims, [MANAGE]);
    return this.db.withClaims(claims, async (c) => {
      await this.lock(c, id, ["submitted"]);
      const r = (await c.query("UPDATE comp_cycles SET status = 'draft', submitted_by = NULL WHERE id = $1 RETURNING *", [id])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.withdraw", target: id, metadata: {} });
      return this.view(c, r);
    });
  }

  async approve(claims: RequestClaims, id: string, samePersonConfirmed = false): Promise<CompCycleView> {
    await this.require(claims, [APPROVE]);
    return this.db.withClaims(claims, async (c) => {
      const cyc = await this.lock(c, id, ["submitted"]);
      if (cyc.submitted_by === claims.sub && !samePersonConfirmed) {
        throw new BadRequestException("You submitted this cycle yourself. Confirm that you are both preparing and approving it, or ask someone else to approve.");
      }
      const t = (await c.query("SELECT COALESCE(sum(proposed_basic - current_basic), 0) AS inc FROM comp_cycle_items WHERE cycle_id = $1", [id])).rows[0];
      if (cyc.budget_amount !== null && Number(t.inc) > Number(cyc.budget_amount)) {
        throw new ConflictException(`The monthly increase of ${r2(Number(t.inc))} is more than the budget of ${Number(cyc.budget_amount)}. Reduce the proposals or raise the budget.`);
      }
      const r = (await c.query("UPDATE comp_cycles SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *", [id, claims.sub])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.approve", target: id, metadata: { increase: r2(Number(t.inc)), samePerson: cyc.submitted_by === claims.sub } });
      return this.view(c, r);
    });
  }

  /** Writes each changed Basic Salary. Refuses if anyone's current Basic Salary is no longer the one the cycle started from. */
  async apply(claims: RequestClaims, id: string): Promise<CompCycleView> {
    await this.require(claims, [APPROVE]);
    return this.db.withClaims(claims, async (c) => {
      const cyc = await this.lock(c, id, ["approved"]);
      const items = (await c.query(`SELECT i.*, e.first_name, e.last_name, ${BASIC_NOW} AS basic_now FROM comp_cycle_items i JOIN employees e ON e.id = i.employee_id WHERE i.cycle_id = $1 AND i.proposed_basic <> i.current_basic`, [id])).rows;
      const stale = items.filter((i) => i.basic_now === null || Math.abs(Number(i.basic_now) - Number(i.current_basic)) > 0.005);
      if (stale.length) {
        throw new ConflictException(`Basic Salary has changed since this cycle started for: ${stale.map((s) => `${s.first_name} ${s.last_name}`.trim()).slice(0, 5).join(", ")}${stale.length > 5 ? " and others" : ""}. Cancel this cycle and start a new one.`);
      }
      for (const i of items) {
        await this.compensation.setCompensationWithinTransaction(c, claims, { employeeId: i.employee_id, monthlySalary: Number(i.proposed_basic), effectiveFrom: day(cyc.effective_from) });
      }
      const r = (await c.query("UPDATE comp_cycles SET status = 'applied', applied_at = now() WHERE id = $1 RETURNING *", [id])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.apply", target: id, metadata: { changed: items.length } });
      return this.view(c, r);
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<CompCycleView> {
    await this.require(claims, [MANAGE, APPROVE]);
    return this.db.withClaims(claims, async (c) => {
      await this.lock(c, id, ["draft", "submitted", "approved"]);
      const r = (await c.query("UPDATE comp_cycles SET status = 'cancelled' WHERE id = $1 RETURNING *", [id])).rows[0];
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "comp_cycle.cancel", target: id, metadata: {} });
      return this.view(c, r);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async view(c: PoolClient, cyc: any): Promise<CompCycleView> {
    const items = (
      await c.query(
        `SELECT i.*, e.first_name, e.last_name, e.employee_number FROM comp_cycle_items i JOIN employees e ON e.id = i.employee_id WHERE i.cycle_id = $1 ORDER BY e.first_name, e.last_name`,
        [cyc.id]
      )
    ).rows;
    const names = (await c.query("SELECT u.id, COALESCE(NULLIF(trim(e.first_name || ' ' || e.last_name), ''), u.email) AS n FROM user_accounts u LEFT JOIN employees e ON e.user_account_id = u.id WHERE u.id = ANY($1)", [[cyc.submitted_by, cyc.approved_by].filter(Boolean)])).rows;
    const nm = (id: string | null) => (id ? names.find((n) => n.id === id)?.n ?? null : null);
    const mapped = items.map((i) => ({
      employeeId: i.employee_id,
      employeeName: `${i.first_name} ${i.last_name}`.trim(),
      employeeNumber: i.employee_number,
      currentBasic: Number(i.current_basic),
      proposedBasic: Number(i.proposed_basic),
      changePercent: Number(i.current_basic) > 0 ? r2(((Number(i.proposed_basic) - Number(i.current_basic)) / Number(i.current_basic)) * 100) : 0,
      reason: i.reason,
    }));
    return {
      id: cyc.id,
      name: cyc.name,
      effectiveFrom: day(cyc.effective_from),
      budgetAmount: cyc.budget_amount === null ? null : Number(cyc.budget_amount),
      status: cyc.status,
      totalMonthlyIncrease: r2(mapped.reduce((a, i) => a + (i.proposedBasic - i.currentBasic), 0)),
      changedCount: mapped.filter((i) => i.proposedBasic !== i.currentBasic).length,
      items: mapped,
      submittedByName: nm(cyc.submitted_by),
      approvedByName: nm(cyc.approved_by),
      approvedAt: cyc.approved_at ? cyc.approved_at.toISOString() : null,
      appliedAt: cyc.applied_at ? cyc.applied_at.toISOString() : null,
      createdAt: cyc.created_at.toISOString(),
    };
  }

  private async lock(c: PoolClient, id: string, allowed: string[]) {
    const cyc = (await c.query("SELECT * FROM comp_cycles WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!cyc) throw new NotFoundException("Cycle not found");
    if (!allowed.includes(cyc.status)) throw new ConflictException(`This cycle is ${cyc.status}; that step is not available now`);
    return cyc;
  }

  private async require(claims: RequestClaims, perms: string[]) {
    if (!(await this.entitlements.isModuleEnabled(claims, "payroll"))) throw new NotFoundException();
    for (const p of perms) if (await this.rbac.can(claims, p)) return;
    throw new ForbiddenException("Not permitted");
  }
}
