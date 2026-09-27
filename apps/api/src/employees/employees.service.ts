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
import { listFieldSensitivity, restrictedFieldsExposed } from "./employee-field-sensitivity";
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
// Decision #20 (Task #52) — lets a System Admin (who does not hold
// employee.manage.all) provision logins too, without granting them full
// HR-Admin employee-management rights. See requireModuleAndAccountPermission().
const ACCOUNT_PERMISSION = "user_account.manage.all";
const SENSITIVE_FIELDS = ["cnic", "dateOfBirth", "salaryBand", "bankAccountNumber", "terminationReason"] as const;
// Decision #12, widened by Decision #20 — the only roles `createLogin()`
// is allowed to grant. Deliberately excludes the Phase 4 `rbac_demo_*`
// proof-of-concept roles. `system_admin` was added here so an HR Admin
// creating a brand-new login can grant System Admin at the same time,
// rather than needing a separate Platform-Admin-mediated step afterward —
// see 0024_system_admin.sql's own "Bootstrap note".
const TENANT_ROLE_KEYS = ["hr_admin", "line_manager", "employee_self_service", "system_admin"] as const;
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
    private readonly importExport: ImportExportService = new ImportExportService()
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeeRequest): Promise<EmployeeView> {
    await this.requireModuleAndManagePermission(claims);
    if (!claims.company_id) throw new ForbiddenException();

    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
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

    const imported: EmployeeView[] = [];
    for (const row of parsedRows) {
      imported.push(await this.create(claims, row));
    }
    return { imported: imported.length, rows: imported, errors };
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
      const [scope, fieldRules, result] = await Promise.all([
        this.rbac.resolveViewScope(claims, VIEW_PERMISSION),
        this.rbac.loadFieldPermissionRules(claims, OBJECT_KEY, SENSITIVE_FIELDS),
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
          claims.sub
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

      const [scope, fieldRules] = await Promise.all([
        this.rbac.resolveViewScope(claims, VIEW_PERMISSION),
        this.rbac.loadFieldPermissionRules(claims, OBJECT_KEY, SENSITIVE_FIELDS),
      ]);
      const employee = rowToEmployee(row);
      const filtered = this.rbac.filterRecordFieldsWithScope(
        scope,
        fieldRules,
        employee,
        SENSITIVE_FIELDS,
        row.user_account_id,
        row.manager_user_account_id,
        claims.sub
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
    await this.requireModuleAndManagePermission(claims);

    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM employees WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Employee not found");
      const before = current.rows[0];

      if (patch.employmentStatus === "terminated" && !patch.terminationDate && !before.termination_date) {
        throw new BadRequestException("terminationDate is required when setting employmentStatus to terminated");
      }

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
