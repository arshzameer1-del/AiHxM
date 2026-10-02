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
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { OrgOccupancyService } from "../organization/occupancy/org-occupancy.service";
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
// Cross-module integration audit (2026-10-01), gap #3/#7 — same write-side
// Data Scope alternative `EmployeesService.update()` now enforces
// (0111_write_scope_data_scope_enforcement.sql), applied here to the
// shared `execute()` helper so all 9 lifecycle transactions (transfer/
// promote/demote/second/act/changeManager/changeLocation/terminate/
// reactivate) get it in one place.
const SCOPED_MANAGE_PERMISSION_BASE = "employee.manage";

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
 *
 * ORGANIZATION MANAGEMENT SYNC (cross-module integration audit Item 2,
 * 2026-10-01). Until this change every method here only patched
 * `employees` columns, so `positions`/`employee_org_assignments`/
 * `org_relationships` silently drifted from what the employee record said.
 * Each transaction now also writes the Organization Management side, on
 * the SAME transaction client, through `OrgOccupancyService` (a slim module
 * below both EmployeesModule and OrganizationModule — see its own class doc
 * comment for why that, not an event or `forwardRef()`):
 *   - transfer: replaces the open `primary` assignment with one in the new
 *     org unit/location; with `positionId`, moves the employee into that
 *     seat (old seat vacated). Without one, a seat that belongs to the OLD
 *     org unit is vacated — a position belongs to exactly one org unit, so
 *     an employee transferred out of it cannot keep occupying it.
 *   - promote/demote: with `positionId`, the same seat move (and, if the
 *     new seat sits in another org unit, the org unit/department follow it).
 *     Designation-only promotions touch no org-side table.
 *   - second/act: open a `secondment`/`acting` assignment slot (the primary
 *     stays at home), plus a `secondment`/`acting` org_relationships row
 *     when a `managerEmployeeId` is given (both need a counterpart
 *     employee; `secondment` became a relationship type in 0103 — rows
 *     written before it carry `temporary`).
 *   - changeManager: supersedes the open `direct` org_relationships row.
 *   - changeLocation: replaces the open primary with the new location.
 *   - terminate: vacates the employee's seat (never abolishes it — the
 *     position becomes vacant again, PositionsService.unassignEmployee()'s
 *     contract) and ends every open assignment slot.
 *   - reactivate: deliberately NO org-side writes — the old seat may well
 *     have been refilled; HR re-assigns explicitly (Position Workbench or a
 *     transfer), the same posture EmployeesService.update()'s own
 *     reactivation path has always had.
 * Any org-side failure (seat no longer vacant, reporting cycle, ...) throws
 * inside the transaction and rolls back the employee update, the job
 * history row and the audit row with it.
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
    private readonly hrCatalog?: HrReferenceCatalogService,
    // Item 2 — default-instantiated and appended last, the same convention
    // HiringProcessService uses, so positional spec constructions keep
    // working; Nest's DI supplies the real OrgOccupancyModule instance.
    private readonly occupancy: OrgOccupancyService = new OrgOccupancyService(audit, new EffectiveDatingEngine(), webhooks)
  ) {}

  async transfer(claims: RequestClaims, employeeId: string, input: TransferEmployeeRequest): Promise<LifecycleTransactionResult> {
    return this.execute(claims, employeeId, "transfer", input, async (client, companyId, before) => {
      const position = input.positionId ? await this.loadTargetPosition(client, companyId, input.positionId, input.orgUnitId) : null;
      const newOrgUnitId: string | undefined = input.orgUnitId ?? position?.org_unit_id;
      const orgUnitId = newOrgUnitId ?? before.org_unit_id;
      const department = await this.resolveDepartment(client, companyId, newOrgUnitId, input.department ?? before.department);
      const locationId = input.locationId ?? before.location_id;
      const location = await this.resolveLocation(client, companyId, input.locationId, input.location ?? before.location);
      return {
        setClause: "org_unit_id = $2, department = $3, location_id = $4, location = $5",
        params: [orgUnitId, department, locationId, location],
        historyFields: { department, designation: before.designation, salaryBand: before.salary_band },
        orgSync: async (source) => {
          if (position) {
            await this.occupancy.assignPositionWithinTransaction(client, claims, {
              positionId: position.id,
              employeeId,
              effectiveFrom: input.effectiveDate,
              expectedOrgUnitId: orgUnitId,
              source,
            });
          } else if (before.position_id && orgUnitId !== before.org_unit_id) {
            await this.vacateSeatOutsideOrgUnit(client, claims, companyId, before.position_id, orgUnitId, input.effectiveDate, source);
          }
          await this.syncPrimaryAssignment(client, claims, employeeId, { orgUnitId, locationId, effectiveFrom: input.effectiveDate, source });
        },
      };
    });
  }

  async promote(claims: RequestClaims, employeeId: string, input: PromoteEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (!input.designation?.trim()) throw new BadRequestException("designation is required");
    return this.execute(claims, employeeId, "promotion", input, (client, companyId, before) =>
      this.buildDesignationChange(client, claims, companyId, employeeId, before, input)
    );
  }

  async demote(claims: RequestClaims, employeeId: string, input: DemoteEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (!input.designation?.trim()) throw new BadRequestException("designation is required");
    return this.execute(claims, employeeId, "demotion", input, (client, companyId, before) =>
      this.buildDesignationChange(client, claims, companyId, employeeId, before, input)
    );
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
        // The typed record of the posting: a `secondment` slot alongside
        // (not replacing) the home `primary` assignment. `endDate` stays a
        // descriptive fact on the history row — no scheduler ends the slot
        // automatically yet (Section 26's own scope note above).
        orgSync: async (source) => {
          if (orgUnitId) {
            await this.occupancy.openAssignmentWithinTransaction(client, claims, {
              employeeId,
              assignmentType: "secondment",
              orgUnitId,
              locationId,
              effectiveFrom: input.effectiveDate,
              source,
            });
          }
          if (input.managerEmployeeId) {
            await this.occupancy.createRelationshipWithinTransaction(client, claims, {
              employeeId,
              managerEmployeeId: input.managerEmployeeId,
              relationshipType: "secondment",
              effectiveFrom: input.effectiveDate,
              source,
            });
          }
        },
      };
    });
  }

  async assignActingRole(claims: RequestClaims, employeeId: string, input: AssignActingRoleRequest): Promise<LifecycleTransactionResult> {
    if (!input.designation?.trim()) throw new BadRequestException("designation is required");
    if (input.endDate < input.effectiveDate) throw new BadRequestException("endDate must not be before effectiveDate");
    return this.execute(claims, employeeId, "acting", input, async (client, companyId, before) => {
      const position = input.positionId ? await this.loadTargetPosition(client, companyId, input.positionId, input.orgUnitId, { requireVacant: false }) : null;
      const newOrgUnitId: string | undefined = input.orgUnitId ?? position?.org_unit_id;
      const orgUnitId = newOrgUnitId ?? before.org_unit_id;
      const department = await this.resolveDepartment(client, companyId, newOrgUnitId, input.department ?? before.department);
      return {
        setClause: "designation = $2, org_unit_id = $3, department = $4",
        params: [input.designation, orgUnitId, department],
        historyFields: { department, designation: input.designation, salaryBand: before.salary_band },
        endDate: input.endDate,
        orgSync: async (source) => {
          if (orgUnitId) {
            await this.occupancy.openAssignmentWithinTransaction(client, claims, {
              employeeId,
              assignmentType: "acting",
              orgUnitId,
              // Recorded, not occupied — see AssignActingRoleDto.positionId.
              positionId: position?.id ?? null,
              locationId: before.location_id,
              effectiveFrom: input.effectiveDate,
              source,
            });
          }
          if (input.managerEmployeeId) {
            await this.occupancy.createRelationshipWithinTransaction(client, claims, {
              employeeId,
              managerEmployeeId: input.managerEmployeeId,
              relationshipType: "acting",
              effectiveFrom: input.effectiveDate,
              source,
            });
          }
        },
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
        // PING-PONG GUARD. Two writers now exist for the same fact, in
        // opposite directions: OrgRelationshipsService writes
        // org_relationships -> employees.manager_id, and this method writes
        // employees.manager_id -> org_relationships. Neither is reactive
        // (no trigger, no listener, no call back into the other service's
        // public entry point), and this path passes
        // `OrgOccupancyService.syncDirectManagerFromEmployeeWithinTransaction()`
        // (shared with EmployeesService.update()'s generic PATCH path),
        // which never writes `employees.manager_id` itself — the UPDATE
        // above (setClause) is the ONE writer of that column in this
        // transaction. Keep it that way: if either side is ever made
        // reactive (e.g. an `org.relationship.changed` listener that calls
        // back into this service), it must check the `source` it was
        // invoked with and skip `employee_lifecycle:*` originated changes,
        // or the two will re-trigger each other indefinitely.
        orgSync: async (source) => {
          await this.occupancy.syncDirectManagerFromEmployeeWithinTransaction(client, claims, {
            employeeId,
            managerEmployeeId: input.managerId,
            effectiveFrom: input.effectiveDate,
            source,
          });
        },
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
        orgSync: async (source) => {
          if (before.org_unit_id) {
            await this.syncPrimaryAssignment(client, claims, employeeId, {
              orgUnitId: before.org_unit_id,
              locationId: input.locationId,
              effectiveFrom: input.effectiveDate,
              source,
            });
          }
        },
      };
    });
  }

  async terminate(claims: RequestClaims, employeeId: string, input: TerminateEmployeeRequest): Promise<LifecycleTransactionResult> {
    if (!input.terminationDate) throw new BadRequestException("terminationDate is required");
    const result = await this.execute(claims, employeeId, "termination", { ...input, effectiveDate: input.terminationDate }, async (
      client,
      _companyId,
      before
    ) => ({
      setClause: "employment_status = 'terminated', termination_date = $2, termination_reason = $3",
      params: [input.terminationDate, input.terminationReason ?? null],
      historyFields: { department: before.department, designation: before.designation, salaryBand: before.salary_band },
      // Vacate (never abolish) the seat and end every open assignment
      // slot. Reporting relationships are left as-is: a terminated
      // manager's reports need an explicit HR decision, not a silent
      // re-parenting.
      orgSync: async (source) => {
        await this.occupancy.vacateEmployeePositionWithinTransaction(client, claims, {
          employeeId,
          effectiveFrom: input.terminationDate,
          source,
        });
        await this.occupancy.endAssignmentsWithinTransaction(client, claims, {
          employeeId,
          effectiveFrom: input.terminationDate,
          source,
        });
      },
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
      /** Item 2 — the Organization Management side of this transaction,
       * run AFTER the `employees` UPDATE on the same client. `source` is
       * the audit tag (`employee_lifecycle:<eventType>`). */
      orgSync?: (source: string) => Promise<void>;
    }>
  ): Promise<LifecycleTransactionResult> {
    const scope = await this.resolveManageAccess(claims);

    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id!;
      const current = await client.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
      if (current.rowCount === 0) throw new NotFoundException("Employee not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const before = current.rows[0] as any;
      // Checked against the employee's CURRENT org unit/location only. Each
      // of the 9 transactions below computes its own "next" org
      // unit/location inside its own `build()` closure (transfer's new
      // orgUnitId, promote's seat-driven org unit, ...) with no common
      // shape this shared helper can inspect generically the way
      // `EmployeesService.update()` / `PositionsService.update()` check
      // their own single, uniform `next` object — a documented, narrower
      // bound than those two: a scoped caller cannot act on an employee
      // OUTSIDE their region, but a transfer/promotion they run CAN still
      // move that employee TO an org unit outside it. Closing that would
      // mean threading the proposed org unit/location out of every
      // `build*()` helper — a larger, separately-scoped refactor.
      this.assertInManageScope(scope, before);

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

      let updateResult = await client.query(
        `UPDATE employees SET ${built.setClause}, updated_at = now() WHERE id = $1 RETURNING *`,
        [employeeId, ...built.params]
      );
      if (built.orgSync) {
        await built.orgSync(`employee_lifecycle:${eventType}`);
        // Org sync may itself change `employees.position_id` (seat
        // assign/vacate) — re-read so the response is the committed state.
        updateResult = await client.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
      }
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

  /**
   * Shared by promote()/demote(): designation (and band) always change; a
   * `positionId` additionally moves the employee into that seat, and if
   * the seat sits in a different org unit the org unit/department follow
   * it (a position belongs to exactly one org unit).
   */
  private async buildDesignationChange(
    client: PoolClient,
    claims: RequestClaims,
    companyId: string,
    employeeId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    before: any,
    input: PromoteEmployeeRequest | DemoteEmployeeRequest
  ) {
    const salaryBand = input.salaryBand ?? before.salary_band;
    const position = input.positionId ? await this.loadTargetPosition(client, companyId, input.positionId, undefined) : null;
    const orgUnitId: string | null = position?.org_unit_id ?? before.org_unit_id;
    const department =
      position && position.org_unit_id !== before.org_unit_id
        ? await this.resolveDepartment(client, companyId, position.org_unit_id, before.department)
        : before.department;
    return {
      setClause: "designation = $2, salary_band = $3, org_unit_id = $4, department = $5",
      params: [input.designation, salaryBand, orgUnitId, department],
      historyFields: { department, designation: input.designation, salaryBand },
      orgSync: position
        ? async (source: string) => {
            await this.occupancy.assignPositionWithinTransaction(client, claims, {
              positionId: position.id,
              employeeId,
              effectiveFrom: input.effectiveDate,
              source,
            });
            await this.syncPrimaryAssignment(client, claims, employeeId, {
              orgUnitId: position.org_unit_id,
              locationId: before.location_id,
              effectiveFrom: input.effectiveDate,
              source,
            });
          }
        : undefined,
    };
  }

  /** Loads a Position a transaction names, failing with a clear 400/404
   * BEFORE any write. The authoritative vacancy re-check happens later,
   * under a row lock, inside OrgOccupancyService — this is the early,
   * friendly error. */
  private async loadTargetPosition(
    client: PoolClient,
    companyId: string,
    positionId: string,
    expectedOrgUnitId: string | undefined,
    opts: { requireVacant: boolean } = { requireVacant: true }
  ): Promise<{ id: string; org_unit_id: string; status: string }> {
    const result = await client.query<{ id: string; org_unit_id: string; status: string }>(
      "SELECT id, org_unit_id, status FROM positions WHERE id = $1 AND company_id = $2",
      [positionId, companyId]
    );
    if (result.rowCount === 0) throw new BadRequestException("Position not found");
    const position = result.rows[0];
    if (expectedOrgUnitId && position.org_unit_id !== expectedOrgUnitId) {
      throw new BadRequestException("Selected position belongs to a different organization unit than the one selected");
    }
    if (position.status === "abolished") throw new BadRequestException("Selected position has been abolished");
    if (opts.requireVacant && position.status !== "vacant") {
      throw new BadRequestException(`Selected position is ${position.status}, not vacant`);
    }
    return position;
  }

  /** Transfer without a new seat: the employee cannot keep occupying a
   * position that belongs to the org unit they are leaving. */
  private async vacateSeatOutsideOrgUnit(
    client: PoolClient,
    claims: RequestClaims,
    companyId: string,
    positionId: string,
    newOrgUnitId: string | null,
    effectiveFrom: string,
    source: string
  ): Promise<void> {
    const seat = await client.query<{ org_unit_id: string }>("SELECT org_unit_id FROM positions WHERE id = $1 AND company_id = $2", [
      positionId,
      companyId,
    ]);
    if (seat.rowCount && seat.rows[0].org_unit_id !== newOrgUnitId) {
      await this.occupancy.vacatePositionWithinTransaction(client, claims, { positionId, effectiveFrom, source });
    }
  }

  /** Make the employee's open `primary` assignment reflect (org unit,
   * current seat, location) — delegates to
   * `OrgOccupancyService.syncPrimaryAssignmentWithinTransaction()`, the
   * one implementation shared with the Position Workbench. */
  private async syncPrimaryAssignment(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    input: { orgUnitId: string | null; locationId: string | null; effectiveFrom: string; source: string }
  ): Promise<void> {
    await this.occupancy.syncPrimaryAssignmentWithinTransaction(client, claims, employeeId, input);
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

  /** Cross-module integration audit (2026-10-01), gap #3/#7 — Data Scope
   * write-side sibling of `requireModuleAndManagePermission()` above, used
   * by `execute()` (and therefore every one of the 9 lifecycle
   * transactions) instead of it. `.manage.all` wins outright
   * (unrestricted); otherwise a caller holding only
   * `employee.manage.scoped` gets back their assigned org-unit subtree
   * and location subtree ids, checked against the employee's CURRENT org
   * unit/location by `assertInManageScope()` — same shape
   * `EmployeesService.resolveManageAccess()` established for this
   * identical gap. */
  private async resolveManageAccess(
    claims: RequestClaims
  ): Promise<{ unrestricted: boolean; orgUnitIds: string[]; locationIds: string[] }> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (await this.rbac.can(claims, MANAGE_PERMISSION)) {
      return { unrestricted: true, orgUnitIds: [], locationIds: [] };
    }
    if (!(await this.rbac.hasScopedPermission(claims, SCOPED_MANAGE_PERMISSION_BASE))) {
      throw new ForbiddenException("Not permitted to manage employee records");
    }
    const [assignedOrgUnitIds, assignedLocationIds] = await Promise.all([
      this.rbac.resolveDataScopeEntityIds(claims, "org_unit"),
      this.rbac.resolveDataScopeEntityIds(claims, "location"),
    ]);
    const [orgUnitIds, locationIds] = await Promise.all([
      this.expandOrgUnitIdsToSubtree(claims, assignedOrgUnitIds),
      this.expandLocationIdsToSubtree(claims, assignedLocationIds),
    ]);
    return { unrestricted: false, orgUnitIds, locationIds };
  }

  private assertInManageScope(
    scope: { unrestricted: boolean; orgUnitIds: string[]; locationIds: string[] },
    record: { org_unit_id: string | null; location_id: string | null }
  ): void {
    if (scope.unrestricted) return;
    const inOrgUnit = Boolean(record.org_unit_id) && scope.orgUnitIds.includes(record.org_unit_id as string);
    const inLocation = Boolean(record.location_id) && scope.locationIds.includes(record.location_id as string);
    if (!inOrgUnit && !inLocation) {
      throw new ForbiddenException("Employee is outside your assigned data scope");
    }
  }

  /** Duplicated from `EmployeesService`/`PositionsService`'s own copies —
   * same reasoning as this file's own header comment on why org-unit/
   * location existence checks already go straight at the tables rather
   * than through OrganizationModule's services. */
  private async expandOrgUnitIdsToSubtree(claims: RequestClaims, rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    return this.db.withClaims(claims, async (client) => {
      const ids = new Set<string>();
      for (const rootId of rootIds) {
        const exists = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [
          rootId,
          claims.company_id,
        ]);
        if (exists.rowCount === 0) continue;
        ids.add(rootId);
        const descendants = await client.query<{ id: string }>(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM org_units WHERE company_id = $1 AND id = $2
             UNION ALL
             SELECT ou.id FROM org_units ou JOIN subtree s ON ou.parent_id = s.id WHERE ou.company_id = $1
           )
           SELECT id FROM subtree WHERE id != $2`,
          [claims.company_id, rootId]
        );
        for (const row of descendants.rows) ids.add(row.id);
      }
      return Array.from(ids);
    });
  }

  private async expandLocationIdsToSubtree(claims: RequestClaims, rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    return this.db.withClaims(claims, async (client) => {
      const ids = new Set<string>();
      for (const rootId of rootIds) {
        const exists = await client.query("SELECT 1 FROM locations WHERE id = $1 AND company_id = $2", [
          rootId,
          claims.company_id,
        ]);
        if (exists.rowCount === 0) continue;
        ids.add(rootId);
        const descendants = await client.query<{ id: string }>(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM locations WHERE company_id = $1 AND id = $2
             UNION ALL
             SELECT l.id FROM locations l JOIN subtree s ON l.parent_id = s.id WHERE l.company_id = $1
           )
           SELECT id FROM subtree WHERE id != $2`,
          [claims.company_id, rootId]
        );
        for (const row of descendants.rows) ids.add(row.id);
      }
      return Array.from(ids);
    });
  }
}
