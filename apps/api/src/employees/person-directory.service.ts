import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  EmployeeAsOfView,
  EmploymentView,
  PersonDuplicateCandidateView,
  PersonVersionView,
  PersonView,
  UpdatePersonRequest,
} from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { sensitive } from "../crypto/sensitive-fields";
import { PersonsService } from "./persons.service";

const MODULE_KEY = "employee" as const;
const VIEW_ALL = "employee.view.all";
const MANAGE_ALL = "employee.manage.all";
const SENSITIVE_VIEW = "employee.view_sensitive.all";

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Gap Register EMP-01/02/03/05: the Person API. `persons` is the canonical
 * identity; employees' identity columns are a trigger-maintained projection
 * (0129). Reads need employee.view.all (or manage); writes need
 * employee.manage.all. CNIC and date of birth are NOT editable here - those
 * are identity-merge decisions made through the employee record / hire
 * flow, which enforce the duplicate rules.
 */
@Injectable()
export class PersonDirectoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly persons: PersonsService
  ) {}

  async get(claims: RequestClaims, id: string): Promise<PersonView> {
    const canSensitive = await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      return this.toView(claims.company_id!, row, canSensitive);
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdatePersonRequest): Promise<PersonView> {
    await this.requireManage(claims);
    const companyId = claims.company_id!;
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (patch.maritalStatus) await this.validateCatalog(client, companyId, "marital_status", patch.maritalStatus, "maritalStatus");
      if (patch.nationality) await this.validateCatalog(client, companyId, "nationality", patch.nationality, "nationality");
      if (patch.secondNationality) await this.validateCatalog(client, companyId, "nationality", patch.secondNationality, "secondNationality");

      const has = (k: keyof UpdatePersonRequest) => Object.prototype.hasOwnProperty.call(patch, k);
      const next = {
        first_name: patch.firstName ?? before.first_name,
        last_name: patch.lastName ?? before.last_name,
        middle_name: has("middleName") ? patch.middleName : before.middle_name,
        preferred_name: has("preferredName") ? patch.preferredName : before.preferred_name,
        title: has("title") ? patch.title : before.title,
        gender: has("gender") ? patch.gender : before.gender,
        nationality: has("nationality") ? patch.nationality : before.nationality,
        second_nationality: has("secondNationality") ? patch.secondNationality : before.second_nationality,
        language: has("language") ? patch.language : before.language,
        marital_status: has("maritalStatus") ? patch.maritalStatus : before.marital_status,
        marital_status_date: has("maritalStatusDate") ? patch.maritalStatusDate : day(before.marital_status_date),
        place_of_birth: has("placeOfBirth") ? patch.placeOfBirth : before.place_of_birth,
        national_id_type: patch.nationalIdType ?? before.national_id_type,
        passport_number: has("passportNumber") ? sensitive.encrypt(companyId, patch.passportNumber ?? null) : before.passport_number,
        passport_expiry: has("passportExpiry") ? patch.passportExpiry : day(before.passport_expiry),
        ntn: has("ntn") ? sensitive.encrypt(companyId, patch.ntn ?? null) : before.ntn,
      };
      const fullName = [next.first_name, next.last_name].filter(Boolean).join(" ") || before.full_name;
      if (patch.effectiveDate) await client.query("SELECT set_config('app.effective_date', $1, true)", [patch.effectiveDate]);
      const updated = await client.query(
        `UPDATE persons SET full_name = $2, first_name = $3, last_name = $4, middle_name = $5, preferred_name = $6, title = $7,
                gender = $8, nationality = $9, second_nationality = $10, language = $11, marital_status = $12,
                marital_status_date = $13::date, place_of_birth = $14, national_id_type = $15, passport_number = $16,
                passport_expiry = $17::date, ntn = $18, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          id, fullName, next.first_name, next.last_name, next.middle_name, next.preferred_name, next.title, next.gender,
          next.nationality, next.second_nationality, next.language, next.marital_status, next.marital_status_date,
          next.place_of_birth, next.national_id_type, next.passport_number, next.passport_expiry, next.ntn,
        ]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "person.update",
        target: id,
        reason: patch.reason ?? null,
        metadata: {
          before: this.toView(companyId, before, false),
          after: this.toView(companyId, updated.rows[0], false),
          effectiveDate: patch.effectiveDate ?? null,
          sensitiveFieldsChanged: [has("passportNumber") && "passportNumber", has("ntn") && "ntn"].filter(Boolean),
        },
      });
      return this.toView(companyId, updated.rows[0], true);
    });
  }

  async history(claims: RequestClaims, id: string): Promise<PersonVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const r = await client.query("SELECT * FROM person_versions WHERE person_id = $1 ORDER BY valid_from", [id]);
      return r.rows.map((v) => ({
        id: v.id, personId: v.person_id, validFrom: day(v.valid_from)!, validTo: day(v.valid_to),
        fullName: v.full_name, firstName: v.first_name, middleName: v.middle_name, lastName: v.last_name,
        preferredName: v.preferred_name, title: v.title, gender: v.gender, nationality: v.nationality,
        secondNationality: v.second_nationality, language: v.language, maritalStatus: v.marital_status,
        maritalStatusDate: day(v.marital_status_date), placeOfBirth: v.place_of_birth, nationalIdType: v.national_id_type,
        passportExpiry: day(v.passport_expiry), recordedAt: iso(v.recorded_at)!,
      }));
    });
  }

  async employments(claims: RequestClaims, id: string): Promise<EmploymentView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const r = await client.query("SELECT * FROM employments WHERE person_id = $1 ORDER BY period_number", [id]);
      return r.rows.map((e) => ({
        id: e.id, personId: e.person_id, employeeId: e.employee_id, periodNumber: e.period_number,
        startDate: day(e.start_date)!, endDate: day(e.end_date), status: e.status, employeeNumber: e.employee_number,
        rehireOfEmploymentId: e.rehire_of_employment_id,
      }));
    });
  }

  async duplicates(
    claims: RequestClaims,
    probe: { cnic?: string; dateOfBirth?: string; firstName?: string; lastName?: string }
  ): Promise<PersonDuplicateCandidateView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.persons.findDuplicateCandidates(client, claims.company_id!, probe));
  }

  /** Point-in-time view of one employee (EMP-05). Sensitive identity fields are intentionally not part of it. */
  async employeeAsOf(claims: RequestClaims, employeeId: string, date: string): Promise<EmployeeAsOfView> {
    await this.requireView(claims);
    this.assertDay(date);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM app.employee_as_of($1::date, $2::uuid)", [date, employeeId]);
      if (r.rowCount === 0) throw new NotFoundException("No record of this employee on that date");
      return this.asOfRow(r.rows[0]);
    });
  }

  /** Workforce as of a date (headcount/org reporting). Optional org-unit filter. */
  async workforceAsOf(claims: RequestClaims, date: string, orgUnitId?: string): Promise<{ asOf: string; headcount: number; employees: EmployeeAsOfView[] }> {
    await this.requireView(claims);
    this.assertDay(date);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM app.employee_as_of($1::date, NULL)
          WHERE ($2::uuid IS NULL OR org_unit_id = $2::uuid) AND employment_status IS DISTINCT FROM 'terminated'
          ORDER BY employee_number LIMIT 5000`,
        [date, orgUnitId ?? null]
      );
      return { asOf: date, headcount: r.rowCount ?? 0, employees: r.rows.map((x) => this.asOfRow(x)) };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private asOfRow(x: any): EmployeeAsOfView {
    return {
      employeeId: x.employee_id, asOf: day(x.as_of)!, personId: x.person_id, employmentId: x.employment_id,
      periodNumber: x.period_number, employeeNumber: x.employee_number, fullName: x.full_name, firstName: x.first_name,
      lastName: x.last_name, preferredName: x.preferred_name, gender: x.gender, maritalStatus: x.marital_status,
      nationality: x.nationality, orgUnitId: x.org_unit_id, positionId: x.position_id, jobId: x.job_id,
      locationId: x.location_id, managerId: x.manager_id, employeeSubgroupId: x.employee_subgroup_id,
      payrollAreaId: x.payroll_area_id, department: x.department, designation: x.designation, salaryBand: x.salary_band,
      employmentType: x.employment_type, employmentStatus: x.employment_status, statusReason: x.status_reason,
      dateOfJoining: day(x.date_of_joining), terminationDate: day(x.termination_date),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toView(companyId: string, row: any, includeSensitive: boolean): PersonView {
    const view: PersonView = {
      id: row.id, companyId: row.company_id, fullName: row.full_name, firstName: row.first_name, middleName: row.middle_name,
      lastName: row.last_name, preferredName: row.preferred_name, title: row.title, gender: row.gender,
      nationality: row.nationality, secondNationality: row.second_nationality, language: row.language,
      maritalStatus: row.marital_status, maritalStatusDate: day(row.marital_status_date), placeOfBirth: row.place_of_birth,
      nationalIdType: row.national_id_type, passportExpiry: day(row.passport_expiry),
      createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    };
    if (includeSensitive) {
      view.cnic = sensitive.decrypt(companyId, row.cnic);
      view.dateOfBirth = sensitive.readDob(companyId, row.date_of_birth_enc, row.date_of_birth);
      view.passportNumber = sensitive.decrypt(companyId, row.passport_number);
      view.ntn = sensitive.decrypt(companyId, row.ntn);
    }
    return view;
  }

  private assertDay(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new BadRequestException("date must be YYYY-MM-DD");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const r = await client.query("SELECT * FROM persons WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Person not found");
    return r.rows[0];
  }

  private async validateCatalog(client: PoolClient, companyId: string, type: string, code: string, field: string): Promise<void> {
    const any = await client.query("SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2 AND is_active LIMIT 1", [companyId, type]);
    if (any.rowCount === 0) return; // no catalog configured: free text, as before
    const hit = await client.query(
      "SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2 AND is_active AND (code = $3 OR lower(label) = lower($3))",
      [companyId, type, code]
    );
    if (hit.rowCount === 0) throw new BadRequestException(`${field} "${code}" is not an active ${type} catalog item`);
  }

  /** Returns whether the caller may see sensitive identity fields. */
  private async requireView(claims: RequestClaims): Promise<boolean> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [view, manage, sens] = await Promise.all([
      this.rbac.can(claims, VIEW_ALL),
      this.rbac.can(claims, MANAGE_ALL),
      this.rbac.can(claims, SENSITIVE_VIEW),
    ]);
    if (!view && !manage) throw new ForbiddenException("Not permitted to view person records");
    return manage || sens;
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_ALL))) throw new ForbiddenException("Not permitted to manage person records");
  }
}
