import { localToday } from "../common/local-date";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  ApproveEmployeeLoanRequestInput,
  ApproveLeaveEncashmentInput,
  EncashableLeaveView,
  EmployeeLetterType,
  EmployeeServiceRequestKind,
  EmployeeServiceRequestStatus,
  EmployeeServiceRequestView,
  IssueSalaryCertificateInput,
  RequestableLoanTypeView,
  SubmitEmployeeServiceRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { LeaveLedgerService } from "../leave/leave-ledger.service";
import { loadSettlementSettings } from "../payroll/payroll-schemes.service";
import { EmployeesService } from "../employees/employees.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { PayrollDocumentsService } from "../payroll/payroll-documents.service";
import { RbacService } from "../rbac/rbac.service";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const MAX_PENDING_PER_EMPLOYEE = 5;
const KINDS: EmployeeServiceRequestKind[] = ["loan", "salary_advance", "letter", "leave_encashment"];
const STATUSES: EmployeeServiceRequestStatus[] = ["pending", "fulfilled", "rejected", "cancelled"];
export const LETTER_TYPES: Record<EmployeeLetterType, string> = {
  salary_certificate: "Salary certificate",
  employment_letter: "Employment letter",
  experience_letter: "Experience letter",
  noc: "No objection certificate (NOC)",
  address_proof: "Address proof letter",
  other: "Other letter",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v?.toISOString ? v.toISOString() : v ?? null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10)) : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(r: any): EmployeeServiceRequestView {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeNumber: r.employee_number,
    employeeName: `${r.first_name} ${r.last_name}`.trim(),
    kind: r.request_kind,
    status: r.status,
    purpose: r.purpose,
    neededBy: day(r.needed_by),
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    installmentsCount: r.installments_count ?? null,
    loanTypeId: r.loan_type_id ?? null,
    loanTypeName: r.loan_type_name ?? null,
    letterType: r.letter_type ?? null,
    addressedTo: r.addressed_to ?? null,
    decisionNote: r.decision_note ?? null,
    decidedAt: iso(r.decided_at),
    loanId: r.loan_id ?? null,
    generatedDocumentId: r.generated_document_id ?? null,
    employeeDocumentId: r.employee_document_id ?? null,
    leaveType: r.leave_type ?? null,
    leaveTypeName: r.leave_type_name ?? null,
    leaveDays: r.leave_days === null || r.leave_days === undefined ? null : Number(r.leave_days),
    additionalPaymentId: r.additional_payment_id ?? null,
    createdAt: iso(r.created_at) as string,
  };
}

const SELECT = `
  SELECT r.*, e.employee_number, e.first_name, e.last_name, lt.name AS loan_type_name, lvt.name AS leave_type_name
    FROM employee_service_requests r
    JOIN employees e ON e.id = r.employee_id
    LEFT JOIN loan_types lt ON lt.id = r.loan_type_id
    LEFT JOIN leave_types lvt ON lvt.company_id = r.company_id AND lvt.code = r.leave_type`;

const labelOf = (r: { request_kind: string; letter_type?: string | null; amount?: unknown; leave_days?: unknown }) =>
  r.request_kind === "letter"
    ? LETTER_TYPES[(r.letter_type ?? "other") as EmployeeLetterType]
    : r.request_kind === "leave_encashment"
      ? `Leave encashment of ${Number(r.leave_days)} day${Number(r.leave_days) === 1 ? "" : "s"}`
      : `${r.request_kind === "loan" ? "Loan" : "Salary advance"} of ${Number(r.amount).toLocaleString("en-PK")}`;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * BACKLOG52 - employee requests to HR: a loan or salary advance, and a letter or certificate. The employee asks through
 * their own login (employee.view.self, no new permission); HR (employee.manage.all) decides. Approving a loan creates it
 * through EmployeeLoansService so the loan type limits, guarantor rule and any approval template still apply. A salary
 * certificate is generated from the current salary and published to the employee's payroll documents; any other letter is
 * uploaded into the employee's document vault.
 */
