import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateEmployeeLanguageRequest, EmployeeLanguageView, UpdateEmployeeLanguageRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { requireViewOrSelf } from "./employee-self-read";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (r: any): EmployeeLanguageView => ({
  id: r.id,
  employeeId: r.employee_id,
  language: r.language,
  spokenLevel: r.spoken_level,
  writtenLevel: r.written_level,
  createdAt: new Date(r.created_at).toISOString(),
});

/**
 * BACKLOG54 - languages an employee speaks and writes. Skills and certificates are the existing qualifications.
 * HR (employee.manage.all) maintains the list; the employee can see their own.
 */
@Injectable()
export class EmployeeLanguagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeLanguageView[]> {
    await requireViewOrSelf(this.db, this.rbac, claims, employeeId, () => this.requireView(claims));
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM employee_languages WHERE employee_id = $1 ORDER BY created_at", [employeeId]);
      return r.rows.map(toView);
    });
  }

  async create(claims: RequestClaims, input: CreateEmployeeLanguageRequest): Promise<EmployeeLanguageView> {
    await this.requireManage(claims);
    const language = input.language.trim();
    if (!language) throw new BadRequestException("Enter the language");
    if (!/\p{L}/u.test(language)) throw new BadRequestException("A language name has to contain letters.");
    return this.db.withClaims(claims, async (client) => {
      const emp = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [input.employeeId, claims.company_id]);
      if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
      const r = await client
        .query(
          `INSERT INTO employee_languages (company_id, employee_id, language, spoken_level, written_level)
           VALUES ($1, $2, $3, COALESCE($4, 'conversational'), COALESCE($5, 'conversational')) RETURNING *`,
          [claims.company_id, input.employeeId, language, input.spokenLevel ?? null, input.writtenLevel ?? null]
        )
        .catch((err: { code?: string }) => {
          if (err.code === "23505") throw new ConflictException(`${language} is already on this person's list`);
          throw err;
        });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_language.create",
        target: r.rows[0].id,
        metadata: { employeeId: input.employeeId, language },
      });
      return toView(r.rows[0]);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeLanguageRequest): Promise<EmployeeLanguageView> {
    await this.requireManage(claims);
    const language = patch.language === undefined ? null : patch.language.trim();
    if (patch.language !== undefined && !language) throw new BadRequestException("Enter the language");
    if (language && !/\p{L}/u.test(language)) throw new BadRequestException("A language name has to contain letters.");
    return this.db.withClaims(claims, async (client) => {
      const r = await client
        .query(
          `UPDATE employee_languages SET language = COALESCE($2, language), spoken_level = COALESCE($3, spoken_level),
                  written_level = COALESCE($4, written_level), updated_at = now() WHERE id = $1 RETURNING *`,
          [id, language, patch.spokenLevel ?? null, patch.writtenLevel ?? null]
        )
        .catch((err: { code?: string }) => {
          if (err.code === "23505") throw new ConflictException("That language is already on this person's list");
          throw err;
        });
      if (r.rowCount === 0) throw new NotFoundException("Language not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_language.update", target: id });
      return toView(r.rows[0]);
    });
  }

  async remove(claims: RequestClaims, id: string): Promise<{ removed: true }> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM employee_languages WHERE id = $1 RETURNING employee_id, language", [id]);
      if (r.rowCount === 0) throw new NotFoundException("Language not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_language.remove",
        target: id,
        metadata: { employeeId: r.rows[0].employee_id, language: r.rows[0].language },
      });
      return { removed: true as const };
    });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage employee languages");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) throw new ForbiddenException("Not permitted to view employee languages");
  }
}
