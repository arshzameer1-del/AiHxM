import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  MySkillView,
  NineBoxView,
  SaveTalentAssessmentRequest,
  SkillGapReport,
  SkillView,
  SuccessionPositionView,
  SuccessionReadiness,
  TalentBand,
  TalentPoolView,
  JobSkillRequirementView,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const MANAGE = "talent.manage";
const BANDS: TalentBand[] = ["low", "medium", "high"];
const READINESS: SuccessionReadiness[] = ["ready_now", "one_to_two_years", "three_plus_years"];
const who = (e: { first_name: string; last_name: string }) => `${e.first_name} ${e.last_name}`.trim();
const ratingBand = (r: number): TalentBand => (r <= 2 ? "low" : r === 3 ? "medium" : "high");

/**
 * Talent. Skills and what each job needs, a nine-box of performance against potential, succession lists and talent pools.
 * Potential and readiness are judgements HR types in; performance is read from the latest released review rating unless HR sets it by hand.
 * Nothing here is calculated into a score, and nobody is moved, promoted or paid because of it.
 */
@Injectable()
export class TalentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------ skills
  async listSkills(claims: RequestClaims, all = false): Promise<SkillView[]> {
    await this.requireModule(claims);
    if (all) await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(`SELECT * FROM skills WHERE company_id = $1 ${all ? "" : "AND is_active"} ORDER BY lower(category) NULLS LAST, lower(name)`, [claims.company_id]);
      return r.rows.map(toSkill);
    });
  }

  async saveSkill(claims: RequestClaims, input: { id?: string; name: string; category?: string | null; isActive?: boolean }): Promise<SkillView[]> {
    await this.requireManage(claims);
    const name = (input.name ?? "").trim();
    const category = input.category?.trim() || null;
    if (!name || name.length > 80) throw new BadRequestException("Give the skill a name");
    if (category && category.length > 60) throw new BadRequestException("The category is too long");
    await this.db.withClaims(claims, async (c) => {
      try {
        if (input.id) {
          const r = await c.query("UPDATE skills SET name = $2, category = $3, is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING id", [input.id, name, category, input.isActive ?? null]);
          if (!r.rowCount) throw new NotFoundException("Skill not found");
        } else {
          await c.query("INSERT INTO skills (company_id, name, category) VALUES ($1,$2,$3)", [claims.company_id, name, category]);
        }
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ConflictException("A skill with this name already exists");
        throw e;
      }
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "skill.save", target: input.id ?? name, metadata: {} });
    });
    return this.listSkills(claims, true);
  }

  async listRequirements(claims: RequestClaims): Promise<JobSkillRequirementView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `SELECT q.job_id, j.title, q.skill_id, s.name, q.required_level FROM job_skill_requirements q JOIN jobs j ON j.id = q.job_id JOIN skills s ON s.id = q.skill_id
          WHERE q.company_id = $1 ORDER BY j.title, s.name`,
        [claims.company_id]
      );
      return r.rows.map((x) => ({ jobId: x.job_id, jobTitle: x.title, skillId: x.skill_id, skillName: x.name, requiredLevel: x.required_level }));
    });
  }

  /** level null removes the requirement */
  async setRequirement(claims: RequestClaims, jobId: string, skillId: string, level: number | null): Promise<JobSkillRequirementView[]> {
    await this.requireManage(claims);
    if (level !== null && (!Number.isInteger(level) || level < 1 || level > 5)) throw new BadRequestException("The level is 1 to 5");
    await this.db.withClaims(claims, async (c) => {
      if (level === null) await c.query("DELETE FROM job_skill_requirements WHERE job_id = $1 AND skill_id = $2", [jobId, skillId]);
      else {
        const ok = (await c.query("SELECT (SELECT 1 FROM jobs WHERE id = $1) AS j, (SELECT 1 FROM skills WHERE id = $2) AS s", [jobId, skillId])).rows[0];
        if (!ok.j || !ok.s) throw new NotFoundException("Job or skill not found");
        await c.query(
          "INSERT INTO job_skill_requirements (job_id, skill_id, company_id, required_level) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id, skill_id) DO UPDATE SET required_level = EXCLUDED.required_level",
          [jobId, skillId, claims.company_id, level]
        );
      }
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "skill.requirement", target: jobId, metadata: { skillId, level } });
    });
    return this.listRequirements(claims);
  }

  async mySkills(claims: RequestClaims): Promise<MySkillView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const r = await c.query(
        `SELECT s.id, s.name, s.category, es.level, es.source, es.assessed_on, q.required_level
           FROM skills s
           LEFT JOIN employee_skills es ON es.skill_id = s.id AND es.employee_id = $2
           LEFT JOIN employees e ON e.id = $2
           LEFT JOIN positions p ON p.id = e.position_id
           LEFT JOIN job_skill_requirements q ON q.skill_id = s.id AND q.job_id = p.job_id
          WHERE s.company_id = $1 AND (s.is_active OR es.level IS NOT NULL) ORDER BY lower(s.category) NULLS LAST, lower(s.name)`,
        [claims.company_id, me.id]
      );
      return r.rows.map((x) => ({ skillId: x.id, name: x.name, category: x.category, level: x.level, requiredLevel: x.required_level, source: x.source, assessedOn: x.assessed_on ? day(x.assessed_on) : null }));
    });
  }

  async setMySkill(claims: RequestClaims, skillId: string, level: number): Promise<MySkillView[]> {
    await this.requireModule(claims);
    this.checkLevel(level);
    await this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      await this.writeSkill(c, claims, me.id, skillId, level, "self", null);
    });
    return this.mySkills(claims);
  }

  async setEmployeeSkill(claims: RequestClaims, employeeId: string, skillId: string, level: number, note?: string | null): Promise<{ ok: true }> {
    await this.requireManage(claims);
    this.checkLevel(level);
    await this.db.withClaims(claims, async (c) => {
      if (!(await c.query("SELECT 1 FROM employees WHERE id = $1", [employeeId])).rowCount) throw new NotFoundException("Employee not found");
      await this.writeSkill(c, claims, employeeId, skillId, level, "hr", note?.trim() || null);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "skill.rate", target: employeeId, metadata: { skillId, level } });
    });
    return { ok: true };
  }

  async gaps(claims: RequestClaims, jobId: string): Promise<SkillGapReport> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const job = (await c.query("SELECT id, title FROM jobs WHERE id = $1", [jobId])).rows[0];
      if (!job) throw new NotFoundException("Job not found");
      const reqs = (await c.query("SELECT q.skill_id, s.name, q.required_level FROM job_skill_requirements q JOIN skills s ON s.id = q.skill_id WHERE q.job_id = $1 ORDER BY s.name", [jobId])).rows;
      const people = (
        await c.query(
          `SELECT e.id, e.first_name, e.last_name, e.employee_number FROM employees e JOIN positions p ON p.id = e.position_id
            WHERE p.job_id = $1 AND e.employment_status = 'active' ORDER BY e.first_name, e.last_name`,
          [jobId]
        )
      ).rows;
      const have = (await c.query("SELECT employee_id, skill_id, level FROM employee_skills WHERE employee_id = ANY($1)", [people.map((p) => p.id)])).rows;
      const lv = new Map(have.map((h) => [`${h.employee_id}|${h.skill_id}`, h.level as number]));
      const out = people
        .map((p) => ({
          employeeId: p.id,
          employeeName: who(p),
          employeeNumber: p.employee_number,
          gaps: reqs.filter((q) => (lv.get(`${p.id}|${q.skill_id}`) ?? 0) < q.required_level).map((q) => ({ skillId: q.skill_id, skillName: q.name, requiredLevel: q.required_level, level: lv.get(`${p.id}|${q.skill_id}`) ?? null })),
        }))
        .filter((p) => p.gaps.length > 0);
      return { jobId, jobTitle: job.title, peopleInJob: people.length, requirements: reqs.map((q) => ({ skillId: q.skill_id, skillName: q.name, requiredLevel: q.required_level })), people: out };
    });
  }

  // ------------------------------------------------------------ nine-box
  async nineBox(claims: RequestClaims): Promise<NineBoxView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `SELECT e.id, e.first_name, e.last_name, e.employee_number, a.potential, a.performance_band, a.note,
                (SELECT pr.final_rating FROM performance_reviews pr WHERE pr.employee_id = e.id AND pr.final_rating IS NOT NULL AND pr.released_at IS NOT NULL ORDER BY pr.released_at DESC LIMIT 1) AS rating
           FROM employees e LEFT JOIN talent_assessments a ON a.employee_id = e.id
          WHERE e.company_id = $1 AND e.employment_status = 'active' ORDER BY e.first_name, e.last_name`,
        [claims.company_id]
      );
      return {
        ratingBands: { low: "rating 1 to 2", medium: "rating 3", high: "rating 4 to 5" },
        people: r.rows.map((x) => ({
          employeeId: x.id,
          employeeName: who(x),
          employeeNumber: x.employee_number,
          potential: x.potential ?? null,
          performance: x.performance_band ?? (x.rating ? ratingBand(x.rating) : null),
          performanceSource: x.performance_band ? "hr" : x.rating ? "review" : null,
          finalRating: x.rating ?? null,
          note: x.note ?? null,
        })),
      };
    });
  }

  async saveAssessment(claims: RequestClaims, input: SaveTalentAssessmentRequest): Promise<NineBoxView> {
    await this.requireManage(claims);
    if (!BANDS.includes(input.potential)) throw new BadRequestException("Potential is low, medium or high");
    if (input.performanceBand && !BANDS.includes(input.performanceBand)) throw new BadRequestException("Performance is low, medium or high");
    const note = input.note?.trim() || null;
    if (note && note.length > 500) throw new BadRequestException("The note is too long");
    await this.db.withClaims(claims, async (c) => {
      if (!(await c.query("SELECT 1 FROM employees WHERE id = $1 AND employment_status = 'active'", [input.employeeId])).rowCount) throw new NotFoundException("Employee not found");
      await c.query(
        `INSERT INTO talent_assessments (employee_id, company_id, potential, performance_band, note, assessed_on, assessed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id) DO UPDATE SET potential = EXCLUDED.potential, performance_band = EXCLUDED.performance_band, note = EXCLUDED.note, assessed_on = EXCLUDED.assessed_on, assessed_by = EXCLUDED.assessed_by`,
        [input.employeeId, claims.company_id, input.potential, input.performanceBand ?? null, note, localToday(), claims.sub]
      );
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "talent.assess", target: input.employeeId, metadata: { potential: input.potential } });
    });
    return this.nineBox(claims);
  }

  async removeAssessment(claims: RequestClaims, employeeId: string): Promise<NineBoxView> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (c) => {
      await c.query("DELETE FROM talent_assessments WHERE employee_id = $1", [employeeId]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "talent.assess.remove", target: employeeId, metadata: {} });
    });
    return this.nineBox(claims);
  }

  // ------------------------------------------------------------ succession
  async succession(claims: RequestClaims): Promise<SuccessionPositionView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const pos = (
        await c.query(
          `SELECT p.id, p.position_title, u.name AS unit, (SELECT trim(e.first_name || ' ' || e.last_name) FROM employees e WHERE e.position_id = p.id AND e.employment_status = 'active' ORDER BY e.created_at LIMIT 1) AS incumbent
             FROM positions p JOIN org_units u ON u.id = p.org_unit_id WHERE p.company_id = $1 AND EXISTS (SELECT 1 FROM succession_candidates s WHERE s.position_id = p.id) ORDER BY p.position_title`,
          [claims.company_id]
        )
      ).rows;
      const cands = (
        await c.query(
          `SELECT s.position_id, s.employee_id, s.readiness, s.note, e.first_name, e.last_name FROM succession_candidates s JOIN employees e ON e.id = s.employee_id WHERE s.company_id = $1
            ORDER BY CASE s.readiness WHEN 'ready_now' THEN 0 WHEN 'one_to_two_years' THEN 1 ELSE 2 END, e.first_name`,
          [claims.company_id]
        )
      ).rows;
      return pos.map((p) => ({
        positionId: p.id,
        positionTitle: p.position_title,
        orgUnitName: p.unit,
        incumbentName: p.incumbent ?? null,
        candidates: cands.filter((x) => x.position_id === p.id).map((x) => ({ employeeId: x.employee_id, employeeName: who(x), readiness: x.readiness, note: x.note })),
      }));
    });
  }

  async addCandidate(claims: RequestClaims, positionId: string, employeeId: string, readiness: SuccessionReadiness, note?: string | null): Promise<SuccessionPositionView[]> {
    await this.requireManage(claims);
    if (!READINESS.includes(readiness)) throw new BadRequestException("Choose how ready this person is");
    await this.db.withClaims(claims, async (c) => {
      const ok = (await c.query("SELECT (SELECT 1 FROM positions WHERE id = $1) AS p, (SELECT 1 FROM employees WHERE id = $2 AND employment_status = 'active') AS e, (SELECT 1 FROM employees WHERE id = $2 AND position_id = $1) AS same", [positionId, employeeId])).rows[0];
      if (!ok.p) throw new NotFoundException("Position not found");
      if (!ok.e) throw new NotFoundException("Employee not found");
      if (ok.same) throw new BadRequestException("This person already holds the position");
      await c.query(
        "INSERT INTO succession_candidates (position_id, employee_id, company_id, readiness, note, added_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (position_id, employee_id) DO UPDATE SET readiness = EXCLUDED.readiness, note = EXCLUDED.note",
        [positionId, employeeId, claims.company_id, readiness, note?.trim() || null, claims.sub]
      );
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "succession.add", target: positionId, metadata: { employeeId, readiness } });
    });
    return this.succession(claims);
  }

  async removeCandidate(claims: RequestClaims, positionId: string, employeeId: string): Promise<SuccessionPositionView[]> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (c) => {
      await c.query("DELETE FROM succession_candidates WHERE position_id = $1 AND employee_id = $2", [positionId, employeeId]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "succession.remove", target: positionId, metadata: { employeeId } });
    });
    return this.succession(claims);
  }

  // ------------------------------------------------------------ pools
  async pools(claims: RequestClaims): Promise<TalentPoolView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const p = (await c.query("SELECT * FROM talent_pools WHERE company_id = $1 ORDER BY lower(name)", [claims.company_id])).rows;
      const m = (await c.query("SELECT m.pool_id, m.employee_id, e.first_name, e.last_name FROM talent_pool_members m JOIN employees e ON e.id = m.employee_id WHERE m.company_id = $1 ORDER BY e.first_name", [claims.company_id])).rows;
      return p.map((x) => ({ id: x.id, name: x.name, description: x.description, members: m.filter((y) => y.pool_id === x.id).map((y) => ({ employeeId: y.employee_id, employeeName: who(y) })) }));
    });
  }

  async createPool(claims: RequestClaims, name: string, description?: string | null): Promise<TalentPoolView[]> {
    await this.requireManage(claims);
    const n = (name ?? "").trim();
    if (!n || n.length > 80) throw new BadRequestException("Give the pool a name");
    await this.db.withClaims(claims, async (c) => {
      try {
        await c.query("INSERT INTO talent_pools (company_id, name, description) VALUES ($1,$2,$3)", [claims.company_id, n, description?.trim() || null]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ConflictException("A pool with this name already exists");
        throw e;
      }
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "talent_pool.create", target: n, metadata: {} });
    });
    return this.pools(claims);
  }

  async deletePool(claims: RequestClaims, id: string): Promise<TalentPoolView[]> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (c) => {
      if (!(await c.query("DELETE FROM talent_pools WHERE id = $1", [id])).rowCount) throw new NotFoundException("Pool not found");
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "talent_pool.delete", target: id, metadata: {} });
    });
    return this.pools(claims);
  }

  async setPoolMember(claims: RequestClaims, poolId: string, employeeId: string, member: boolean): Promise<TalentPoolView[]> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (c) => {
      if (member) {
        const ok = (await c.query("SELECT (SELECT 1 FROM talent_pools WHERE id = $1) AS p, (SELECT 1 FROM employees WHERE id = $2 AND employment_status = 'active') AS e", [poolId, employeeId])).rows[0];
        if (!ok.p || !ok.e) throw new NotFoundException("Pool or employee not found");
        await c.query("INSERT INTO talent_pool_members (pool_id, employee_id, company_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [poolId, employeeId, claims.company_id]);
      } else await c.query("DELETE FROM talent_pool_members WHERE pool_id = $1 AND employee_id = $2", [poolId, employeeId]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: member ? "talent_pool.add" : "talent_pool.remove", target: poolId, metadata: { employeeId } });
    });
    return this.pools(claims);
  }

  // ------------------------------------------------------------ helpers
  private checkLevel(level: number) {
    if (!Number.isInteger(level) || level < 1 || level > 5) throw new BadRequestException("The level is 1 to 5");
  }

  private async writeSkill(c: PoolClient, claims: RequestClaims, employeeId: string, skillId: string, level: number, source: "self" | "hr", note: string | null) {
    if (!(await c.query("SELECT 1 FROM skills WHERE id = $1 AND is_active", [skillId])).rowCount) throw new NotFoundException("Skill not found");
    await c.query(
      `INSERT INTO employee_skills (employee_id, skill_id, company_id, level, source, assessed_on, note) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (employee_id, skill_id) DO UPDATE SET level = EXCLUDED.level, source = EXCLUDED.source, assessed_on = EXCLUDED.assessed_on, note = EXCLUDED.note`,
      [employeeId, skillId, claims.company_id, level, source, localToday(), note]
    );
  }

  private async myEmployee(c: PoolClient, claims: RequestClaims) {
    const r = await c.query("SELECT id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub]);
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string };
  }

  private async requireModule(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims) {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to manage talent");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toSkill = (x: any): SkillView => ({ id: x.id, name: x.name, category: x.category, isActive: x.is_active });
