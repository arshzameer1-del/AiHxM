import { assertValidIban } from "../crypto/identifier-validation";
import { sensitive } from "../crypto/sensitive-fields";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  CreateEmployeePaymentAccountRequest,
  EmployeePaymentAccountView,
  UpdateEmployeePaymentAccountRequest,
} from "@aihxm/shared-types";
import { maskTail, requireViewOrSelf } from "./employee-self-read";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDate(value: any): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    // pg parses `date` at local midnight: read local components so a non-UTC server does not shift the day
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): EmployeePaymentAccountView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    paymentMethod: row.payment_method,
    bankName: row.bank_name,
    accountTitle: row.account_title,
    accountNumber: sensitive.decrypt(row.company_id, row.account_number),
    iban: sensitive.decrypt(row.company_id, row.iban),
    branchCode: row.branch_code,
    isPrimary: row.is_primary,
    status: row.status,
    validFrom: toDate(row.valid_from) as string,
    validTo: toDate(row.valid_to),
    priority: row.priority,
    splitPercent: row.split_percent === null || row.split_percent === undefined ? null : Number(row.split_percent),
    currency: row.currency,
    bankKey: row.bank_key ?? null,
    bankCountry: row.bank_country,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at ? toIso(row.verified_at) : null,
    approvalStatus: row.approval_status,
    submittedByUserAccountId: row.submitted_by_user_account_id ?? null,
    approvedByUserAccountId: row.approved_by_user_account_id ?? null,
    approvedAt: row.approved_at ? toIso(row.approved_at) : null,
    rejectionReason: row.rejection_reason ?? null,
    replacesAccountId: row.replaces_account_id ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Fields whose change redirects money: on an APPROVED PRIMARY account they require a second person's approval (EMP-08). */
const PAYMENT_CRITICAL_FIELDS = ["paymentMethod", "bankName", "accountTitle", "accountNumber", "iban", "branchCode", "bankKey", "bankCountry"] as const;

export type PaymentAccountWriteOptions = {
  /**
   * The employee is being created in this same transaction (hire path), so there is no
   * live payroll relationship to protect: a new primary simply replaces any earlier
   * primary without a second approval.
   */
  bootstrap?: boolean;
};

/**
 * Core Employee Enterprise, Phase 8 (0086) + Gap Register EMP-07/EMP-08 (0131).
 *
 * `employee_payment_accounts` is the only source of an employee's bank
 * details (`employees.bank_account_number` is a read-only projection kept
 * by trg_payment_account_mirror). Accounts carry a validity window,
 * priority, optional split %, currency, bank key/country and a
 * verification status. Changing the payment-critical details of an
 * approved primary account never edits it in place: a PENDING replacement
 * row is stored, and a DIFFERENT user (maker-checker) approves it, at which
 * point the old account is ended and the new one becomes primary. Payroll
 * only ever reads approved accounts, so an unapproved change can never
 * redirect a salary.
 */
