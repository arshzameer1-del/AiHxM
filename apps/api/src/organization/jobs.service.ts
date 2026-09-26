import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import type { CreateJobRequest, JobVersionView, JobView, UpdateJobRequest } from "@aihxm/shared-types";

// Jobs are gated under the same `employee` module every other Employee
// Core / Organization Management object lives under — a reusable work
// definition, not a separately-licensed capability.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "job.manage.all";
const VIEW_PERMISSION = "job.view.all";

type JobRow = {
  id: string;
  company_id: string;
  job_code: string | null;
  title: string;
  job_family: string | null;
  job_level: string | null;
  description: string | null;
  status: string;
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToJob(row: any): JobView {
  return {
    id: row.id,
    companyId: row.company_id,
    jobCode: row.job_code,
    title: row.title,
    jobLevel: row.job_level,
    jobFamily: row.job_family,
    description: row.description,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(row: any): JobVersionView {
  return {
    id: row.id,
    jobId: row.job_id,
    jobCode: row.job_code,
    title: row.title,
    jobFamily: row.job_family,
    jobLevel: row.job_level,
    description: row.description,
    status: row.status,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

/**
 * Organization Management, Phase 2 (see the Master Engineering
 * Instruction doc's Section 10, and 0068_job_position_architecture.sql's
 * own header comment for the full design writeup): a canonical, reusable
 * work definition — "Software Engineer II" defined once, referenced by
 * as many `positions` rows as a tenant creates.
 *
 * Deliberately mirrors OrgUnitsService's own shape exactly: is the module
 * licensed (EntitlementsService) -> can the role touch this object
 * (RbacService) -> business logic (this service) -> audit write
 * (AuditService), with RLS as the tenant-isolation backstop underneath,
 * and the same stable-identity (`jobs`) + effective-dated-history
 * (`job_versions`) split kept in sync by `applyVersionAndSync()`.
 *
 * A Job is deliberately simpler than an Org Unit: no hierarchy
 * (`parent_id`), no move()/reparent concept, no cycle guard — it's a flat
 * catalog. Every mutating method here reduces to create/update/archive/
 * activate.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  async create(claims: RequestClaims, input: CreateJobRequest): Promise<JobView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      if (input.jobCode) {
        const dup = await client.query("SELECT 1 FROM jobs WHERE company_id = $1 AND job_code = $2", [
          claims.company_id,
          input.jobCode,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A job with code "${input.jobCode}" already exists`);
        }
      }

      const inserted = await client.query(
        `INSERT INTO jobs (company_id, job_code, title, job_family, job_level, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
        [
          claims.company_id,
          input.jobCode ?? null,
          input.title,
          input.jobFamily ?? null,
          input.jobLevel ?? null,
          input.description ?? null,
        ]
      );
      const job = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "job_versions",
        scope: { job_id: job.id },
        extraInsertColumns: { company_id: claims.company_id },
        data: {
          job_code: job.job_code,
          title: job.title,
          job_family: job.job_family,
          job_level: job.job_level,
          description: job.description,
          status: job.status,
        },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "job.create",
        target: job.id,
        metadata: { title: input.title, jobFamily: input.jobFamily ?? null },
      });

      return rowToJob(job);
    });
  }

  /** Every job in the tenant's catalog, flat, alphabetical. */
  async list(claims: RequestClaims): Promise<JobView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM jobs WHERE company_id = $1 ORDER BY title", [
        claims.company_id,
      ]);
      return result.rows.map(rowToJob);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<JobView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToJob(await this.mustExist(client, id)));
  }

  async update(claims: RequestClaims, id: string, patch: UpdateJobRequest): Promise<JobView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.jobCode && patch.jobCode !== before.job_code) {
        const dup = await client.query("SELECT 1 FROM jobs WHERE company_id = $1 AND job_code = $2 AND id != $3", [
          claims.company_id,
          patch.jobCode,
          id,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A job with code "${patch.jobCode}" already exists`);
        }
      }

      const next = {
        job_code: patch.jobCode ?? before.job_code,
        title: patch.title ?? before.title,
        job_family: patch.jobFamily ?? before.job_family,
        job_level: patch.jobLevel ?? before.job_level,
        description: patch.description ?? before.description,
        status: before.status,
      };

      const job = await this.applyVersionAndSync(client, claims, id, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "job.update",
        target: id,
        metadata: { before: rowToJob(before), after: rowToJob(job) },
      });

      return rowToJob(job);
    });
  }

  async archive(claims: RequestClaims, id: string): Promise<JobView> {
    return this.setStatus(claims, id, "archived");
  }

  async activate(claims: RequestClaims, id: string): Promise<JobView> {
    return this.setStatus(claims, id, "active");
  }

  private async setStatus(claims: RequestClaims, id: string, status: "active" | "archived"): Promise<JobView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === status) return rowToJob(before);

      const next = {
        job_code: before.job_code,
        title: before.title,
        job_family: before.job_family,
        job_level: before.job_level,
        description: before.description,
        status,
      };
      const job = await this.applyVersionAndSync(client, claims, id, next);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: status === "archived" ? "job.archive" : "job.activate",
        target: id,
      });

      return rowToJob(job);
    });
  }

  /** `GET /organization/jobs/:id/history` — every version this job has
   * ever had, oldest first, the same deliverable `OrgUnitsService.getHistory()`
   * already provides for org units. */
  async getHistory(claims: RequestClaims, id: string): Promise<JobVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "job_versions",
        scope: { job_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  /**
   * Shared by update()/setStatus(): supersedes the open `job_versions`
   * row via the EffectiveDatingEngine, then syncs `jobs`' own denormalized
   * current-state columns to match — exactly OrgUnitsService's own
   * `applyVersionAndSync()`.
   */
  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    data: {
      job_code: string | null;
      title: string;
      job_family: string | null;
      job_level: string | null;
      description: string | null;
      status: string;
    },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "job_versions",
      scope: { job_id: id },
      extraInsertColumns: { company_id: claims.company_id },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE jobs SET job_code = $2, title = $3, job_family = $4, job_level = $5, description = $6, status = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.job_code, data.title, data.job_family, data.job_level, data.description, data.status]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<JobRow> {
    const result = await client.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Job not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage the job catalog");
    }
  }

  /** Manage implies view, same as OrgUnitsService.requireView(). */
  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view the job catalog");
    }
  }
}
