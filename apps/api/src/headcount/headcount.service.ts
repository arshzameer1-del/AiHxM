import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { HeadcountPlanView, SaveHeadcountPlanRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const MANAGE = "headcount.manage";

/**
 * Headcount plans. HR types in how many people each department should have for a year; the screen sets that beside today's real headcount
 * and the approved requisition positions that carry the same department name. It only compares; it never hires, changes a position or a budget.
 */
@Injectable()
export class HeadcountService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims): Promise<HeadcountPlanView[]> {
    await this.require(claims);
    return this.db.withClaims(claims, async (c) => {
      const plans = (await c.query("SELECT * FROM headcount_plans WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50", [claims.company_id])).rows;
      const out: HeadcountPlanView[] = [];
      for (const p of plans) out.push(await this.build(c, p));
      return out;
    });
  }

  async create(claims: RequestClaims, input: SaveHeadcountPlanRequest): Promise<HeadcountPlanView> {
    await this.require(claims);
    const name = (input.name ?? "").trim();
    const year = (input.fiscalYear ?? "").trim();
    if (!name || name.length > 120) throw new BadRequestException("Give the plan a name");
    if (!year || year.length > 20) throw new BadRequestException("Enter the year, for example 2026-27");
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new BadRequestException("Add at least one department");
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.orgUnitId)) throw new BadRequestException("A department appears twice");
      seen.add(l.orgUnitId);
      if (!Number.isInteger(l.plannedCount) || l.plannedCount < 0 || l.plannedCount > 100000) throw new BadRequestException("Planned numbers must be whole numbers, zero or more");
    }
    return this.db.withClaims(claims, async (c) => {
      const units = await c.query("SELECT id FROM org_units WHERE company_id = $1 AND id = ANY($2)", [claims.company_id, input.lines.map((l) => l.orgUnitId)]);
      if (units.rowCount !== input.lines.length) throw new BadRequestException("One of the departments does not exist");
      const p = (await c.query("INSERT INTO headcount_plans (company_id, name, fiscal_year, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *", [claims.company_id, name, year, input.note?.trim() || null, claims.sub])).rows[0];
      for (const l of input.lines) await c.query("INSERT INTO headcount_plan_lines (plan_id, company_id, org_unit_id, planned_count, note) VALUES ($1,$2,$3,$4,$5)", [p.id, claims.company_id, l.orgUnitId, l.plannedCount, l.note?.trim() || null]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "headcount_plan.create", target: p.id, metadata: { name, lines: input.lines.length } });
      return this.build(c, p);
    });
  }

  async remove(claims: RequestClaims, id: string): Promise<void> {
    await this.require(claims);
    await this.db.withClaims(claims, async (c) => {
      const r = await c.query("DELETE FROM headcount_plans WHERE id = $1 RETURNING name", [id]);
      if (!r.rowCount) throw new NotFoundException("Plan not found");
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "headcount_plan.delete", target: id, metadata: { name: r.rows[0].name } });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async build(c: PoolClient, p: any): Promise<HeadcountPlanView> {
    const lines = (
      await c.query(
        `SELECT l.org_unit_id, u.name, l.planned_count, l.note,
                (SELECT count(*)::int FROM employees e WHERE e.org_unit_id = l.org_unit_id AND e.employment_status = 'active') AS actual,
                COALESCE((SELECT sum(r.headcount)::int FROM job_requisitions r WHERE r.company_id = l.company_id AND r.status = 'approved' AND lower(btrim(r.department)) = lower(btrim(u.name))), 0) AS openpos
           FROM headcount_plan_lines l JOIN org_units u ON u.id = l.org_unit_id WHERE l.plan_id = $1 ORDER BY u.name`,
        [p.id]
      )
    ).rows;
    const mapped = lines.map((l) => ({ orgUnitId: l.org_unit_id, orgUnitName: l.name, plannedCount: l.planned_count, actualCount: l.actual, difference: l.planned_count - l.actual, openRequisitionPositions: l.openpos, note: l.note }));
    return {
      id: p.id,
      name: p.name,
      fiscalYear: p.fiscal_year,
      note: p.note,
      createdAt: p.created_at.toISOString(),
      lines: mapped,
      totalPlanned: mapped.reduce((a, l) => a + l.plannedCount, 0),
      totalActual: mapped.reduce((a, l) => a + l.actualCount, 0),
    };
  }

  private async require(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to manage headcount plans");
  }
}