@Injectable()
export class EmployeeRequestsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly loans: EmployeeLoansService,
    private readonly employees: EmployeesService,
    private readonly payrollDocs: PayrollDocumentsService,
    private readonly inbox?: UserNotificationsService,
    private readonly additionalPayments?: EmployeeAdditionalPaymentsService,
    private readonly leaveLedger?: LeaveLedgerService
  ) {}

  // ------------------------------------------------------------------ employee side

  async requestableLoanTypes(claims: RequestClaims): Promise<RequestableLoanTypeView[]> {
    await this.requireModule(claims);
    await this.requireSelf(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT id, name, kind, max_installments, requires_guarantor, description
           FROM loan_types WHERE is_active = true ORDER BY sort_order, name`
      );
      return r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        kind: x.kind,
        maxInstallments: x.max_installments ?? null,
        requiresGuarantor: !!x.requires_guarantor,
        description: x.description ?? null,
      }));
    });
  }

  /** What the signed-in employee can encash: encashable leave types with days left this year. */
  async encashableLeave(claims: RequestClaims): Promise<EncashableLeaveView> {
    await this.requireModule(claims);
    await this.requireSelf(claims);
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.myEmployee(client, claims);
      return this.encashableFor(client, emp.id);
    });
  }

  private async encashableFor(client: PoolClient, employeeId: string): Promise<EncashableLeaveView> {
    const settings = await loadSettlementSettings(client);
    if (!settings.leaveEncashmentEnabled) return { enabled: false, items: [] };
    const r = await client.query(
      `SELECT t.code, t.name, (b.entitled_days - b.used_days) AS remaining
         FROM leave_balances b JOIN leave_types t ON t.company_id = b.company_id AND t.code = b.leave_type
        WHERE b.employee_id = $1 AND b.year = $2 AND t.encashable AND t.is_active AND (b.entitled_days - b.used_days) > 0
        ORDER BY t.name`,
      [employeeId, Number(localToday().slice(0, 4))]
    );
    return { enabled: true, items: r.rows.map((x) => ({ code: x.code, name: x.name, remainingDays: Number(x.remaining) })) };
  }

  async submit(claims: RequestClaims, input: SubmitEmployeeServiceRequest): Promise<EmployeeServiceRequestView> {
    await this.requireModule(claims);
    await this.requireSelf(claims);
    if (!KINDS.includes(input.kind)) throw new BadRequestException("Choose what you are asking for");
    const purpose = (input.purpose ?? "").trim();
    if (!purpose) throw new BadRequestException("Tell HR why you need it");
    if (purpose.length > 1000) throw new BadRequestException("Keep the reason under 1000 characters");
    if (input.neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(input.neededBy)) throw new BadRequestException("Needed-by must be a valid date");

    const isEncashment = input.kind === "leave_encashment";
    const isLoan = input.kind === "loan" || input.kind === "salary_advance";
    if (isEncashment) {
      if (!input.leaveType) throw new BadRequestException("Choose which leave you want to encash");
      const d = Number(input.leaveDays);
      if (!(d > 0) || Math.round(d * 2) !== d * 2) throw new BadRequestException("Enter the days to encash, in whole or half days");
    } else if (isLoan) {
      if (!(Number(input.amount) > 0)) throw new BadRequestException("Enter the amount you need");
      if (input.installmentsCount !== undefined && (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1 || input.installmentsCount > 600)) {
        throw new BadRequestException("Instalments must be a whole number between 1 and 600");
      }
    } else if (input.kind === "letter" && (!input.letterType || !(input.letterType in LETTER_TYPES))) {
      throw new BadRequestException("Choose which letter or certificate you need");
    }

    const result = await this.db.withClaims(claims, async (client) => {
      const emp = await this.myEmployee(client, claims);
      const pending = await client.query("SELECT COUNT(*)::int AS n FROM employee_service_requests WHERE employee_id = $1 AND status = 'pending'", [emp.id]);
      if (pending.rows[0].n >= MAX_PENDING_PER_EMPLOYEE) {
        throw new BadRequestException(`You already have ${MAX_PENDING_PER_EMPLOYEE} requests waiting for HR. Wait for a decision or withdraw one first.`);
      }
      if (isEncashment) {
        const opts = await this.encashableFor(client, emp.id);
        if (!opts.enabled) throw new BadRequestException("Leave encashment is not switched on for your company");
        const item = opts.items.find((i) => i.code === input.leaveType);
        if (!item) throw new BadRequestException("That leave type cannot be encashed");
        const waiting = await client.query(
          "SELECT COALESCE(SUM(leave_days), 0) AS d FROM employee_service_requests WHERE employee_id = $1 AND status = 'pending' AND request_kind = 'leave_encashment' AND leave_type = $2",
          [emp.id, input.leaveType]
        );
        const free = r2(item.remainingDays - Number(waiting.rows[0].d));
        if (Number(input.leaveDays) > free) throw new BadRequestException(`You can ask for at most ${free} day${free === 1 ? "" : "s"} of ${item.name} (days already requested are counted)`);
      }
      if (isLoan && input.loanTypeId) {
        const t = await client.query("SELECT kind, is_active FROM loan_types WHERE id = $1", [input.loanTypeId]);
        if (!t.rowCount || !t.rows[0].is_active) throw new BadRequestException("That loan type is not available");
        if (t.rows[0].kind !== input.kind) throw new BadRequestException(`That type is a ${String(t.rows[0].kind).replace("_", " ")}, not a ${input.kind.replace("_", " ")}`);
      }
      const ins = await client.query(
        `INSERT INTO employee_service_requests
           (company_id, employee_id, request_kind, loan_type_id, amount, installments_count, letter_type, addressed_to, purpose, needed_by, requested_by_user_account_id, leave_type, leave_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          emp.company_id, emp.id, input.kind,
          isLoan ? input.loanTypeId ?? null : null,
          isLoan ? Number(input.amount) : null,
          isLoan ? input.installmentsCount ?? null : null,
          input.kind === "letter" ? input.letterType : null,
          input.kind === "letter" ? (input.addressedTo ?? "").trim().slice(0, 200) || null : null,
          purpose, input.neededBy ?? null, claims.sub,
          isEncashment ? input.leaveType : null,
          isEncashment ? Number(input.leaveDays) : null,
        ]
      );
      const view = await this.view(client, ins.rows[0].id);
      await this.audit.record(client, claims, {
        companyId: emp.company_id,
        action: "employee_service_request.submit",
        target: view.id,
        metadata: { kind: input.kind, letterType: input.letterType ?? null, amount: isLoan ? Number(input.amount) : null, leaveType: input.leaveType ?? null, leaveDays: isEncashment ? Number(input.leaveDays) : null },
      });
      return view;
    });

    if (this.inbox && claims.company_id) {
      await this.inbox.notify({
        companyId: claims.company_id,
        userAccountIds: await this.inbox.hrAdminUserIds(claims.company_id),
        category: "hr_inbox",
        title: `${result.employeeName} asked for ${result.kind === "letter" ? `a ${LETTER_TYPES[result.letterType!].toLowerCase()}` : result.kind === "loan" ? "a loan" : result.kind === "leave_encashment" ? `leave encashment (${result.leaveDays} day${result.leaveDays === 1 ? "" : "s"})` : "a salary advance"}`,
        body: result.purpose,
        link: "/app/employees/requests",
      });
    }
    return result;
  }

  async listMine(claims: RequestClaims): Promise<EmployeeServiceRequestView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`${SELECT} WHERE e.user_account_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [claims.sub]);
      return r.rows.map(rowToView);
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<EmployeeServiceRequestView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.load(client, id);
      if (row.employee_user_account_id !== claims.sub) throw new NotFoundException("Request not found");
      if (row.status !== "pending") throw new BadRequestException("Only a request that is still waiting can be withdrawn");
      await client.query("UPDATE employee_service_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: row.company_id, action: "employee_service_request.cancel", target: id, metadata: { kind: row.request_kind } });
      return this.view(client, id);
    });
  }

  // ------------------------------------------------------------------ HR side

  async list(claims: RequestClaims, filter: { status?: string; kind?: string } = {}): Promise<EmployeeServiceRequestView[]> {
    await this.requireManage(claims);
    const status = STATUSES.includes(filter.status as EmployeeServiceRequestStatus) ? filter.status : null;
    const kind = KINDS.includes(filter.kind as EmployeeServiceRequestKind) ? filter.kind : null;
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `${SELECT} WHERE r.company_id = $1 AND ($2::text IS NULL OR r.status = $2) AND ($3::text IS NULL OR r.request_kind = $3)
          ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 300`,
        [claims.company_id, status, kind]
      );
      return r.rows.map(rowToView);
    });
  }

  async reject(claims: RequestClaims, id: string, note: string): Promise<EmployeeServiceRequestView> {
    await this.requireManage(claims);
    const why = (note ?? "").trim();
    if (!why) throw new BadRequestException("Tell the employee why this was not approved");
    const view = await this.db.withClaims(claims, async (client) => {
      const row = await this.loadPending(client, id);
      await client.query(
        "UPDATE employee_service_requests SET status = 'rejected', decided_by_user_account_id = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1",
        [id, claims.sub, why.slice(0, 1000)]
      );
      await this.audit.record(client, claims, { companyId: row.company_id, action: "employee_service_request.reject", target: id, metadata: { kind: row.request_kind } });
      return this.view(client, id);
    });
    await this.tellEmployee(claims, id, false);
    return view;
  }

  /** Approving creates the real loan. If the loan cannot be created (a limit, a missing guarantor) the request stays open. */
  async approveLoan(claims: RequestClaims, id: string, input: ApproveEmployeeLoanRequestInput = {}): Promise<EmployeeServiceRequestView> {
    await this.requireManage(claims);
    const row = await this.db.withClaims(claims, (client) => this.loadPending(client, id));
    if (row.request_kind === "letter") throw new BadRequestException("This is a letter request. Issue the letter instead.");
    if (row.request_kind === "leave_encashment") throw new BadRequestException("This is a leave encashment request. Approve it as an encashment instead.");
    const installmentsCount = input.installmentsCount ?? row.installments_count ?? undefined;
    if (installmentsCount === undefined) throw new BadRequestException("Give the number of instalments");
    const today = localToday();
    const loan = await this.loans.create(claims, {
      employeeId: row.employee_id,
      loanType: row.request_kind,
      reason: row.purpose,
      principalAmount: input.principalAmount ?? Number(row.amount),
      installmentsCount,
      issuedDate: input.issuedDate ?? today,
      deductionStartDate: input.deductionStartDate,
      loanTypeId: input.loanTypeId ?? row.loan_type_id ?? undefined,
      guarantorEmployeeId: input.guarantorEmployeeId,
    });
    const view = await this.db.withClaims(claims, async (client) => {
      const upd = await client.query(
        `UPDATE employee_service_requests
            SET status = 'fulfilled', loan_id = $2, decided_by_user_account_id = $3, decided_at = now(), decision_note = $4, updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id, loan.id, claims.sub, input.note?.trim().slice(0, 1000) || null]
      );
      if (!upd.rowCount) return null;
      await this.audit.record(client, claims, {
        companyId: row.company_id, action: "employee_service_request.approve_loan", target: id, metadata: { loanId: loan.id, principalAmount: loan.principalAmount },
      });
      return this.view(client, id);
    });
    if (!view) {
      // someone else decided it while the loan was being created: do not leave a second loan behind
      await this.loans.cancel(claims, loan.id, { reason: "Duplicate of a request that was already decided" });
      throw new ConflictException("This request was already decided by someone else");
    }
    await this.tellEmployee(claims, id, true);
    return view;
  }

  /**
   * Approving a leave encashment queues a payslip payment for the employee and takes the days off the balance.
   * The amount is days x the daily rate from the settlement settings unless HR types one. If the payment cannot be
   * queued the request stays open.
   */
  async approveEncashment(claims: RequestClaims, id: string, input: ApproveLeaveEncashmentInput = {}): Promise<EmployeeServiceRequestView> {
    await this.requireManage(claims);
    if (!this.additionalPayments || !this.leaveLedger) throw new BadRequestException("Leave encashment is not available");
    const ledger = this.leaveLedger;
    const today = localToday();
    if (input.effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)) throw new BadRequestException("Pay date must be a valid date");
    const prep = await this.db.withClaims(claims, async (client) => {
      const row = await this.loadPending(client, id);
      if (row.request_kind !== "leave_encashment") throw new BadRequestException("This is not a leave encashment request");
      const days = Number(row.leave_days);
      const year = Number((input.effectiveDate ?? today).slice(0, 4));
      const bal = await client.query(
        "SELECT (entitled_days - used_days) AS remaining FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3",
        [row.employee_id, row.leave_type, year]
      );
      const remaining = bal.rowCount ? Number(bal.rows[0].remaining) : 0;
      if (remaining < days) throw new BadRequestException(`The employee now has only ${remaining} day${remaining === 1 ? "" : "s"} of this leave left. Reject the request or ask for fewer days.`);
      const settings = await loadSettlementSettings(client);
      if (!settings.leaveEncashmentEnabled) throw new BadRequestException("Leave encashment is not switched on in the settlement settings");
      let amount = input.amount;
      if (amount === undefined || amount === null) {
        const rate = await this.dailyRate(client, row.employee_id, settings, today);
        if (rate === null) throw new BadRequestException("Enter the amount: the daily rate cannot be worked out (set the daily-rate base and divisor in the settlement settings, or type the amount)");
        amount = r2(days * rate);
      }
      if (!(Number(amount) > 0)) throw new BadRequestException("The amount must be more than zero");
      return { row, days, year, amount: r2(Number(amount)), taxable: settings.leaveEncashmentTaxable };
    });
    const pay = await this.additionalPayments.create(claims, {
      employeeId: prep.row.employee_id,
      paymentType: "earning",
      label: `Leave encashment (${prep.days} day${prep.days === 1 ? "" : "s"})`,
      amount: prep.amount,
      isTaxable: prep.taxable,
      effectiveDate: input.effectiveDate ?? today,
      reasonNote: prep.row.purpose,
    });
    const view = await this.db.withClaims(claims, async (client) => {
      const upd = await client.query(
        `UPDATE employee_service_requests
            SET status = 'fulfilled', amount = $2, additional_payment_id = $3, decided_by_user_account_id = $4, decided_at = now(), decision_note = $5, updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id, prep.amount, pay.id, claims.sub, input.note?.trim().slice(0, 1000) || null]
      );
      if (!upd.rowCount) return null;
      await ledger.post(client, {
        companyId: prep.row.company_id, employeeId: prep.row.employee_id, leaveType: prep.row.leave_type, year: prep.year, entryType: "encashment", days: -prep.days,
        effectiveDate: input.effectiveDate ?? today, sourceType: "leave_encashment_request", sourceId: id, sourceKey: `encash:${id}`, reason: "Encashed on request", createdBy: claims.sub,
      });
      await this.audit.record(client, claims, {
        companyId: prep.row.company_id, action: "employee_service_request.approve_encashment", target: id, metadata: { days: prep.days, amount: prep.amount, additionalPaymentId: pay.id },
      });
      return this.view(client, id);
    });
    if (!view) {
      await this.additionalPayments.cancel(claims, pay.id);
      throw new ConflictException("This request was already decided by someone else");
    }
    await this.tellEmployee(claims, id, true);
    return view;
  }

  /** One day's pay from the settlement settings: the monthly figure the tenant chose, over its divisor. */
  private async dailyRate(client: PoolClient, employeeId: string, settings: { dailyRateBase: string | null; dailyRateDivisor: number | null }, onDate: string): Promise<number | null> {
    if (!settings.dailyRateBase || !settings.dailyRateDivisor) return null;
    const where = settings.dailyRateBase === "gross_earnings" ? "cc.component_type = 'earning'" : "cc.key = 'basic_salary'";
    const r = await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(ecc.amount), 0) AS total
         FROM employee_compensation_components ecc JOIN compensation_components cc ON cc.id = ecc.component_id
        WHERE ecc.employee_id = $1 AND ecc.effective_from <= $2::date AND (ecc.effective_to IS NULL OR ecc.effective_to >= $2::date) AND ${where}`,
      [employeeId, onDate]
    );
    return r.rows[0].n > 0 ? Number(r.rows[0].total) / settings.dailyRateDivisor : null;
  }

  /** Generates the salary certificate from the employee's current earnings and publishes it to their payroll documents. */
  async issueSalaryCertificate(claims: RequestClaims, id: string, input: IssueSalaryCertificateInput = {}): Promise<EmployeeServiceRequestView> {
    await this.requireManage(claims);
    const row = await this.db.withClaims(claims, (client) => this.loadPending(client, id));
    if (row.letter_type !== "salary_certificate") throw new BadRequestException("Only a salary certificate request can be generated from payroll");
    const doc = await this.payrollDocs.generateSalaryCertificate(claims, { employeeId: row.employee_id, addressedTo: row.addressed_to ?? undefined, purpose: row.purpose });
    await this.payrollDocs.setPublication(claims, doc.id, true);
    return this.finishLetter(claims, id, row, { generatedDocumentId: doc.id }, input.note);
  }

  /** Any letter: HR uploads the signed document and it appears in the employee's own documents. */
  async issueLetter(
    claims: RequestClaims,
    id: string,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    note?: string
  ): Promise<EmployeeServiceRequestView> {
    if (!file) throw new BadRequestException("Choose a file to upload");
    await this.requireManage(claims);
    if (!file) throw new BadRequestException("Choose the signed letter to upload");
    const row = await this.db.withClaims(claims, (client) => this.loadPending(client, id));
    if (row.request_kind !== "letter") throw new BadRequestException("This is not a letter request");
    const label = LETTER_TYPES[row.letter_type as EmployeeLetterType];
    const stored = await this.employees.addDocument(claims, row.employee_id, row.letter_type === "experience_letter" ? "experience_letter" : "other", file, {
      note: `${label} issued by HR`,
    });
    return this.finishLetter(claims, id, row, { employeeDocumentId: stored.id }, note);
  }

  // ------------------------------------------------------------------ internals

  private async finishLetter(
    claims: RequestClaims,
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any,
    link: { generatedDocumentId?: string; employeeDocumentId?: string },
    note?: string
  ): Promise<EmployeeServiceRequestView> {
    const view = await this.db.withClaims(claims, async (client) => {
      const upd = await client.query(
        `UPDATE employee_service_requests
            SET status = 'fulfilled', generated_document_id = $2, employee_document_id = $3,
                decided_by_user_account_id = $4, decided_at = now(), decision_note = $5, updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id, link.generatedDocumentId ?? null, link.employeeDocumentId ?? null, claims.sub, note?.trim().slice(0, 1000) || null]
      );
      if (!upd.rowCount) throw new ConflictException("This request was already decided by someone else");
      await this.audit.record(client, claims, {
        companyId: row.company_id, action: "employee_service_request.issue_letter", target: id, metadata: { letterType: row.letter_type, ...link },
      });
      return this.view(client, id);
    });
    await this.tellEmployee(claims, id, true);
    return view;
  }

  private async tellEmployee(claims: RequestClaims, id: string, approved: boolean): Promise<void> {
    if (!this.inbox || !claims.company_id) return;
    const row = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT r.request_kind, r.letter_type, r.amount, r.decision_note, e.user_account_id
           FROM employee_service_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1`,
        [id]
      );
      return r.rows[0];
    });
    if (!row) return;
    const what = labelOf(row);
    await this.inbox.notify({
      companyId: claims.company_id,
      userAccountIds: [row.user_account_id],
      category: "request_decisions",
      title: approved ? (row.request_kind === "letter" ? `Your ${what.toLowerCase()} is ready` : `HR approved your ${what.toLowerCase()}`) : `HR did not approve your ${what.toLowerCase()}`,
      body: row.decision_note ?? (approved && row.request_kind === "letter" ? "Open My HR Requests to read it." : ""),
      link: "/app/ess/requests",
    });
  }

  private async myEmployee(client: PoolClient, claims: RequestClaims) {
    const r = await client.query(
      `SELECT id, company_id FROM employees WHERE user_account_id = $1
        ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1`,
      [claims.sub]
    );
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string; company_id: string };
  }

  private async view(client: PoolClient, id: string): Promise<EmployeeServiceRequestView> {
    const r = await client.query(`${SELECT} WHERE r.id = $1`, [id]);
    return rowToView(r.rows[0]);
  }

  private async load(client: PoolClient, id: string) {
    const r = await client.query(
      `SELECT r.*, e.user_account_id AS employee_user_account_id FROM employee_service_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1`,
      [id]
    );
    if (!r.rowCount) throw new NotFoundException("Request not found");
    return r.rows[0];
  }

  private async loadPending(client: PoolClient, id: string) {
    const row = await this.load(client, id);
    if (row.status !== "pending") throw new ConflictException(`This request is already ${row.status}`);
    return row;
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireSelf(claims: RequestClaims): Promise<void> {
    if (!(await this.rbac.can(claims, "employee.view.self", { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted to send requests to HR");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to handle employee requests");
  }
}
