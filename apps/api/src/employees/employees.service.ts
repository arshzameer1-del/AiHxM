import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { normalizeEmail } from "../auth/email.util";
import { hashPassword } from "../auth/password";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { ImportExportService } from "../import-export/import-export.service";
import { PersonsService } from "./persons.service";
import { formatEmployeeNumber, parseEmployeeNumberSequence } from "./employee-number.util";
import {
  classifiedFieldKeys,
  listFieldSensitivity,
  restrictedFieldsExposed,
  sensitivityFloorDefaults,
  VIEW_SENSITIVE_PERMISSION,
} from "./employee-field-sensitivity";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { OrgOccupancyService } from "../organization/occupancy/org-occupancy.service";
import type {
  CreateEmployeeRequest,
  CsvImportResult,
  EmployeeDocumentView,
  EmployeeFieldSensitivityEntry,
  EmployeeNumberFormat,
  EmployeeView,
  EmploymentType,
  JobHistoryEntryView,
  JobHistoryEventType,
  OrgChartNode,
  RecordJobHistoryRequest,
  UpdateEmployeeRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const OBJECT_KEY = "employee";
const VIEW_PERMISSION = "employee.view";
const MANAGE_PERMISSION = "employee.manage.all";
// Cross-module integration audit (2026-10-01), gap #3/#7 — the write-side
// Data Scope alternative to MANAGE_PERMISSION, same convention 0079/0102/
// 0111 established: a caller holding only `employee.manage.scoped` can
// update (which is also how termination happens, via `employmentStatus`)
// only employees inside their assigned org-unit subtree or location
// subtree. See `resolveManageAccess()`'s own doc comment.
const SCOPED_MANAGE_PERMISSION_BASE = "employee.manage";
// Decision #20 (Task #52) — lets a System Admin (who does not hold
// employee.manage.all) provision logins too, without granting them full
// HR-Admin employee-management rights. See requireModuleAndAccountPermission().
const ACCOUNT_PERMISSION = "user_account.manage.all";
// Cross-module integration audit Item 8 (2026-10-01) — unioned with every
// field employee-field-sensitivity.ts classifies above `normal`, so a field
// classified there is always field-filtered even if this list is not
// updated alongside it.
const SENSITIVE_FIELDS: readonly string[] = Array.from(
  new Set(["cnic", "dateOfBirth", "salaryBand", "bankAccountNumber", "terminationReason", ...classifiedFieldKeys()])
);
// Decision #12, widened by Decision #20 and Phase P2 — the only roles
// `createLogin()` is allowed to grant. Deliberately excludes the Phase 4
// `rbac_demo_*` proof-of-concept roles. `system_admin` was added here so
// an HR Admin creating a brand-new login can grant System Admin at the
// same time, rather than needing a separate Platform-Admin-mediated step
// afterward — see 0024_system_admin.sql's own "Bootstrap note".
// `payroll_approver` (0093_payroll_approval_workflow.sql) is added the
// same way — an hr_admin needs to be able to grant the Payroll Approver
// role to a colleague (or a second role to themselves, though that
// defeats the segregation of duties the role exists for) without a
// separate Platform-Admin step.
const TENANT_ROLE_KEYS = ["hr_admin", "line_manager", "employee_self_service", "system_admin", "payroll_approver"] as const;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB — see addDocument()'s doc comment.

// Tenant Management gap-fill Phase 1 item #10 — Storage quota enforcement.
// A conservative allowlist covering what an HR document vault realistically
// holds (ID/contract scans, certificates, photos, offer letters, payroll
// spreadsheets) — executables, scripts, and archives are never acceptable
// here regardless of a tenant's quota headroom.
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEmployee(row: any): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.company_id,
    userAccountId: row.user_account_id,
    employeeNumber: row.employee_number,
    // Core Employee Enterprise Phase 1 (0081_person_identity.sql) — see
    // that migration's own header comment. `null` for any row inserted
    // outside EmployeesService (test fixtures, etc.) rather than always
    // present — the same nullable-until-linked shape as `orgUnitId`.
    personId: row.person_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    gender: row.gender,
    maritalStatus: row.marital_status,
    department: row.department,
    orgUnitId: row.org_unit_id,
    // Organization Management Phase 2 (0068_job_position_architecture.sql)
    // — read-only from this service's perspective; only
    // PositionsService.assignEmployee()/unassignEmployee() ever writes it
    // (see this service's own class doc comment... and positions.service.ts's).
    positionId: row.position_id ?? null,
    designation: row.designation,
    location: row.location,
    // Organization Management Phase 4 (0073_locations_and_financial_centers.sql)
    // — read-only from this service's rowToEmployee() perspective in the
    // same sense `orgUnitId` is: EmployeesService itself is the one thing
    // that WRITES it (via resolveLocation() below), on create/update.
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
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDocument(row: any): EmployeeDocumentView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    documentType: row.document_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
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
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoDate(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString ? value.toISOString().slice(0, 10) : value;
}

/**
 * The first real HR module (plan doc Section 7's Phase 7 row). Enforcement
 * order is exactly Section 4's, same as every module since Phase 5: is
 * `employee` even licensed (EntitlementsService) -> can the role touch
 * this object/which fields (RbacService) -> RLS underneath both as the
 * tenant-isolation backstop.
 *
 * Unlike DummyService (Platform-Admin fixture tooling), this is a genuine
 * tenant self-service object — SessionGuard callers (real HR Admins,
 * managers, employees) drive every method here directly, and
 * `MANAGE_PERMISSION` gates who's allowed to create/update/attach/record,
 * throwing ForbiddenException (403) rather than the 404 a view-permission
 * failure gets — a write a caller isn't allowed to make is a different
 * kind of "no" than "this record doesn't exist for you," and the existing
 * WorkflowService/CustomFieldsService manage-permission checks already
 * established that distinction.
 *
 * Phase 3 item #4 (Webhooks & Eventing) scope decision: this is one of
 * only 2 real, already-audited trigger points wired to
 * `WebhookDispatchService.enqueue()` in this whole rollout —
 * `employee.created` (end of `create()`) and `employee.terminated` (inside
 * `autoRecordJobHistory()`, the one place a termination is ever detected,
 * shared by every path that can cause one). These are the two events an
 * external HR/payroll/Slack integration most obviously wants to react to
 * (new hire provisioning, offboarding kickoff) — chosen specifically
 * because both already have a durable, audited moment in the code
 * (`employee_job_history`'s own 'hire'/'termination' rows) to hang off,
 * rather than inventing a new one. Every other lifecycle change
 * (promotion, transfer, salary change, a plain profile edit) deliberately
 * does NOT fire a webhook yet — not a gap, a "rule of three, don't
 * over-build ahead of demand" call (see onboarding-offboarding's own
 * module doc comments for the same discipline applied elsewhere in this
 * codebase): a real, additive follow-up once an actual integration
 * customer asks for one of them, not before.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService,
    // Optional (not just "injected via DI") deliberately: a large number
    // of OTHER feature areas' spec files (shifts, performance, leave,
    // recruitment, onboarding-offboarding, employee-groups, system-admin,
    // data-subject-requests, ...) hand-construct EmployeesService directly
    // as a fixture dependency, with no interest in webhooks at all. Making
    // this required would force a mechanical, purely-compile-driven edit
    // across a dozen-plus unrelated test files for a Phase 3 gap-fill
    // item they have nothing to do with — exactly the kind of blast-radius
    // creep this rollout is trying to avoid. NestJS's real DI container
    // (EmployeesModule -> WebhooksModule) always supplies a real instance
    // in production and in every e2e test that boots the whole AppModule;
    // only a test that constructs this service BY HAND, and never calls
    // create()/update() in a way that would enqueue anything, ever sees it
    // as undefined.
    private readonly webhooks?: WebhookDispatchService,
    // Core Employee Enterprise Phase 1 (0081_person_identity.sql) —
    // PersonsService takes no constructor dependencies of its own; every
    // method takes the caller's own transaction `client` directly, the
    // same shape resolveDepartment()/resolveLocation() below already use.
    // A fresh `new PersonsService()` is therefore a fully real, working
    // instance, not a stub — which is exactly why this is given a
    // DEFAULT VALUE here rather than the `webhooks?` pattern above: the
    // dozen-plus spec files across other feature areas that hand-
    // construct EmployeesService without this argument keep working
    // completely unchanged, AND `create()`/`update()` still always have a
    // real PersonsService to call rather than silently skipping the
    // person link the way a missing `webhooks` silently skips a
    // notification. (`employees.person_id` itself stays nullable —
    // 0081_person_identity.sql's own header comment covers why — but
    // EmployeesService's own job is still to always populate it on every
    // create/identity-changing update it handles.) NestJS's real DI container always
    // injects the actual provider from this module regardless of this
    // default (see EmployeesModule) — the default only ever fires for a
    // test that constructs this service directly, in plain TypeScript,
    // with fewer than 7 positional arguments.
    private readonly persons: PersonsService = new PersonsService(),
    // Core Employee Enterprise Phase 12 (Bulk Hiring) — same
    // default-value reasoning as `persons` immediately above:
    // `ImportExportService` takes no constructor dependencies of its own
    // (a pure CSV parsing/generation utility, see its own class doc
    // comment), so `new ImportExportService()` is a fully real instance,
    // not a stub, and every existing spec file that hand-constructs
    // `EmployeesService` with fewer than 8 positional arguments keeps
    // working unchanged.
    private readonly importExport: ImportExportService = new ImportExportService(),
    // HR Administration v2 (2026-09-27) — same `webhooks?` optional
    // reasoning: a large number of unrelated spec files hand-construct
    // EmployeesService directly and have nothing to do with catalog
    // validation. `validateEmploymentType()` below no-ops when this is
    // undefined, the same way `webhooks?.enqueue()` no-ops — every real
    // caller (NestJS's DI container, EmployeesModule -> HrAdministrationModule)
    // always gets a real instance.
    private readonly hrCatalog?: HrReferenceCatalogService,
    // HR Administration v2 "then 2" Phase 2 (2026-10-02) — same optional
    // pattern as `hrCatalog` immediately above, for the same reason:
    // `maybeSeedProbationEndDate()`/`enforceRehireCooldown()` below no-op
    // when this is undefined, so every spec file that hand-constructs
    // EmployeesService without it keeps working unchanged. Added AFTER
    // `hrCatalog` (not before) so every existing positional call site —
    // including `employees.service.spec.ts`'s own `employeesWithCatalog`,
    // which passes exactly 9 positional args ending in `hrCatalog` — is
    // unaffected; this simply stays undefined for those callers.
    private readonly businessPolicy?: HrBusinessPolicyService,
    // Cross-module integration follow-up (2026-10-01) — `update()` keeps
    // `org_relationships` in sync when a generic PATCH changes
    // `managerId`. Default-instantiated and appended last, the same
    // convention EmployeeLifecycleService/HiringProcessService use, so every
    // spec file that hand-constructs this service positionally keeps
    // working; Nest's DI supplies the real OrgOccupancyModule instance.
    private readonly occupancy: OrgOccupancyService = new OrgOccupancyService(audit, new EffectiveDatingEngine(), webhooks)
  ) {}

  /** `employment_type` used to be a hardcoded 4-value `CHECK` constraint
   * (0090_hr_administration_reference_catalog.sql dropped it); this is the
   * data-driven replacement — validates against the calling company's own
   * active `employment_type` HR Administration catalog items. No-ops when
   * `employmentType` is not supplied (the caller is leaving it unchanged
   * or accepting the 'permanent' default) or when `hrCatalog` itself is
   * unavailable (see the constructor's own comment). */
  private async validateEmploymentType(client: PoolClient, companyId: string, employmentType: string | null | undefined): Promise<void> {
    if (!employmentType || !this.hrCatalog) return;
    await this.hrCatalog.validateActiveCode(client, companyId, "employment_type", employmentType);
  }

  /**
   * HR Administration v2 "then 2" Phase 1 (2026-10-01) — `maritalStatus`
   * used to be unconstrained free text (0010_employee_core.sql); this
   * tenant's own `marital_status` catalog is now the source of truth,
   * same optional-hrCatalog pattern as `validateEmploymentType()` above.
   */
  private async validateMaritalStatus(client: PoolClient, companyId: string, maritalStatus: string | null | undefined): Promise<void> {
    if (!maritalStatus || !this.hrCatalog) return;
    await this.hrCatalog.validateActiveCode(client, companyId, "marital_status", maritalStatus);
  }

  /**
   * HR Administration v2 "then 2" Phase 1 (2026-10-01) — `documentType`
   * (employee_documents.document_type) used to be unconstrained free
   * text; this tenant's own `document_type` catalog is now the source of
   * truth.
   */
  private async validateDocumentType(client: PoolClient, companyId: string, documentType: string | null | undefined): Promise<void> {
    if (!documentType || !this.hrCatalog) return;
    await this.hrCatalog.validateActiveCode(client, companyId, "document_type", documentType);
  }

  /**
   * HR Administration v2 "then 2" Phase 2 (2026-10-02) — the Rehire
   * Policy's real enforcement. Only ever meaningful at hire time: a
   * rehire is detected the same deterministic way `persons.service.ts`'s
   * own `findOrCreateForHire()` doc comment describes — a CNIC that
   * matches an existing person in this tenant. Gated on `cnic` being
   * supplied (no CNIC means `findOrCreateForHire()` always creates a
   * brand-new person, never a match) and on this company having a prior
   * TERMINATED employment for that same person — two employees sharing a
   * CNIC who are both still active (the genuine "second concurrent
   * employment" case that same doc comment also covers) is not a rehire
   * and is never blocked here. Default `cooldownDays` is 0 (see
   * `0107_hr_business_policies.sql`'s own seed), which this method
   * treats as "no restriction" — so no existing tenant's hiring behavior
   * changes until they explicitly raise it from HR Administration.
   */
  private async enforceRehireCooldown(
    client: PoolClient,
    claims: RequestClaims,
    personId: string | null | undefined,
    cnic: string | null | undefined,
    // "then 2" Phases 4+5 (2026-10-02) — the hire's own org unit/location,
    // so a scoped Rehire Policy override (set from HR Administration)
    // applies here too, not just the company-wide default. There is no
    // `employeeId` to scope by yet at this point in `create()` — the row
    // doesn't exist until just after this call — which is fine: an
    // employee-level override only ever makes sense for an EXISTING
    // employee, never for the hire that is still being created.
    orgContext: { locationId?: string | null; orgUnitId?: string | null } = {}
  ): Promise<void> {
    if (!cnic || !personId || !this.businessPolicy) return;
    const rules = await this.businessPolicy.resolveEffectivePolicy(client, claims.company_id!, "rehire", orgContext);
    const cooldownDays = typeof rules?.cooldownDays === "number" ? rules.cooldownDays : 0;
    if (cooldownDays <= 0) return;
    const prior = await client.query<{ termination_date: Date }>(
      `SELECT termination_date FROM employees
       WHERE company_id = $1 AND person_id = $2 AND employment_status = 'terminated' AND termination_date IS NOT NULL
       ORDER BY termination_date DESC LIMIT 1`,
      [claims.company_id, personId]
    );
    if (prior.rowCount === 0) return;
    const eligibleFrom = new Date(prior.rows[0].termination_date);
    eligibleFrom.setUTCDate(eligibleFrom.getUTCDate() + cooldownDays);
    if (new Date() < eligibleFrom) {
      throw new BadRequestException(
        `This person's last employment here ended too recently to be rehired yet — this company's Rehire Policy requires a ${cooldownDays}-day wait, so they become eligible on ${eligibleFrom.toISOString().slice(0, 10)}.`
      );
    }
  }

  /**
   * HR Administration v2 "then 2" Phase 2 (2026-10-02) — the Probation
   * Policy's real enforcement: a new hire whose `employment_type` is
   * exactly `'probation'` (the same literal code
   * `0012_employee_groups_leave_policy.sql`'s own `employment_type`
   * `CHECK` already uses, and `0090`'s own seeded `employment_type`
   * catalog item) gets a `probation_end` Important Date auto-computed
   * from the Probation Policy's `durationDays`, counted from their
   * `dateOfJoining` — unless the hire (or, for the Hiring Wizard, that
   * same transaction's own `important_dates` card projection, which
   * always runs AFTER this and supersedes any existing active row of
   * the same date_type) already set one explicitly. Deliberately scoped
   * to CREATE time only, not `update()` — retroactively seeding or
   * moving a probation end date just because `employmentType` was
   * edited later is a bigger, separately-scoped behavior change, not a
   * plain field edit.
   */
  private async maybeSeedProbationEndDate(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    employmentType: string | null | undefined,
    dateOfJoining: Date | string | null | undefined,
    // "then 2" Phases 4+5 (2026-10-02) — same reasoning as
    // `enforceRehireCooldown()`'s own `orgContext` param, except this
    // call happens AFTER the employee row is inserted, so a real
    // `employeeId` is available too — the most specific override level,
    // checked first by `resolveEffectivePolicy()`/`resolveOverride()`.
    orgContext: { locationId?: string | null; orgUnitId?: string | null } = {}
  ): Promise<void> {
    if (employmentType !== "probation" || !dateOfJoining || !this.businessPolicy) return;
    const rules = await this.businessPolicy.resolveEffectivePolicy(client, claims.company_id!, "probation", {
      employeeId,
      ...orgContext,
    });
    const durationDays = typeof rules?.durationDays === "number" ? rules.durationDays : null;
    if (!durationDays || durationDays <= 0) return;
    await client.query(
      `INSERT INTO employee_important_dates (company_id, employee_id, date_type, date_value, label)
       VALUES ($1, $2, 'probation_end', ($3::date + ($4 || ' days')::interval)::date, 'Auto-computed from Probation Policy')`,
      [claims.company_id, employeeId, dateOfJoining, durationDays]
    );
  }

  async create(claims: RequestClaims, input: CreateEmployeeRequest): Promise<EmployeeView> {
    await this.requireModuleAndManagePermission(claims);
    if (!claims.company_id) throw new ForbiddenException();

    return this.db.withClaims(claims, async (client) => {
      const employee = await this.createWithinTransaction(client, claims, input);

      // Cross-module integration follow-up (2026-10-01): hiring with a
      // `managerId` used to set only the `employees.manager_id` column,
      // leaving no `org_relationships` row behind it — the same gap the
      // generic PATCH path had before it started calling this shared sync
      // (see `update()`'s own comment on its own call to this method).
      // Deliberately kept HERE, in the public wrapper, rather than inside
      // `createWithinTransaction()` itself: that method's own doc comment
      // explains it is ALSO the Hiring Process wizard's own create step
      // (`HiringProcessService.complete()`), which already opens its own
      // `direct` relationship from the Reporting Relationships card via
      // `OrgOccupancyService.createRelationshipWithinTransaction()` right
      // after calling it — syncing here too would double-write (end the
      // just-created row and immediately replace it with an identical
      // one). This is employee creation, so there is no PRIOR relationship
      // to end — only ever the "create" branch inside
      // `syncDirectManagerFromEmployeeWithinTransaction()` runs (its own
      // no-prior-relationship `endRelationshipsWithinTransaction` call is
      // a no-op for a brand-new employee). `syncEmployeeManagerId` stays
      // false inside that method, so it never re-writes the column the
      // INSERT above already set.
      if (input.managerId) {
        await this.occupancy.syncDirectManagerFromEmployeeWithinTransaction(client, claims, {
          employeeId: employee.id,
          managerEmployeeId: input.managerId,
          effectiveFrom: input.dateOfJoining ?? undefined,
          source: "employee_create",
        });
      }

      return employee;
    });
  }

  /**
   * Core Employee Enterprise Phase 2 (hiring-process.service.ts) — the
   * actual create() body, split out so HiringProcessService.complete()
   * can run it INSIDE its own already-open transaction (the same one
   * that marks the hire process itself 'hired'), instead of in a second,
   * separate transaction. Without this split, a failure marking the hire
   * process complete after the employee insert already committed would
   * leave a real employee behind a hire process that still claims to be
   * incomplete — and a retry would call this a second time and create a
   * duplicate employee, exactly what Section 17's idempotency requirement
   * exists to prevent. The public `create()` above remains the only
   * entry point for every other caller (the controller, every existing
   * spec file) and is unchanged in behavior — it just now delegates its
   * body here inside its own `withClaims` transaction as before.
   * Permission/company-id checks stay in the public wrapper;
   * HiringProcessService performs its own equivalent checks before ever
   * reaching this method, so this method itself does not re-check them.
   */
  async createWithinTransaction(client: PoolClient, claims: RequestClaims, input: CreateEmployeeRequest): Promise<EmployeeView> {
      await this.validateEmploymentType(client, claims.company_id!, input.employmentType);
      await this.validateMaritalStatus(client, claims.company_id!, input.maritalStatus);
      const employeeNumber = await this.assignEmployeeNumber(client, claims.company_id!, input.employeeNumber);
      const department = await this.resolveDepartment(client, claims.company_id!, input.orgUnitId, input.department);
      const location = await this.resolveLocation(client, claims.company_id!, input.locationId, input.location);
      // Core Employee Enterprise Phase 1 (0081_person_identity.sql) — every
      // hire resolves to a person, deterministically matched by CNIC
      // (findOrCreateForHire()'s own doc comment covers why: a confirmed
      // CNIC match is a rehire of the same person, not a new one).
      const personId = await this.persons.findOrCreateForHire(client, claims.company_id!, {
        firstName: input.firstName,
        lastName: input.lastName,
        cnic: input.cnic,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
      });
      await this.enforceRehireCooldown(client, claims, personId, input.cnic, {
        locationId: input.locationId,
        orgUnitId: input.orgUnitId,
      });

      const result = await client.query(
        `INSERT INTO employees
           (company_id, user_account_id, employee_number, person_id, first_name, last_name, email, phone, cnic,
            date_of_birth, gender, marital_status, department, org_unit_id, designation, location, location_id,
            employment_type, manager_id, date_of_joining, salary_band, bank_account_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 COALESCE($18, 'permanent'), $19, COALESCE($20, CURRENT_DATE), $21, $22)
         RETURNING *`,
        [
          claims.company_id,
          input.userAccountId ?? null,
          employeeNumber,
          personId,
          input.firstName,
          input.lastName,
          input.email ?? null,
          input.phone ?? null,
          input.cnic ?? null,
          input.dateOfBirth ?? null,
          input.gender ?? null,
          input.maritalStatus ?? null,
          department,
          input.orgUnitId ?? null,
          input.designation ?? null,
          location,
          input.locationId ?? null,
          input.employmentType ?? null,
          input.managerId ?? null,
          input.dateOfJoining ?? null,
          input.salaryBand ?? null,
          input.bankAccountNumber ?? null,
        ]
      );
      const row = result.rows[0];

      // Every employee's history starts with a 'hire' event — auto-logged,
      // not left to the caller to remember to record separately.
      await client.query(
        `INSERT INTO employee_job_history
           (company_id, employee_id, event_type, effective_date, department, designation, salary_band, recorded_by_user_account_id)
         VALUES ($1, $2, 'hire', $3, $4, $5, $6, $7)`,
        [claims.company_id, row.id, row.date_of_joining, row.department, row.designation, row.salary_band, claims.sub]
      );

      await this.maybeSeedProbationEndDate(client, claims, row.id, row.employment_type, row.date_of_joining, {
        locationId: row.location_id,
        orgUnitId: row.org_unit_id,
      });

      const employee = rowToEmployee(row) as EmployeeView;

      // Phase 3 item #4 — Webhooks & Eventing. `employee.created` is one
      // of the 2 real event types this rollout wires up for real (the
      // other is `employee.terminated`, in autoRecordJobHistory below) —
      // see this service's own top-of-file doc comment for the deliberate
      // scope decision on why exactly these two and not more. Fire-and-
      // forget on its own connection, same "never let a side-effect
      // notification fail or delay the main write" pattern
      // BackupsService/HealthService already use for
      // NotificationsService.dispatch(): a webhook target that's slow,
      // misconfigured, or simply not set up must never make hiring an
      // employee fail.
      this.webhooks?.enqueue(claims.company_id!, "employee.created", { employee }).catch(() => undefined);

      return employee;
  }

  /**
   * Core Employee Enterprise Phase 12 — Bulk Hiring. Same shape as the
   * one existing CSV-import precedent in this codebase
   * (`DummyService.importCsv()`, Plan doc Section 6's "Conversions"
   * WRICEF pillar): `ImportExportService.parseAndValidate()` handles
   * STRUCTURAL validation only (required columns present, non-empty on
   * every row) and returns a real per-row error report for those; each
   * structurally-valid row is then created via the normal, single-row
   * `create()` — reusing every one of its own real checks (employee
   * number assignment, department/location resolution, person/CNIC
   * matching, the 'hire' job-history row, the `employee.created`
   * webhook) rather than a parallel bulk-only insert path.
   *
   * DELIBERATELY NOT ALSO A ROW-LEVEL "SKIP AND COLLECT" beyond that
   * structural check, matching `DummyService.importCsv()`'s own
   * precedent exactly: a `create()`-time failure (a duplicate
   * `employeeNumber`, an unknown `orgUnitId`, ...) throws and fails the
   * whole bulk import rather than silently completing a partial batch —
   * for a HIRING action specifically (unlike Payroll's own
   * `calculateRun()`, which deliberately DOES collect per-employee
   * calculation errors) an admin re-running the same CSV after fixing the
   * one bad row is the safer default than reconciling which of N new
   * employees were actually created after a partial failure.
   */
  async bulkImportEmployees(claims: RequestClaims, csvText: string): Promise<CsvImportResult<EmployeeView>> {
    await this.requireModuleAndManagePermission(claims);
    if (!claims.company_id) throw new ForbiddenException();

    const { rows: parsedRows, errors } = this.importExport.parseAndValidate(
      csvText,
      ["firstName", "lastName"] as const,
      (record): CreateEmployeeRequest => ({
        firstName: record.firstName,
        lastName: record.lastName,
        employeeNumber: record.employeeNumber || undefined,
        email: record.email || undefined,
        phone: record.phone || undefined,
        cnic: record.cnic || undefined,
        dateOfBirth: record.dateOfBirth || undefined,
        gender: record.gender || undefined,
        maritalStatus: record.maritalStatus || undefined,
        department: record.department || undefined,
        orgUnitId: record.orgUnitId || undefined,
        designation: record.designation || undefined,
        location: record.location || undefined,
        locationId: record.locationId || undefined,
        employmentType: (record.employmentType || undefined) as EmploymentType | undefined,
        managerId: record.managerId || undefined,
        dateOfJoining: record.dateOfJoining || undefined,
        salaryBand: record.salaryBand || undefined,
        bankAccountNumber: record.bankAccountNumber || undefined,
      })
    );

    // kumail's own live incident (2026-09-27): a bulk-import file with 6
    // rows that were exact, unedited copies of the downloadable template's
    // own example row ("Ayesha Khan" / Engineering / Software Engineer)
    // created 6 real, distinct employees — each got its own real,
    // sequential employee number (`assignEmployeeNumber` has no idea the
    // surrounding row data is duplicated), and `PersonsService
    // .findOrCreateForHire()`'s own duplicate check only ever looks at
    // CNIC (see that method's own doc comment), which was blank on every
    // one of those rows. Neither existing safeguard was ever meant to
    // catch "the same row appears twice in one file" — this one is.
    //
    // Checked BEFORE any employee is created (not a per-row skip like
    // `parseAndValidate`'s structural errors above) — matching this
    // method's own established "a bad row fails the WHOLE batch, an admin
    // fixes the file and re-runs" posture (see this method's own class
    // doc comment) rather than silently creating some of a duplicated
    // batch and skipping the rest.
    //
    // Deliberately keyed on every real identity/assignment field EXCEPT
    // `employeeNumber` (often blank — that's fine, two blanks aren't
    // evidence of anything) — two rows matching on every one of these
    // fields at once (name AND email AND phone AND CNIC AND department
    // AND designation AND ...) is for all practical purposes always a
    // copy-paste mistake, never two real, distinct hires; genuinely
    // distinct people sharing a name still differ in at least one of the
    // rest.
    const duplicateGroups = this.findDuplicateImportRows(parsedRows);
    if (duplicateGroups.length > 0) {
      const preview = duplicateGroups
        .slice(0, 5)
        .map((g) => `${g.count}× "${g.firstName} ${g.lastName}"${g.designation ? ` (${g.designation})` : ""}`)
        .join("; ");
      throw new BadRequestException(
        `This file has ${duplicateGroups.length} set(s) of identical rows: ${preview}${
          duplicateGroups.length > 5 ? ", …" : ""
        }. Nothing was imported — remove the duplicate rows (or give each employee their own name/email/CNIC) and re-upload.`
      );
    }

    const imported: EmployeeView[] = [];
    for (const row of parsedRows) {
      imported.push(await this.create(claims, row));
    }
    return { imported: imported.length, rows: imported, errors };
  }

  /** See `bulkImportEmployees()`'s own doc comment for why this check exists and what it deliberately does and doesn't match on. */
  private findDuplicateImportRows(
    rows: CreateEmployeeRequest[]
  ): { firstName: string; lastName: string; designation?: string; count: number }[] {
    const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
    const signature = (r: CreateEmployeeRequest) =>
      [
        norm(r.firstName),
        norm(r.lastName),
        norm(r.email),
        norm(r.phone),
        norm(r.cnic),
        norm(r.dateOfBirth),
        norm(r.department),
        norm(r.orgUnitId),
        norm(r.designation),
        norm(r.location),
        norm(r.locationId),
        norm(r.employmentType),
        norm(r.managerId),
        norm(r.dateOfJoining),
        norm(r.salaryBand),
        norm(r.bankAccountNumber),
      ].join("\u0001");

    const groups = new Map<string, CreateEmployeeRequest[]>();
    for (const row of rows) {
      const key = signature(row);
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }

    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({ firstName: group[0].firstName, lastName: group[0].lastName, designation: group[0].designation, count: group.length }));
  }

  async list(claims: RequestClaims): Promise<EmployeeView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      // Phase 7 fix for the N+1 the Phase 5 audit deferred specifically
      // to this phase (KNOWN_ISSUES.md): the caller's object-level scope
      // and the field-permission rules that could apply are each fetched
      // ONCE for the whole request, not once per row — see
      // RbacService.resolveViewScope/loadFieldPermissionRules's doc
      // comments. `manager_user_account_id` is the `.team` scope's match
      // target (the record's own manager's login identity, resolved via
      // a self-join so RbacService never needs to know employees have
      // managers at all).
      const [scope, fieldRules, floorDefaults, result] = await Promise.all([
        this.rbac.resolveViewScope(claims, VIEW_PERMISSION),
        this.rbac.loadFieldPermissionRules(claims, OBJECT_KEY, SENSITIVE_FIELDS),
        this.resolveSensitivityFloor(claims),
        client.query(
          `SELECT e.*, mgr.user_account_id AS manager_user_account_id
           FROM employees e
           LEFT JOIN employees mgr ON mgr.id = e.manager_id
           ORDER BY e.created_at ASC`
        ),
      ]);

      const out: EmployeeView[] = [];
      for (const row of result.rows) {
        const employee = rowToEmployee(row);
        const filtered = this.rbac.filterRecordFieldsWithScope(
          scope,
          fieldRules,
          employee,
          SENSITIVE_FIELDS,
          row.user_account_id,
          row.manager_user_account_id,
          claims.sub,
          floorDefaults
        );
        if (filtered) out.push(filtered as EmployeeView);
      }
      return out;
    });
  }

  /** `GET /employees/field-sensitivity` (Phase 11, gap #10) — the
   * classification itself is metadata describing which fields carry a
   * named sensitivity tier, not the sensitive data those fields hold, so
   * this needs only the module to be licensed at all, the same gate
   * `list()` uses — no `employee.manage.all`/`employee.view` check on
   * top of it. */
  async getFieldSensitivityClassification(claims: RequestClaims): Promise<EmployeeFieldSensitivityEntry[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    return listFieldSensitivity();
  }

  /**
   * Item 8 — the sensitivity-tier default floor for this caller, resolved
   * ONCE per request (same posture as resolveViewScope()). Restricted/
   * Highly Restricted fields with no explicit field rule for the caller's
   * roles default to visible only with `employee.view_sensitive.all`;
   * see `sensitivityFloorDefaults()`.
   */
  private async resolveSensitivityFloor(claims: RequestClaims) {
    return sensitivityFloorDefaults(await this.rbac.can(claims, VIEW_SENSITIVE_PERMISSION));
  }

  async get(claims: RequestClaims, id: string): Promise<EmployeeView> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException("Employee not found");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT e.*, mgr.user_account_id AS manager_user_account_id
         FROM employees e
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         WHERE e.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Employee not found");
      const row = result.rows[0];

      const [scope, fieldRules, floorDefaults] = await Promise.all([
        this.rbac.resolveViewScope(claims, VIEW_PERMISSION),
        this.rbac.loadFieldPermissionRules(claims, OBJECT_KEY, SENSITIVE_FIELDS),
        this.resolveSensitivityFloor(claims),
      ]);
      const employee = rowToEmployee(row);
      const filtered = this.rbac.filterRecordFieldsWithScope(
        scope,
        fieldRules,
        employee,
        SENSITIVE_FIELDS,
        row.user_account_id,
        row.manager_user_account_id,
        claims.sub,
        floorDefaults
      );
      if (!filtered) throw new NotFoundException("Employee not found");

      // Core Employee Enterprise Phase 11 (gap #10) — view-audit-logging
      // for the two most sensitive tiers, scoped deliberately to get()
      // (a single "open this employee's profile" action) and NOT list()
      // (a table view of many rows at once) — the same "don't force a
      // gap where the shape doesn't fit" scope-narrowing this codebase
      // has made before (see organization-assignment-validator.ts's own
      // doc comment): logging per-row on every list() call would make
      // audit_log grow with every table render rather than every actual
      // "someone looked at this person's CNIC" event. Only fires when the
      // viewer's own role/scope actually exposed a restricted-or-higher
      // field — most roles most of the time expose none, so most get()
      // calls write nothing extra here.
      const restricted = restrictedFieldsExposed(Object.keys(filtered));
      if (restricted.length > 0) {
        await this.audit.record(client, claims, {
          companyId: claims.company_id ?? null,
          action: "employee.sensitive_field_viewed",
          target: id,
          metadata: { fields: restricted.map((f) => f.fieldKey), tiers: Object.fromEntries(restricted.map((f) => [f.fieldKey, f.tier])) },
        });
      }

      return filtered as EmployeeView;
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeRequest): Promise<EmployeeView> {
    const scope = await this.resolveManageAccess(claims);

    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM employees WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Employee not found");
      const before = current.rows[0];
      this.assertInManageScope(scope, before);

      if (patch.employmentStatus === "terminated" && !patch.terminationDate && !before.termination_date) {
        throw new BadRequestException("terminationDate is required when setting employmentStatus to terminated");
      }

      await this.validateEmploymentType(client, claims.company_id!, patch.employmentType);
      await this.validateMaritalStatus(client, claims.company_id!, patch.maritalStatus);

      const nextOrgUnitId = patch.orgUnitId ?? before.org_unit_id;
      // Organization Management Phase 1: whenever an org unit is linked
      // (new or pre-existing), `department` is DERIVED from it, not typed
      // independently — a plain `patch.department` alongside an org-unit-
      // linked employee would otherwise silently drift out of sync with
      // the canonical hierarchy. An employee with no org unit at all keeps
      // the legacy free-text behavior unchanged.
      const department = await this.resolveDepartment(client, claims.company_id!, nextOrgUnitId, patch.department ?? before.department);

      const nextLocationId = patch.locationId ?? before.location_id;
      // Organization Management Phase 4: whenever a location is linked (new
      // or pre-existing), `location` is DERIVED from it, not typed
      // independently — the same `department`/`orgUnitId` relationship
      // established above. An employee with no location link at all keeps
      // the legacy free-text behavior unchanged.
      const location = await this.resolveLocation(client, claims.company_id!, nextLocationId, patch.location ?? before.location);

      // Core Employee Enterprise Phase 1 (0081_person_identity.sql) — keep
      // the derived `persons` shadow record in sync whenever an identity
      // field it also carries actually changes (PersonsService.
      // syncFromEmployee()'s own doc comment covers why only on an actual
      // change, and why this never re-runs CNIC matching). Computed here,
      // before the values below are folded into `next`, so it can compare
      // patch-or-before against before directly. Guarded on
      // `before.person_id` being set at all — a row inserted outside
      // EmployeesService (see that field's own nullable-by-design doc
      // comment) has nothing to sync yet; it stays unlinked until it's
      // next recreated through this service, the same "no org unit at
      // all keeps legacy behavior unchanged" shape resolveDepartment()
      // already established.
      const nextFirstName = patch.firstName ?? before.first_name;
      const nextLastName = patch.lastName ?? before.last_name;
      const nextCnic = patch.cnic ?? before.cnic;
      const nextDateOfBirth = patch.dateOfBirth ?? before.date_of_birth;
      const nextGender = patch.gender ?? before.gender;
      const identityChanged =
        nextFirstName !== before.first_name ||
        nextLastName !== before.last_name ||
        nextCnic !== before.cnic ||
        nextDateOfBirth !== before.date_of_birth ||
        nextGender !== before.gender;
      if (identityChanged && before.person_id) {
        await this.persons.syncFromEmployee(client, claims.company_id!, before.person_id, {
          firstName: nextFirstName,
          lastName: nextLastName,
          cnic: nextCnic,
          dateOfBirth: nextDateOfBirth,
          gender: nextGender,
        });
      }

      const next = {
        first_name: nextFirstName,
        last_name: nextLastName,
        email: patch.email ?? before.email,
        phone: patch.phone ?? before.phone,
        cnic: nextCnic,
        date_of_birth: nextDateOfBirth,
        gender: nextGender,
        marital_status: patch.maritalStatus ?? before.marital_status,
        department,
        org_unit_id: nextOrgUnitId,
        designation: patch.designation ?? before.designation,
        location,
        location_id: nextLocationId,
        employment_type: patch.employmentType ?? before.employment_type,
        manager_id: patch.managerId ?? before.manager_id,
        employment_status: patch.employmentStatus ?? before.employment_status,
        date_of_joining: patch.dateOfJoining ?? before.date_of_joining,
        termination_date: patch.terminationDate ?? before.termination_date,
        termination_reason: patch.terminationReason ?? before.termination_reason,
        salary_band: patch.salaryBand ?? before.salary_band,
        bank_account_number: patch.bankAccountNumber ?? before.bank_account_number,
      };
      // A scoped caller may not move an employee's org unit/location to
      // one outside their own data scope, even though they were allowed
      // to touch the employee in its CURRENT (in-scope) location.
      this.assertInManageScope(scope, { org_unit_id: next.org_unit_id, location_id: next.location_id });

      const result = await client.query(
        `UPDATE employees SET
           first_name = $2, last_name = $3, email = $4, phone = $5, cnic = $6, date_of_birth = $7,
           gender = $8, marital_status = $9, department = $10, org_unit_id = $11, designation = $12, location = $13,
           location_id = $14, employment_type = $15, manager_id = $16, employment_status = $17, date_of_joining = $18,
           termination_date = $19, termination_reason = $20, salary_band = $21, bank_account_number = $22,
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          next.first_name,
          next.last_name,
          next.email,
          next.phone,
          next.cnic,
          next.date_of_birth,
          next.gender,
          next.marital_status,
          next.department,
          next.org_unit_id,
          next.designation,
          next.location,
          next.location_id,
          next.employment_type,
          next.manager_id,
          next.employment_status,
          next.date_of_joining,
          next.termination_date,
          next.termination_reason,
          next.salary_band,
          next.bank_account_number,
        ]
      );
      const after = result.rows[0];

      // Cross-module integration follow-up (2026-10-01): a manager change
      // through this generic PATCH used to patch only the column, leaving
      // the open `direct` org_relationships row pointing at the old
      // manager. It now goes through the SAME shared write path as
      // EmployeeLifecycleService.changeManager()
      // (`syncDirectManagerFromEmployeeWithinTransaction()`), on this
      // transaction's client — a reporting cycle / terminated / unknown
      // manager rejects and rolls back the whole update. Ping-pong guard:
      // that method never writes `employees.manager_id` (the UPDATE above
      // is the one writer of it here), and OrgRelationshipsService's
      // opposite-direction sync never calls back into this service.
      if ((after.manager_id ?? null) !== (before.manager_id ?? null)) {
        await this.occupancy.syncDirectManagerFromEmployeeWithinTransaction(client, claims, {
          employeeId: id,
          managerEmployeeId: after.manager_id ?? null,
          source: "employee_update",
        });
      }

      await this.autoRecordJobHistory(client, claims, before, after);

      return rowToEmployee(after) as EmployeeView;
    });
  }

  /**
   * Builds the org chart (Section 7's exit criterion) from whatever the
   * caller can already see via `list()` — an employee whose manager isn't
   * in that visible set becomes a root of its own subtree rather than
   * leaking the existence of a manager the caller has no access to. A
   * Line Manager's org chart is naturally just their own team, since
   * `list()` already scoped it that way; an HR Admin's is the whole
   * company.
   */
  async orgChart(claims: RequestClaims): Promise<OrgChartNode[]> {
    const visible = await this.list(claims);
    const byId = new Map<string, OrgChartNode>();
    for (const employee of visible) {
      byId.set(employee.id, {
        id: employee.id,
        employeeNumber: employee.employeeNumber,
        fullName: `${employee.firstName} ${employee.lastName}`,
        designation: employee.designation,
        department: employee.department,
        directReports: [],
      });
    }
    const roots: OrgChartNode[] = [];
    for (const employee of visible) {
      const node = byId.get(employee.id)!;
      const managerNode = employee.managerId ? byId.get(employee.managerId) : undefined;
      if (managerNode) {
        managerNode.directReports.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * The document vault (Section 7). `MAX_DOCUMENT_BYTES` caps a single
   * upload — the KNOWN_ISSUES.md "Not yet investigated" note flagged
   * request/response payload size limits as unaddressed; this is the
   * first real upload endpoint in the codebase, so it gets an explicit
   * limit from day one rather than adding to that gap. The same
   * "employee.manage.all" gate as create/update — attaching a document to
   * someone's HR file is an HR Admin action, not a self-service one, in
   * this phase.
   */
  async addDocument(
    claims: RequestClaims,
    employeeId: string,
    documentType: string,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number }
  ): Promise<EmployeeDocumentView> {
    await this.requireModuleAndManagePermission(claims);
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(`File exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
    }
    // Tenant Management gap-fill Phase 1 item #10 — file-type allowlist.
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `"${file.mimetype}" isn't an allowed file type for employee documents. Allowed types: PDF, JPEG, PNG, WEBP, Word, and Excel files.`
      );
    }

    return this.db.withClaims(claims, async (client) => {
      const employee = await client.query("SELECT id, company_id FROM employees WHERE id = $1", [employeeId]);
      if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
      const companyId = employee.rows[0].company_id;
      await this.validateDocumentType(client, companyId, documentType);

      // Tenant Management gap-fill Phase 1 item #10 — storage quota
      // enforcement. UsageService.getSummary() (TM-027/028) already
      // SURFACES storageUsedMb/storageQuotaMb from this exact same
      // SUM(size_bytes) query; this is the first place that actually
      // BLOCKS an upload once the tenant would go over quota, rather than
      // just reporting the number after the fact.
      const quotaRow = await client.query(
        `SELECT c.storage_quota_mb,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM employee_documents WHERE company_id = c.id) AS used_bytes
         FROM companies c WHERE c.id = $1`,
        [companyId]
      );
      const quotaMb = Number(quotaRow.rows[0].storage_quota_mb);
      const quotaBytes = quotaMb * 1024 * 1024;
      const usedBytes = Number(quotaRow.rows[0].used_bytes);
      if (usedBytes + file.size > quotaBytes) {
        throw new BadRequestException(
          `This upload would exceed the tenant's storage quota (${quotaMb} MB). Ask a Platform Admin to raise it, or remove unused documents first.`
        );
      }

      const stored = await this.fileStorage.save(companyId, employeeId, file.originalname, file.buffer);

      const result = await client.query(
        `INSERT INTO employee_documents
           (company_id, employee_id, document_type, file_name, mime_type, size_bytes, storage_path, uploaded_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [companyId, employeeId, documentType, file.originalname, file.mimetype, stored.sizeBytes, stored.storagePath, claims.sub]
      );
      return rowToDocument(result.rows[0]);
    });
  }

  async listDocuments(claims: RequestClaims, employeeId: string): Promise<EmployeeDocumentView[]> {
    // Viewing the vault's contents follows the same view-scope rules as
    // the employee record itself — if you can't see the employee, you
    // can't see what's attached to them either.
    await this.get(claims, employeeId);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_documents WHERE employee_id = $1 ORDER BY created_at ASC",
        [employeeId]
      );
      return result.rows.map(rowToDocument);
    });
  }

  async downloadDocument(
    claims: RequestClaims,
    employeeId: string,
    documentId: string
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    await this.get(claims, employeeId);
    const row = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_documents WHERE id = $1 AND employee_id = $2",
        [documentId, employeeId]
      );
      if (result.rowCount === 0) throw new NotFoundException("Document not found");
      return result.rows[0];
    });
    const buffer = await this.fileStorage.read(row.storage_path);
    return { buffer, fileName: row.file_name, mimeType: row.mime_type };
  }

  async addJobHistory(claims: RequestClaims, employeeId: string, input: RecordJobHistoryRequest): Promise<JobHistoryEntryView> {
    await this.requireModuleAndManagePermission(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await client.query("SELECT id, company_id FROM employees WHERE id = $1", [employeeId]);
      if (employee.rowCount === 0) throw new NotFoundException("Employee not found");

      const result = await client.query(
        `INSERT INTO employee_job_history
           (company_id, employee_id, event_type, effective_date, department, designation, salary_band, notes, recorded_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          employee.rows[0].company_id,
          employeeId,
          input.eventType,
          input.effectiveDate,
          input.department ?? null,
          input.designation ?? null,
          input.salaryBand ?? null,
          input.notes ?? null,
          claims.sub,
        ]
      );
      return rowToJobHistory(result.rows[0]);
    });
  }

  async listJobHistory(claims: RequestClaims, employeeId: string): Promise<JobHistoryEntryView[]> {
    await this.get(claims, employeeId);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_job_history WHERE employee_id = $1 ORDER BY effective_date ASC, created_at ASC",
        [employeeId]
      );
      return result.rows.map(rowToJobHistory);
    });
  }

  /**
   * Decision #12: creates a real login for an Employee record AND grants
   * it role(s) in one call — the tenant-scoped, HR-Admin-self-service
   * counterpart to the Platform-Admin-only `POST /platform/role-
   * assignments` endpoint. Before this existed, there was no way for an
   * HR Admin to onboard a real user without a Platform Admin or a
   * database console: `RoleAssignmentsController` is deliberately
   * Platform-Admin-only, and nothing else ever created a `user_accounts`
   * row for an `employees` record at all.
   *
   * Deliberately refuses to grant anything outside the three real tenant
   * roles (`TENANT_ROLE_KEYS`) — an HR Admin managing their own users
   * should never be able to reach for a Phase 4 `rbac_demo_*`
   * proof-of-concept role, which this endpoint's permission gate
   * (`employee.manage.all`) was never designed to authorize.
   *
   * RLS note: `user_accounts_insert` and `user_role_assignments_write`
   * both require `is_platform_admin() OR is_service()` — neither allows
   * a plain tenant session, by design (0002/0004's own header comments:
   * "the auth service itself can operate before either [real] identity
   * is established," and role-granting is meant to go through a trusted
   * gate, not any authenticated session). This method IS that trusted
   * gate: `requireModuleAndAccountPermission()` above already verified
   * the REAL caller holds `employee.manage.all` OR `user_account.manage.all`
   * (Decision #20 — a System Admin without full HR-Admin rights can still
   * provision logins) in their own company before any of this runs, so
   * the transaction below elevates to a `is_service` claims object — but
   * keeps the caller's own `company_id` on it (not a bare service claims
   * with none), so every company-scoped table's normal
   * `company_id = current_company_id()` RLS branch still applies.
   * Elevating to `is_service` bypasses that scoping for `employees`
   * specifically (its policy has an unconditional `is_service()` branch)
   * — so the employee lookup below filters on `company_id = $2`
   * explicitly rather than relying on RLS to do it, exactly the
   * discipline `is_service` code always needs.
   */
  async createLogin(
    claims: RequestClaims,
    employeeId: string,
    input: { initialPassword: string; roleKeys: string[] }
  ): Promise<{ employee: EmployeeView; rolesGranted: string[] }> {
    await this.requireModuleAndAccountPermission(claims);
    if (!claims.company_id) throw new ForbiddenException();

    const uniqueRoleKeys = Array.from(new Set(input.roleKeys));
    if (uniqueRoleKeys.length === 0) {
      throw new BadRequestException("At least one role must be granted");
    }
    const invalidRoleKeys = uniqueRoleKeys.filter((key) => !TENANT_ROLE_KEYS.includes(key as (typeof TENANT_ROLE_KEYS)[number]));
    if (invalidRoleKeys.length > 0) {
      throw new BadRequestException(`Cannot grant role(s): ${invalidRoleKeys.join(", ")}`);
    }

    const elevatedClaims: RequestClaims = {
      is_platform_admin: false,
      is_service: true,
      company_id: claims.company_id,
      sub: "employees-service",
    };

    return this.db.withClaims(elevatedClaims, async (client) => {
      const employeeResult = await client.query("SELECT * FROM employees WHERE id = $1 AND company_id = $2", [
        employeeId,
        claims.company_id,
      ]);
      if (employeeResult.rowCount === 0) throw new NotFoundException("Employee not found");
      const employee = employeeResult.rows[0];
      if (employee.user_account_id) {
        throw new ConflictException("This employee already has a login");
      }
      if (!employee.email) {
        throw new BadRequestException("Employee must have an email address before a login can be created");
      }

      // normalizeEmail() here for the same reason companies.service.ts's
      // createAdminLogin does it: employee.email was typed independently
      // (at hire/import time) from whatever the employee later types at
      // /login, and user_accounts.email is compared byte-for-byte — see
      // auth/email.util.ts.
      const passwordHash = await hashPassword(input.initialPassword);
      let userAccountId: string;
      try {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
          [normalizeEmail(employee.email), passwordHash]
        );
        userAccountId = account.rows[0].id;
      } catch (err) {
        // user_accounts.email is globally UNIQUE (Section 5) — a friendly
        // 409 instead of a raw constraint-violation 500, matching the
        // clarity every other module's duplicate-key path already has.
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`A login already exists for ${employee.email}`);
        }
        throw err;
      }

      await client.query("UPDATE employees SET user_account_id = $1, updated_at = now() WHERE id = $2", [
        userAccountId,
        employeeId,
      ]);

      for (const roleKey of uniqueRoleKeys) {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        if (role.rowCount === 0) throw new NotFoundException(`No role with key "${roleKey}"`);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, claims.company_id, role.rows[0].id]
        );
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee.login_created",
        target: employeeId,
        metadata: { roleKeys: uniqueRoleKeys },
      });

      const updated = await client.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
      return { employee: rowToEmployee(updated.rows[0]) as EmployeeView, rolesGranted: uniqueRoleKeys };
    });
  }

  /**
   * Organization Management Phase 1 (0065_organization_units.sql):
   * `employees.department` stays a plain text column for backward
   * compatibility (Employee Groups' legacy free-text condition matching,
   * reports, CSV import/export), but once an employee is linked to a
   * canonical org unit, that text is DERIVED from the unit's current
   * name rather than typed independently — otherwise the two would
   * silently drift apart the moment either one changed alone. An
   * employee with no `orgUnitId` at all keeps the pre-Phase-1 behavior
   * completely unchanged: whatever free text was given (or already on
   * the row) passes straight through.
   */
  private async resolveDepartment(
    client: PoolClient,
    companyId: string,
    orgUnitId: string | null | undefined,
    fallbackDepartment: string | null | undefined
  ): Promise<string | null> {
    if (!orgUnitId) return fallbackDepartment ?? null;
    const orgUnit = await client.query<{ name: string }>(
      "SELECT name FROM org_units WHERE id = $1 AND company_id = $2",
      [orgUnitId, companyId]
    );
    if (orgUnit.rowCount === 0) {
      throw new BadRequestException("Org unit not found");
    }
    return orgUnit.rows[0].name;
  }

  /**
   * Organization Management Phase 4 (0073_locations_and_financial_centers.sql):
   * the exact same backward-compatibility relationship `resolveDepartment()`
   * above established for `department`/`orgUnitId`, replicated for
   * `location`/`locationId`. `employees.location` stays a plain text column
   * (legacy free-text, still read by reports/CSV import-export and by
   * Employee Groups' `department`-style OR-matching), but once an employee
   * is linked to a canonical location, that text is DERIVED from the
   * location's current name rather than typed independently. An employee
   * with no `locationId` at all keeps the pre-Phase-4 behavior completely
   * unchanged: whatever free text was given (or already on the row) passes
   * straight through.
   */
  private async resolveLocation(
    client: PoolClient,
    companyId: string,
    locationId: string | null | undefined,
    fallbackLocation: string | null | undefined
  ): Promise<string | null> {
    if (!locationId) return fallbackLocation ?? null;
    const location = await client.query<{ name: string }>(
      "SELECT name FROM locations WHERE id = $1 AND company_id = $2",
      [locationId, companyId]
    );
    if (location.rowCount === 0) {
      throw new BadRequestException("Location not found");
    }
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

  /**
   * Cross-module integration audit (2026-10-01), gap #3/#7 — Data Scope
   * write-side sibling of `requireModuleAndManagePermission()`, used only
   * by `update()` (hence also termination, which is just `update()` with
   * `employmentStatus: "terminated"`). `.manage.all` wins outright
   * (unrestricted, every other method on this service is unaffected);
   * otherwise a caller holding only `employee.manage.scoped` gets back
   * their assigned org-unit subtree and location subtree ids, checked
   * against the SPECIFIC employee being written by
   * `assertInManageScope()` below; otherwise (neither) throws — same
   * fail-closed posture `PositionsService.resolveManageAccess()`
   * established for this same gap.
   */
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

  /** Throws unless `record` (the employee's CURRENT, or a patch's
   * PROPOSED, org unit / location) falls inside `scope` — called once for
   * the existing row and, when a patch would change either field, once
   * more for the new values, so a scoped caller can neither touch an
   * employee outside their region nor move one into/out of it. */
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

  /** Every assigned org-unit id plus all of its descendants — the same
   * duplicated-rather-than-injected recursive CTE
   * `PositionsService.expandOrgUnitIdsToSubtree()` already established
   * for this identical gap, so this module doesn't need a reverse import
   * of OrganizationModule just for this one query. */
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

  /** Every assigned location id plus all of its descendants — same shape
   * as `expandOrgUnitIdsToSubtree()` immediately above, over `locations`'
   * own `parent_id` hierarchy (`LocationsService`'s own subtree query). */
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

  /**
   * Decision #20 (Task #52) — `createLogin()`'s own gate, deliberately
   * separate from `requireModuleAndManagePermission()` above: every OTHER
   * method on this service (create/update/addDocument/addJobHistory)
   * keeps requiring the broader `employee.manage.all` unchanged. Only
   * login provisioning also accepts `user_account.manage.all`, so a
   * System Admin — who holds that permission but deliberately no
   * `employee.*` permission at all (0024_system_admin.sql's role
   * description) — can create a login for an existing employee without
   * being granted full HR-Admin rights over employee records just to do
   * it. `employee` module licensing is still required either way: a
   * login is meaningless for a record the tenant isn't even licensed to
   * have.
   */
  private async requireModuleAndAccountPermission(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canManageEmployees, canManageAccounts] = await Promise.all([
      this.rbac.can(claims, MANAGE_PERMISSION),
      this.rbac.can(claims, ACCOUNT_PERMISSION),
    ]);
    if (!canManageEmployees && !canManageAccounts) {
      throw new ForbiddenException("Not permitted to create a login for this employee");
    }
  }

  /**
   * Employee Number assignment (plan doc Section 5). The format
   * (prefix/padding/startingSequence) is a plain read from
   * `company_config` — that table's existing RLS already allows a
   * tenant-scoped SELECT. The actual counter lives in the separate
   * `employee_number_sequences` table (see 0010_employee_core.sql's
   * header comment for why: `FOR UPDATE` under RLS also requires the
   * table's UPDATE policy to pass, and company_config's is deliberately
   * Platform-Admin-only). Runs inside the caller's own transaction (the
   * `client` from `withClaims`) with a row lock on that counter row — two
   * concurrent hires in the same company serialize on it rather than
   * racing for the same sequence value, the same "safe under concurrency"
   * bar the workflow engine's SLA sweep already holds itself to. The
   * counter row is lazily created (`ON CONFLICT DO NOTHING`) from the
   * format's own `startingSequence` the first time a company ever hires
   * through this path, rather than requiring CompaniesService to know
   * this table exists.
   */
  private async assignEmployeeNumber(client: PoolClient, companyId: string, explicitNumber?: string): Promise<string> {
    const configResult = await client.query<{ employee_number_format: EmployeeNumberFormat }>(
      "SELECT employee_number_format FROM company_config WHERE company_id = $1",
      [companyId]
    );
    if (configResult.rowCount === 0) throw new NotFoundException("Company config not found");
    const format = configResult.rows[0].employee_number_format;

    await client.query(
      "INSERT INTO employee_number_sequences (company_id, next_sequence) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING",
      [companyId, Math.max(1, format.startingSequence ?? 1)]
    );
    const sequenceResult = await client.query<{ next_sequence: number }>(
      "SELECT next_sequence FROM employee_number_sequences WHERE company_id = $1 FOR UPDATE",
      [companyId]
    );
    const currentSequence = sequenceResult.rows[0].next_sequence;

    if (explicitNumber) {
      // Preserve-imported-numbers path — see employee-number.util.ts's
      // doc comment. Advance the counter past this number only if it's
      // both in this tenant's own format AND ahead of where the counter
      // already is (never move it backwards).
      const parsedSequence = parseEmployeeNumberSequence(explicitNumber, format);
      if (parsedSequence !== null && parsedSequence >= currentSequence) {
        await client.query("UPDATE employee_number_sequences SET next_sequence = $2 WHERE company_id = $1", [
          companyId,
          parsedSequence + 1,
        ]);
      }
      return explicitNumber;
    }

    await client.query("UPDATE employee_number_sequences SET next_sequence = $2 WHERE company_id = $1", [
      companyId,
      currentSequence + 1,
    ]);
    return formatEmployeeNumber(format, currentSequence);
  }

  /**
   * Job history stays accurate without every caller having to remember to
   * call `addJobHistory()` separately after every relevant `update()` —
   * termination, a designation change (promotion), a department change
   * (transfer), and a salary-band change each get their own auto-logged
   * entry. A plain contact-info edit (phone/email) intentionally logs
   * nothing — not every field on this object is a "job" fact.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async autoRecordJobHistory(client: PoolClient, claims: RequestClaims, before: any, after: any): Promise<void> {
    let eventType: JobHistoryEventType | null = null;
    if (before.employment_status !== "terminated" && after.employment_status === "terminated") {
      eventType = "termination";
    } else if (before.designation !== after.designation) {
      eventType = "promotion";
    } else if (before.department !== after.department) {
      eventType = "transfer";
    } else if (before.salary_band !== after.salary_band) {
      eventType = "salary_change";
    }
    if (!eventType) return;

    await client.query(
      `INSERT INTO employee_job_history
         (company_id, employee_id, event_type, effective_date, department, designation, salary_band, notes, recorded_by_user_account_id)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8)`,
      [
        after.company_id,
        after.id,
        eventType,
        after.department,
        after.designation,
        after.salary_band,
        eventType === "termination" ? after.termination_reason : null,
        claims.sub,
      ]
    );

    // Phase 3 item #4 — the second of this rollout's 2 real webhook
    // trigger points (see this class's own doc comment). Fire-and-forget,
    // same reasoning as `create()`'s `employee.created`: a webhook target
    // must never make an HR admin's update() call fail or hang.
    if (eventType === "termination") {
      this.webhooks
        ?.enqueue(after.company_id, "employee.terminated", { employee: rowToEmployee(after) })
        .catch(() => undefined);
    }
  }
}