@Injectable()
export class EmployeePaymentAccountsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateEmployeePaymentAccountRequest): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.createWithinTransaction(client, claims, input));
  }

  async createWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeePaymentAccountRequest,
    opts: PaymentAccountWriteOptions = {}
  ): Promise<EmployeePaymentAccountView> {
    await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
    assertValidIban(input.iban);
    this.assertWindow(input.validFrom, input.validTo);

    const existingPrimary = await this.livePrimary(client, input.employeeId);
    const wantsPrimary = input.isPrimary === true;
    const needsApproval = wantsPrimary && !!existingPrimary && !opts.bootstrap;

    if (wantsPrimary && existingPrimary && opts.bootstrap) {
      await client.query("UPDATE employee_payment_accounts SET is_primary = false, updated_at = now() WHERE id = $1", [existingPrimary.id]);
    }

    const submitter = await this.actorUserId(client, claims);
    const priority = input.priority ?? (await this.nextPriority(client, input.employeeId));
    const asPrimaryNow = wantsPrimary && !needsApproval;

    const inserted = await this.insertRow(client, claims, input, {
      isPrimary: asPrimaryNow,
      priority,
      approvalStatus: needsApproval ? "pending" : "approved",
      submittedBy: submitter,
      replacesAccountId: needsApproval ? existingPrimary.id : null,
    });
    const view = rowToView(inserted);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: needsApproval ? "employee_payment_account.change_requested" : "employee_payment_account.create",
      target: view.id,
      metadata: { employeeId: input.employeeId, paymentMethod: input.paymentMethod, replaces: view.replacesAccountId },
    });

    return view;
  }

  /**
   * The legacy flat `bankAccountNumber` input of employee create/update is routed
   * through here. No account yet -> approved primary (first account); same number ->
   * no-op; different number on an existing primary -> pending replacement.
   */
  async applyFlatBankAccountNumber(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    accountNumber: string,
    opts: PaymentAccountWriteOptions = {}
  ): Promise<{ pending: boolean; accountId: string | null }> {
    const primary = await this.livePrimary(client, employeeId);
    if (primary && sensitive.decrypt(primary.company_id, primary.account_number) === accountNumber) {
      return { pending: false, accountId: primary.id };
    }
    const view = await this.createWithinTransaction(
      client,
      claims,
      {
        employeeId,
        paymentMethod: primary?.payment_method ?? "bank_transfer",
        bankName: primary?.bank_name ?? undefined,
        accountTitle: primary?.account_title ?? undefined,
        accountNumber,
        branchCode: primary?.branch_code ?? undefined,
        bankKey: primary?.bank_key ?? undefined,
        bankCountry: primary?.bank_country ?? undefined,
        currency: primary?.currency ?? undefined,
        isPrimary: true,
      },
      opts
    );
    return { pending: view.approvalStatus === "pending", accountId: view.id };
  }

  async list(claims: RequestClaims, employeeId: string, includeHistory = false): Promise<EmployeePaymentAccountView[]> {
    const door = await requireViewOrSelf(this.db, this.rbac, claims, employeeId, () => this.requireView(claims));
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM employee_payment_accounts
          WHERE employee_id = $1
            AND ($2::boolean OR (status = 'active' AND approval_status IN ('approved', 'pending')))
          ORDER BY (status = 'active') DESC, (approval_status = 'pending') ASC, priority, created_at`,
        [employeeId, includeHistory]
      );
      const views = result.rows.map(rowToView);
      // The person's own view shows only the last four characters of the account number and IBAN.
      return door === "self" ? views.map((v) => ({ ...v, accountNumber: maskTail(v.accountNumber), iban: maskTail(v.iban) })) : views;
    });
  }

  /**
   * BACKLOG48: the employee proposes a bank account for themselves. It is stored as a PENDING account that replaces the
   * current primary (or becomes the first one) and takes effect only when HR approves it - the submitter can never approve
   * their own submission (maker-checker in approve()).
   */
  async submitForSelf(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    input: Omit<CreateEmployeePaymentAccountRequest, "employeeId" | "isPrimary" | "priority" | "validFrom" | "validTo" | "splitPercent">
  ): Promise<EmployeePaymentAccountView> {
    assertValidIban(input.iban);
    const existingPrimary = await this.livePrimary(client, employeeId);
    const submitter = await this.actorUserId(client, claims);
    const inserted = await this.insertRow(
      client,
      claims,
      { ...input, employeeId },
      {
        isPrimary: false,
        priority: await this.nextPriority(client, employeeId),
        approvalStatus: "pending",
        submittedBy: submitter,
        replacesAccountId: existingPrimary?.id ?? null,
      }
    );
    const view = rowToView(inserted);
    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "employee_payment_account.change_requested",
      target: view.id,
      metadata: { employeeId, paymentMethod: input.paymentMethod, replaces: view.replacesAccountId, requestedBy: "employee" },
    });
    return view;
  }

  /** Withdraws a pending account the employee submitted (used when they cancel their change request). */
  async withdrawPending(client: PoolClient, accountId: string): Promise<void> {
    await client.query(
      `UPDATE employee_payment_accounts SET approval_status = 'rejected', status = 'ended', is_primary = false,
              rejection_reason = 'Withdrawn by the employee', valid_to = GREATEST(CURRENT_DATE, valid_from), updated_at = now()
        WHERE id = $1 AND approval_status = 'pending'`,
      [accountId]
    );
  }

  async update(claims: RequestClaims, id: string, patch: UpdateEmployeePaymentAccountRequest): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") throw new BadRequestException("An ended payment account cannot be changed");
      assertValidIban(patch.iban);
      this.assertWindow(patch.validFrom ?? toDate(before.valid_from) ?? undefined, patch.validTo ?? undefined);

      const criticalChanged = PAYMENT_CRITICAL_FIELDS.some((f) => patch[f] !== undefined && this.differs(before, f, patch[f]));

      if (patch.isPrimary === true && !before.is_primary && before.approval_status === "approved") {
        throw new BadRequestException(
          "To change which account is primary, add the account as a new primary account — the change is held for a second person's approval."
        );
      }

      // Approved primary + payment-critical change => pending replacement, original untouched.
      if (before.approval_status === "approved" && before.is_primary && criticalChanged) {
        const submitter = await this.actorUserId(client, claims);
        const merged = this.mergeForReplacement(before, patch, claims.company_id!);
        const row = await this.insertRow(client, claims, merged, {
          isPrimary: false,
          priority: await this.nextPriority(client, before.employee_id),
          approvalStatus: "pending",
          submittedBy: submitter,
          replacesAccountId: before.id,
        });
        const view = rowToView(row);
        await this.audit.record(client, claims, {
          companyId: claims.company_id ?? null,
          action: "employee_payment_account.change_requested",
          target: view.id,
          metadata: { employeeId: before.employee_id, replaces: before.id },
        });
        return view;
      }

      const detailsChanged = criticalChanged;
      const result = await client.query(
        `UPDATE employee_payment_accounts SET
           payment_method = COALESCE($2, payment_method),
           bank_name = COALESCE($3, bank_name),
           account_title = COALESCE($4, account_title),
           account_number = COALESCE($5, account_number),
           iban = COALESCE($6, iban),
           account_number_bidx = COALESCE($9, account_number_bidx),
           iban_bidx = COALESCE($10, iban_bidx),
           branch_code = COALESCE($7, branch_code),
           is_primary = COALESCE($8, is_primary),
           valid_from = COALESCE($11::date, valid_from),
           valid_to = COALESCE($12::date, valid_to),
           priority = COALESCE($13, priority),
           split_percent = CASE WHEN $14::boolean THEN $15::numeric ELSE split_percent END,
           currency = COALESCE($16, currency),
           bank_key = COALESCE($17, bank_key),
           bank_country = COALESCE($18, bank_country),
           verification_status = CASE WHEN $19::boolean THEN 'unverified' ELSE verification_status END,
           verified_at = CASE WHEN $19::boolean THEN NULL ELSE verified_at END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.paymentMethod ?? null,
          patch.bankName ?? null,
          patch.accountTitle ?? null,
          sensitive.encrypt(claims.company_id!, patch.accountNumber),
          sensitive.encrypt(claims.company_id!, patch.iban),
          patch.branchCode ?? null,
          patch.isPrimary ?? null,
          sensitive.accountIndex(claims.company_id!, patch.accountNumber),
          sensitive.ibanIndex(claims.company_id!, patch.iban),
          patch.validFrom ?? null,
          patch.validTo ?? null,
          patch.priority ?? null,
          patch.splitPercent !== undefined,
          patch.splitPercent ?? null,
          patch.currency ?? null,
          patch.bankKey ?? null,
          patch.bankCountry ?? null,
          detailsChanged,
        ]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_payment_account.update",
        target: id,
        metadata: { before: rowToView(before), after: rowToView(result.rows[0]) },
      });

      return rowToView(result.rows[0]);
    });
  }

  /** Second person approves a pending account; the account it replaces (if any) is ended and the new one becomes primary. */
  async approve(claims: RequestClaims, id: string): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const pending = await this.mustExist(client, id);
      if (pending.approval_status !== "pending" || pending.status !== "active") {
        throw new BadRequestException("Only a pending payment account can be approved");
      }
      const approver = await this.actorUserId(client, claims);
      if (approver && pending.submitted_by_user_account_id && approver === pending.submitted_by_user_account_id) {
        throw new ForbiddenException("The person who submitted a payment account change cannot approve it (maker-checker)");
      }

      let priority = pending.priority;
      let makePrimary = pending.is_primary;
      // A pending account that replaces nothing (an employee's first account) becomes the primary when approved,
      // unless the employee already has a live primary.
      if (!makePrimary && !pending.replaces_account_id && !(await this.livePrimary(client, pending.employee_id))) makePrimary = true;
      if (pending.replaces_account_id) {
        const old = (await client.query("SELECT * FROM employee_payment_accounts WHERE id = $1 FOR UPDATE", [pending.replaces_account_id])).rows[0];
        if (old && old.status === "active") {
          await client.query(
            "UPDATE employee_payment_accounts SET status = 'ended', is_primary = false, valid_to = GREATEST(CURRENT_DATE, valid_from), updated_at = now() WHERE id = $1",
            [old.id]
          );
          priority = old.priority;
          makePrimary = old.is_primary || pending.is_primary;
        }
      }
      // never leave two primaries: any other live primary is demoted before promotion
      if (makePrimary) {
        await client.query(
          "UPDATE employee_payment_accounts SET is_primary = false, updated_at = now() WHERE employee_id = $1 AND id <> $2 AND is_primary",
          [pending.employee_id, id]
        );
      }
      const result = await client.query(
        `UPDATE employee_payment_accounts SET approval_status = 'approved', approved_by_user_account_id = $2, approved_at = now(),
                is_primary = $3, priority = $4, valid_from = GREATEST(valid_from, CURRENT_DATE), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, approver, makePrimary, priority]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_payment_account.approve",
        target: id,
        metadata: { employeeId: pending.employee_id, replaces: pending.replaces_account_id },
      });
      return rowToView(result.rows[0]);
    });
  }

  async reject(claims: RequestClaims, id: string, reason: string): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    if (!reason || !reason.trim()) throw new BadRequestException("A rejection reason is required");
    return this.db.withClaims(claims, async (client) => {
      const pending = await this.mustExist(client, id);
      if (pending.approval_status !== "pending") throw new BadRequestException("Only a pending payment account can be rejected");
      const actor = await this.actorUserId(client, claims);
      const result = await client.query(
        `UPDATE employee_payment_accounts SET approval_status = 'rejected', status = 'ended', is_primary = false,
                rejection_reason = $2, valid_to = GREATEST(CURRENT_DATE, valid_from), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, reason.trim()]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_payment_account.reject",
        target: id,
        reason: reason.trim(),
        metadata: { employeeId: pending.employee_id, rejectedBy: actor },
      });
      return rowToView(result.rows[0]);
    });
  }

  async verify(claims: RequestClaims, id: string, status: "verified" | "failed" | "unverified"): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const actor = await this.actorUserId(client, claims);
      const result = await client.query(
        `UPDATE employee_payment_accounts SET verification_status = $2,
                verified_at = CASE WHEN $2 = 'unverified' THEN NULL ELSE now() END,
                verified_by_user_account_id = CASE WHEN $2 = 'unverified' THEN NULL ELSE $3::uuid END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, status, actor]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_payment_account.verify",
        target: id,
        metadata: { status },
      });
      return rowToView(result.rows[0]);
    });
  }

  async end(claims: RequestClaims, id: string): Promise<EmployeePaymentAccountView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") return rowToView(before);
      const result = await client.query(
        "UPDATE employee_payment_accounts SET status = 'ended', is_primary = false, valid_to = GREATEST(CURRENT_DATE, valid_from), updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_payment_account.end", target: id });
      return rowToView(result.rows[0]);
    });
  }

  // ------------------------------------------------------------ helpers
  private assertWindow(from?: string | null, to?: string | null): void {
    if (from && to && to < from) throw new BadRequestException("validTo cannot be before validFrom");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private differs(row: any, field: (typeof PAYMENT_CRITICAL_FIELDS)[number], value: unknown): boolean {
    const col: Record<string, string> = {
      paymentMethod: "payment_method",
      bankName: "bank_name",
      accountTitle: "account_title",
      accountNumber: "account_number",
      iban: "iban",
      branchCode: "branch_code",
      bankKey: "bank_key",
      bankCountry: "bank_country",
    };
    const current = field === "accountNumber" || field === "iban" ? sensitive.decrypt(row.company_id, row[col[field]]) : row[col[field]];
    return (current ?? null) !== (value ?? null);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mergeForReplacement(before: any, patch: UpdateEmployeePaymentAccountRequest, companyId: string): CreateEmployeePaymentAccountRequest {
    return {
      employeeId: before.employee_id,
      paymentMethod: patch.paymentMethod ?? before.payment_method,
      bankName: patch.bankName ?? before.bank_name ?? undefined,
      accountTitle: patch.accountTitle ?? before.account_title ?? undefined,
      accountNumber: patch.accountNumber ?? sensitive.decrypt(companyId, before.account_number) ?? undefined,
      iban: patch.iban ?? sensitive.decrypt(companyId, before.iban) ?? undefined,
      branchCode: patch.branchCode ?? before.branch_code ?? undefined,
      bankKey: patch.bankKey ?? before.bank_key ?? undefined,
      bankCountry: patch.bankCountry ?? before.bank_country,
      currency: patch.currency ?? before.currency,
      splitPercent: patch.splitPercent === undefined ? (before.split_percent === null ? undefined : Number(before.split_percent)) : (patch.splitPercent ?? undefined),
      validFrom: patch.validFrom ?? undefined,
      validTo: patch.validTo ?? undefined,
    };
  }

  private async insertRow(
    client: PoolClient,
    claims: RequestClaims,
    input: CreateEmployeePaymentAccountRequest,
    extra: { isPrimary: boolean; priority: number; approvalStatus: "approved" | "pending"; submittedBy: string | null; replacesAccountId: string | null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const cid = claims.company_id!;
    try {
      const inserted = await client.query(
        `INSERT INTO employee_payment_accounts
           (company_id, employee_id, payment_method, bank_name, account_title, account_number, iban, branch_code, is_primary,
            account_number_bidx, iban_bidx, valid_from, valid_to, priority, split_percent, currency, bank_key, bank_country,
            approval_status, submitted_by_user_account_id, replaces_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::date, CURRENT_DATE), $13::date, $14, $15, COALESCE($16, 'PKR'),
                 $17, COALESCE($18, 'PK'), $19, $20, $21)
         RETURNING *`,
        [
          cid,
          input.employeeId,
          input.paymentMethod,
          input.bankName ?? null,
          input.accountTitle ?? null,
          sensitive.encrypt(cid, input.accountNumber),
          sensitive.encrypt(cid, input.iban),
          input.branchCode ?? null,
          extra.isPrimary,
          sensitive.accountIndex(cid, input.accountNumber),
          sensitive.ibanIndex(cid, input.iban),
          input.validFrom ?? null,
          input.validTo ?? null,
          extra.priority,
          input.splitPercent ?? null,
          input.currency ?? null,
          input.bankKey ?? null,
          input.bankCountry ?? null,
          extra.approvalStatus,
          extra.submittedBy,
          extra.replacesAccountId,
        ]
      );
      return inserted.rows[0];
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") throw new ConflictException("Another live payment account of this employee already uses that priority");
      if (code === "23514") throw new BadRequestException((err as Error).message);
      throw err;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async livePrimary(client: PoolClient, employeeId: string): Promise<any | null> {
    const r = await client.query(
      "SELECT * FROM employee_payment_accounts WHERE employee_id = $1 AND is_primary AND status = 'active' AND approval_status = 'approved' LIMIT 1",
      [employeeId]
    );
    return r.rows[0] ?? null;
  }

  private async nextPriority(client: PoolClient, employeeId: string): Promise<number> {
    const r = await client.query(
      "SELECT COALESCE(max(priority), 0) + 1 AS n FROM employee_payment_accounts WHERE employee_id = $1 AND status = 'active' AND approval_status = 'approved'",
      [employeeId]
    );
    return Number(r.rows[0].n);
  }

  /** The acting user's user_accounts id, or null for a non-user actor (platform admin / service). */
  private async actorUserId(client: PoolClient, claims: RequestClaims): Promise<string | null> {
    if (!claims.sub || !/^[0-9a-f-]{36}$/i.test(claims.sub)) return null;
    const r = await client.query("SELECT id FROM user_accounts WHERE id = $1", [claims.sub]);
    return r.rows[0]?.id ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM employee_payment_accounts WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee payment account not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee payment accounts");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee payment accounts");
    }
  }
}
