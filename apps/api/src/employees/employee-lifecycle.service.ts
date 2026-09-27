import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";
import { LIFECYCLE_EVENT_REASON_CATALOG } from "../hr-administration/catalog-type-registry";
import type {
  AssignActingRoleRequest,
  ChangeEmployeeLocationRequest,
  ChangeEmployeeManagerRequest,
  DemoteEmployeeRequest,
  EmployeeView,
  JobHistoryEntryView,
  JobHistoryEventType,
  LifecycleTransactionResult,
  PromoteEmployeeRequest,
  ReactivateEmployeeRequest,
  SecondEmployeeRequest,
  TerminateEmployeeRequest,
  TransferEmployeeRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEmployee(row: any): EmployeeView {
  return {
    id: row.id,
    companyId: row.company_id,
    userAccountId: row.user_account_id,
    employeeNumber: row.employee_number,
    personId: row.person_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    gender: row.gender,
    maritalStatus: row.marital_status,
    department: row.department,
    orgUnitId: row.org_unit_id,
    positionId: row.position_id ?? null,
    designation: row.designation,
    location: row.location,
    locationId: row.location_id ?? null,
    employmentType: row.employment_type,
    managerId: row.manager_id,
    employmentStatus: row.employment_status,
    dateOfJoining: toIsoDate(row.date_of_joining),
    terminationDate: toIsoDate(row.termination_date),
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
    cnic: row.cnic,
    dateOfBirth: toIsoDate(row.date_of_birth),
    salaryBand: row.salary_band,
    bankAccountNumber: row.bank_account_number,
    terminationReason: row.termination_reason,
  } as EmployeeView;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToJobHistory(row: any): JobHistoryEntryView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    eventType: row.event_type,
    effectiveDate: toIsoDate(row.effective_date) as string,
    department: row.department,
    designation: row.designation,
    salaryBand: row.salary_band,
    notes: row.notes,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    endDate: toIsoDate(row.end_date),
    reasonCode: row.reason_code,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoDate(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString ? value.toISOString().slice(0, 10) : value;
}

/**
 * Core Employee Enterprise Phase 10 (spec Section 26's Lifecycle
 * Transactions table). This is a NEW, ADDITIVE surface, not a replacement
 * of `EmployeesService.update()` + its own `autoRecordJobHistory()`
 * field-diff inference — that generic PATCH keeps working exactly as
 * before for every existing caller (real, tested behavior:
 * `employees.service.spec.ts`'s own inference test). What this class adds
 * is a second, EXPLICIT way to make the same kind of change: an HR user
 * (or a future workflow step) names the transaction up front —
 * "Promote this employee," "Second them to Finance until March 15" —
 * and the `employee_job_history` row records exactly that declared
 * intent, never a guess. A caller who wants the old inferred behavior
 * still has it via `EmployeesService.update()`; a caller who wants a
 * named, audited, single-purpose action uses one of the 9 methods below
 * instead.
 *
 * Each method: (1) the same module-entitlement + `employee.manage.all`
 * gate every other write in this domain uses, (2) a focused `UPDATE` that
 * touches ONLY the columns that transaction type actually changes — never
 * the full-row PATCH `update()` does — (3) one explicit
 * `employee_job_history` INSERT with the precise `event_type` (Phase 10's
 * `0088_core_employee_lifecycle_transactions.sql` widened the vocabulary
 * for exactly this), (4) an `AuditService.record()` call in the same
 * transaction, and (5) a fire-and-forget `employee.lifecycle.changed`
 * webhook (Section 36's domain event catalog) carrying which transaction
 * type fired — `terminate()` additionally fires the pre-existing
 * `employee.terminated` event so any integration already listening for
 * that one keeps working unchanged.
 *
 * Org-unit/location existence checks below query `org_units`/`locations`
 * directly via plain SQL rather than injecting `OrganizationModule`'s own
 * services — the same "reach across a table boundary via plain SQL"
 * precedent `organization-assignment-validator.ts` and
 * `EmployeeCostAllocationsService` already established, and for the same
 * reason: `OrganizationModule` already imports `EmployeesModule` (for
 * `LegacyReconciliationService`), so the reverse import would be
 * circular.
 */
@Injectable()
export class EmployeeLifecycleService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    // Optional with no default, same reasoning as EmployeesService's own
    // `webhooks?` — a large number of unrelated spec files may one day
    // hand-construct this service directly; NestJS's real DI container
    // always supplies a real instance in production and in every e2e test.
    private readonly webhooks?: WebhookDispatchService,
    // HR Administration v2 (2026-09-27) — same optional reasoning as
    // `webhooks?` immediately above. `execute()` no-ops the reason-code
    // validation when this is undefined, matching the pattern
    // EmployeesService.validateEmploymentType() already established.
    private readonly hrCatalog?: HrReferenceCatalogService
  ) {}

  async transfer(claims: RequestClaims, employeeId: string, input: TransferEmployeeRequest): Promise<LifecycleTransactionResult> {
    return this.execute(claims, employeeId, "transfer", input, async (client, companyId, before) => {
      const orgUnitId = input.orgUnitId ?? before.org_unit_id;
      const department = await this.resolveDepartment(client, companyId, input.orgUnitId, input.department ?? before.department);
      const locationId = input.locationId ?? before.location_id;
      const location = await this.resolveLocation(client, companyId, input.locationId, input.location ?? before.location);
      return {
        setClause: "org_unit_id = $2, department = $3, location_id = $4, location = $5",
        params: [orgUnitId, department, locationId, location],
        historyFields: { department, designation: before.designation, salaryBand: before.salary_band },
      };
    });
  }

  async promote(claims: RequestClaims, employeeId: string, input: PromoteEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (!input.designation?.trim()) throw new BadRequestException("designation is required");
    return this.execute(claims, employeeId, "promotion", input, async (_client, _companyId, before) => ({
      setClause: "designation = $2, salary_band = $3",
      params: [input.designation, input.salaryBand ?? before.salary_band],
      historyFields: { department: before.department, designation: input.designation, salaryBand: input.salaryBand ?? before.salary_band },
    }));
  }

  async demote(claims: RequestClaims, employeeId: string, input: DemoteEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (!input.designation?.trim()) throw new BadRequestException("designation is required");
    return this.execute(claims, employeeId, "demotion", input, async (_client, _companyId, before) => ({
      setClause: "designation = $2, salary_band = $3",
      params: [input.designation, input.salaryBand ?? before.salary_band],
      historyFields: { department: before.department, designation: input.designation, salaryBand: input.salaryBand ?? before.salary_band },
    }));
  }

  async second(claims: RequestClaims, employeeId: string, input: SecondEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (input.endDate < input.effectiveDate) throw new BadRequestException("endDate must not be before effectiveDate");
    return this.execute(claims, employeeId, "secondment", input, async (client, companyId, before) => {
      const orgUnitId = input.orgUnitId ?? before.org_unit_id;
      const department = await this.resolveDepartment(client, companyId, input.orgUnitId, input.department ?? before.department);
      const locationId = input.locationId ?? before.location_id;
      const location = await this.resolveLocation(client, companyId, input.locationId, input.location ?? before.location);
      const designation = input.designation ?? before.designation;
      return {
        setClause: "org_unit_id = $2, department = $3, location_id = $4, location = $5, designation = $6",
        params: [orgUnitId, department, locationId, location, designation],
        historyFields: { department, designation, salaryBand: before.salary_band },
        endDate: input.endDate,
      };
    });
  }

  async assignActingRole(claims: RequestClaims, employeeId: string, input: AssignActingRoleRequest): Promise<LifecycleTransactionResult> {
    if (!input.designation?.trim()) throw new BadRequestException("designation is required");
    if (input.endDate < input.effectiveDate) throw new BadRequestException("endDate must not be before effectiveDate");
    return this.execute(claims, employeeId, "acting", input, async (client, companyId, before) => {
      const orgUnitId = input.orgUnitId ?? before.org_unit_id;
      const department = await this.resolveDepartment(client, companyId, input.orgUnitId, input.department ?? before.department);
      return {
        setClause: "designation = $2, org_unit_id = $3, department = $4",
        params: [input.designation, orgUnitId, department],
        historyFields: { department, designation: input.designation, salaryBand: before.salary_band },
        endDate: input.endDate,
      };
    });
  }

  async changeManager(claims: RequestClaims, employeeId: string, input: ChangeEmployeeManagerRequest): Promise<LifecycleTransactionResult> {
    if (!input.managerId?.trim()) throw new BadRequestException("managerId is required");
    return this.execute(claims, employeeId, "manager_change", input, async (client, companyId, before) => {
      if (input.managerId === employeeId) {
        throw new BadRequestException("An employee cannot be their own manager");
      }
      const manager = await client.query("SELECT id, employment_status FROM employees WHERE id = $1 AND company_id = $2", [
        input.managerId,
        companyId,
      ]);
      if (manager.rowCount === 0) throw new BadRequestException("Manager not found");
      if (manager.rows[0].employment_status === "terminated") {
        throw new BadRequestException("Cannot assign a terminated employee as manager");
      }
      return {
        setClause: "manager_id = $2",
        params: [input.managerId],
        historyFields: { department: before.department, designation: before.designation, salaryBand: before.salary_band },
      };
    });
  }

  async changeLocation(claims: RequestClaims, employeeId: string, input: ChangeEmployeeLocationRequest): Promise<LifecycleTransactionResult> {
    if (!input.locationId?.trim()) throw new BadRequestException("locationId is required");
    return this.execute(claims, employeeId, "location_change", input, async (client, companyId, before) => {
      const location = await this.resolveLocation(client, companyId, input.locationId, before.location);
      return {
        setClause: "location_id = $2, location = $3",
        params: [input.locationId, location],
        historyFields: { department: before.department, designation: before.designation, salaryBand: before.salary_band },
      };
    });
  }

  async terminate(claims: RequestClaims, employeeId: string, input: TerminateEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (!input.terminationDate) throw new BadRequestException("terminationDate is required");
    const result = await this.execute(claims, employeeId, "termination", { ...input, effectiveDate: input.terminationDate }, async (
      _client,
      _companyId,
      before
    ) => ({
      setClause: "employment_status = 'terminated', termination_date = $2, termination_reason = $3",
      params: [input.terminationDate, input.terminationReason ?? null],
      historyFields: { department: before.department, designation: before.designation, salaryBand: before.salary_band },
    }));
    // Backward compatibility — every existing integration listening for
    // the pre-existing `employee.terminated` event (fired until now only
    // from EmployeesService.autoRecordJobHistory()) keeps working when
    // termination instead happens through this explicit surface.
    this.webhooks?.enqueue(result.employee.companyId, "employee.terminated", { employee: result.employee }).catch(() => undefined);
    return result;
  }

  async reactivate(claims: RequestClaims, employeeId: string, input: ReactivateEmployeeRequest): Promise<LifecycleTransactionResult> {
    return this.execute(claims, employeeId, "reactivation", input, async (_client, _companyId, before) => {
      if (before.employment_status !== "terminated") {
        throw new BadRequestException("Only a terminated employee can be reactivated");
      }
      return {
        setClause: "employment_status = 'active', termination_date = NULL, termination_reason = NULL",
        params: [],
        historyFields: { department: before.department, designation: before.designation, salaryBand: before.salary_band },
      };
    });
  }

  /**
   * Shared shape every one of the 9 public methods above follows: gate,
   * load `before`, let the caller-supplied builder decide which columns
   * change (and validate whatever is specific to that transaction type),
   * run one focused `UPDATE ... RETURNING *`, write the explicit
   * `employee_job_history` row, audit, fire the generic
   * `employee.lifecycle.changed` webhook, and return both the updated
   * employee and the history entry so a caller never has to re-fetch
   * either.
   */
  private async execute(
    claims: RequestClaims,
    employeeId: string,
    eventType: JobHistoryEventType,
    input: { effectiveDate: string; notes?: string; reasonCode?: string },
    build: (
      client: PoolClient,
      companyId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      before: any
    ) => Promise<{
      setClause: string;
      params: unknown[];
      historyFields: { department: unknown; designation: unknown; salaryBand: unknown };
      endDate?: string;
    }>
  ): Promise<LifecycleTransactionResult> {
    await this.requireModuleAndManagePermission(claims);

    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id!;
      const current = await client.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
      if (current.rowCount === 0) throw new NotFoundException("Employee not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = current.rows[0] as any;

      // HR Administration v2 — validate the supplied reason code (if any)
      // against this transaction type's mapped `lifecycle_reason:*`
      // catalog (LIFECYCLE_EVENT_REASON_CATALOG) before touching
      // `employees` at all, the same "validate before you mutate" order
      // every other check in this method already follows.
      const reasonCatalogType = LIFECYCLE_EVENT_REASON_CATALOG[eventType];
      if (input.reasonCode && reasonCatalogType) {
        await this.hrCatalog?.validateActiveCode(client, companyId, reasonCatalogType, input.reasonCode);
      }

      const built = await build(client, companyId, before);

      const updateResult = await client.query(
        `UPDATE employees SET ${built.setClause}, updated_at = now() WHERE id = $1 RETURNING *`,
        [employeeId, ...built.params]
      );
      const after = updateResult.rows[0];

      const historyResult = await client.query(
        `INSERT INTO employee_job_history
           (company_id, employee_id, event_type, effective_date, department, designation, salary_band, notes, recorded_by_user_account_id, end_date, reason_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          companyId,
          employeeId,
          eventType,
          input.effectiveDate,
          built.historyFields.department ?? null,
          built.historyFields.designation ?? null,
          built.historyFields.salaryBand ?? null,
          input.notes ?? null,
          claims.sub,
          built.endDate ?? null,
          input.reasonCode ?? null,
        ]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: `employee.lifecycle.${eventType}`,
        target: employeeId,
        metadata: { effectiveDate: input.effectiveDate, notes: input.notes ?? null, reasonCode: input.reasonCode ?? null },
      });

      const employee = rowToEmployee(after);
      const jobHistory = rowToJobHistory(historyResult.rows[0]);

      this.webhooks
        ?.enqueue(companyId, "employee.lifecycle.changed", { employee, transactionType: eventType, jobHistory })
        .catch(() => undefined);

      return { employee, jobHistory };
    });
  }

  private async resolveDepartment(
    client: PoolClient,
    companyId: string,
    orgUnitId: string | null | undefined,
    fallbackDepartment: string | null | undefined
  ): Promise<string | null> {
    if (!orgUnitId) return fallbackDepartment ?? null;
    const orgUnit = await client.query<{ name: string }>("SELECT name FROM org_units WHERE id = $1 AND company_id = $2", [
      orgUnitId,
      companyId,
    ]);
    if (orgUnit.rowCount === 0) throw new BadRequestException("Org unit not found");
    return orgUnit.rows[0].name;
  }

  private async resolveLocation(
    client: PoolClient,
    companyId: string,
    locationId: string | null | undefined,
    fallbackLocation: string | null | undefined
  ): Promise<string | null> {
    if (!locationId) return fallbackLocation ?? null;
    const location = await client.query<{ name: string }>("SELECT name FROM locations WHERE id = $1 AND company_id = $2", [
      locationId,
      companyId,
    ]);
    if (location.rowCount === 0) throw new BadRequestException("Location not found");
    return location.rows[0].name;
  }

  private async requireModuleAndManagePermission(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee records");
    }
  }
}
