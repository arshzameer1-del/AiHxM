import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { PoolClient } from "pg";
import type {
  EmployeeChangeRequestAction,
  EmployeeChangeRequestStatus,
  EmployeeChangeRequestType,
  EmployeeChangeRequestView,
  SubmitEmployeeChangeRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";
import { RbacService } from "../rbac/rbac.service";
import { sensitive } from "../crypto/sensitive-fields";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { CreateEmployeeAddressDto } from "./dto/create-employee-address.dto";
import { CreateEmployeeContactDto } from "./dto/create-employee-contact.dto";
import { CreateEmployeeFamilyMemberDto } from "./dto/create-employee-family-member.dto";
import { CreateEmployeePaymentAccountDto } from "./dto/create-employee-payment-account.dto";
import { UpdateEmployeeAddressDto } from "./dto/update-employee-address.dto";
import { UpdateEmployeeContactDto } from "./dto/update-employee-contact.dto";
import { UpdateEmployeeFamilyMemberDto } from "./dto/update-employee-family-member.dto";
import { EmployeeAddressesService } from "./employee-addresses.service";
import { EmployeeContactsService } from "./employee-contacts.service";
import { EmployeeFamilyMembersService } from "./employee-family-members.service";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { EmployeesService } from "./employees.service";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const MAX_OPEN_PER_EMPLOYEE = 20;
const TYPES: EmployeeChangeRequestType[] = ["contact", "address", "family_member", "marital_status", "bank_account"];
const ACTIONS: EmployeeChangeRequestAction[] = ["add", "update", "end"];

const TABLE: Record<"contact" | "address" | "family_member", string> = {
  contact: "employee_contacts",
  address: "employee_addresses",
  family_member: "employee_family_members",
};
const LABEL: Record<EmployeeChangeRequestType, string> = {
  contact: "contact detail",
  address: "address",
  family_member: "family member",
  marital_status: "marital status",
  bank_account: "bank account",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDto = new () => any;
const CREATE_DTO: Record<string, AnyDto> = {
  contact: CreateEmployeeContactDto,
  address: CreateEmployeeAddressDto,
  family_member: CreateEmployeeFamilyMemberDto,
  bank_account: CreateEmployeePaymentAccountDto,
};
const UPDATE_DTO: Record<string, AnyDto> = {
  contact: UpdateEmployeeContactDto,
  address: UpdateEmployeeAddressDto,
  family_member: UpdateEmployeeFamilyMemberDto,
};
/** Bank account fields an employee may propose. Everything else (primary flag, split, validity) is HR's. */
const BANK_FIELDS = ["paymentMethod", "bankName", "accountTitle", "accountNumber", "iban", "branchCode"];

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const mask = (v: unknown): string => (typeof v === "string" && v.length > 4 ? `••••${v.slice(-4)}` : "••••");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(row: any): EmployeeChangeRequestView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number ?? "",
    employeeName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
    requestType: row.request_type,
    action: row.action,
    targetId: row.target_id,
    payload: openForDisplay(row.payload ?? {}),
    current: null,
    summary: row.summary,
    status: row.status,
    paymentAccountId: row.payment_account_id,
    submittedAt: iso(row.submitted_at)!,
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
  };
}

/**
 * BACKLOG48 - an employee asks HR to change their OWN contact details, addresses, family members, marital status or bank
 * account. Submitting needs only `employee.view.self` and works only on the caller's own employee record. Nothing on the
 * record changes until a person with `employee.manage.all` approves; approving applies the change through the same
 * services HR uses directly, so every validation and audit entry is the one HR would get.
 */
@Injectable()
export class EmployeeChangeRequestsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly hrCatalog: HrReferenceCatalogService,
    private readonly contacts: EmployeeContactsService,
    private readonly addresses: EmployeeAddressesService,
    private readonly family: EmployeeFamilyMembersService,
    private readonly bank: EmployeePaymentAccountsService,
    private readonly employees: EmployeesService,
    // BACKLOG51 - optional so every existing hand-built spec keeps working; Nest always supplies the real one.
    private readonly inbox?: UserNotificationsService
  ) {}

  // ---------------------------------------------------------------- employee side

  async submit(claims: RequestClaims, dto: SubmitEmployeeChangeRequest): Promise<EmployeeChangeRequestView> {
    await this.requireSelf(claims);
    if (!TYPES.includes(dto.requestType)) throw new BadRequestException("Unknown request type");
    if (!ACTIONS.includes(dto.action)) throw new BadRequestException("Unknown action");
    if (dto.requestType === "bank_account" && dto.action !== "add") {
      throw new BadRequestException("To change a bank account, submit the new account details. HR retires the old one when approving.");
    }
    // Marital status and bank account are not "records you edit": store them as a change (marital) or an addition (bank).
    const action: EmployeeChangeRequestAction = dto.requestType === "marital_status" ? "update" : dto.requestType === "bank_account" ? "add" : dto.action;
    const submitted = await this.db.withClaims(claims, async (client) => {
      const me = await this.myEmployee(client, claims);
      const open = await client.query("SELECT count(*)::int AS n FROM employee_change_requests WHERE employee_id = $1 AND status = 'pending'", [me.id]);
      if (open.rows[0].n >= MAX_OPEN_PER_EMPLOYEE) throw new BadRequestException("You have too many open requests. Wait for HR to answer some of them.");

      let payload: Record<string, unknown> = {};
      let targetId: string | null = null;
      let summary: string;
      let paymentAccountId: string | null = null;

      if (dto.requestType === "marital_status") {
        const status = String(dto.payload?.maritalStatus ?? "").trim();
        if (!status) throw new BadRequestException("Choose a marital status");
        await this.hrCatalog.validateActiveCode(client, claims.company_id!, "marital_status", status);
        payload = { maritalStatus: status };
        summary = `Change marital status to ${status.replace(/_/g, " ")}`;
      } else if (dto.requestType === "bank_account") {
        payload = pick(dto.payload ?? {}, BANK_FIELDS);
        await this.assertValid(CREATE_DTO.bank_account, { ...payload, employeeId: me.id });
        if (!payload.accountNumber && !payload.iban) throw new BadRequestException("Give the account number or the IBAN");
        const view = await this.bank.submitForSelf(client, claims, me.id, payload as never);
        paymentAccountId = view.id;
        summary = `Change bank account to ${payload.bankName ? `${payload.bankName} ` : ""}${mask(payload.accountNumber ?? payload.iban)}`;
        payload = { ...payload, accountNumber: payload.accountNumber ? mask(payload.accountNumber) : undefined, iban: payload.iban ? mask(payload.iban) : undefined };
      } else {
        const table = TABLE[dto.requestType];
        if (dto.action === "add") {
          const cleaned = await this.assertValid(CREATE_DTO[dto.requestType], { ...(dto.payload ?? {}), employeeId: me.id });
          delete cleaned.employeeId;
          payload = cleaned;
          summary = `Add ${LABEL[dto.requestType]}: ${describe(dto.requestType, payload)}`;
        } else {
          if (!dto.targetId) throw new BadRequestException("Say which record you want to change");
          const target = await client.query(`SELECT * FROM ${table} WHERE id = $1 AND employee_id = $2 AND status = 'active'`, [dto.targetId, me.id]);
          if (target.rowCount === 0) throw new NotFoundException("That record was not found on your file");
          targetId = dto.targetId;
          if (dto.action === "update") {
            payload = await this.assertValid(UPDATE_DTO[dto.requestType], dto.payload ?? {});
            if (Object.keys(payload).length === 0) throw new BadRequestException("Nothing to change");
            summary = `Change ${LABEL[dto.requestType]}: ${describe(dto.requestType, { ...camel(target.rows[0]), ...payload })}`;
          } else {
            summary = `Remove ${LABEL[dto.requestType]}: ${describe(dto.requestType, camel(target.rows[0]))}`;
          }
        }
      }

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO employee_change_requests
             (company_id, employee_id, request_type, action, target_id, payload, summary, payment_account_id, submitted_by_user_account_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING *`,
          [claims.company_id, me.id, dto.requestType, action, targetId, JSON.stringify(sealPayload(claims.company_id!, dto.requestType, payload)), summary, paymentAccountId, claims.sub]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new BadRequestException("There is already an open request for this record");
        throw err;
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_change_request.submit",
        target: inserted.rows[0].id,
        metadata: { employeeId: me.id, requestType: dto.requestType, change: action },
      });
      return toView({ ...inserted.rows[0], payload: sealPayload(claims.company_id!, dto.requestType, payload), employee_number: me.employee_number, first_name: me.first_name, last_name: me.last_name });
    });
    if (this.inbox && claims.company_id) {
      const hr = await this.inbox.hrAdminUserIds(claims.company_id);
      await this.inbox.notify({
        companyId: claims.company_id,
        userAccountIds: hr,
        category: "hr_inbox",
        title: `${submitted.employeeName} sent a change request`,
        body: submitted.summary,
        link: "/app/employees/change-requests",
      });
    }
    return submitted;
  }

  async listMine(claims: RequestClaims): Promise<EmployeeChangeRequestView[]> {
    await this.requireSelf(claims);
    return this.db.withClaims(claims, async (client) => {
      const me = await this.myEmployee(client, claims);
      const r = await client.query(
        `SELECT r.*, e.employee_number, e.first_name, e.last_name FROM employee_change_requests r JOIN employees e ON e.id = r.employee_id
          WHERE r.employee_id = $1 ORDER BY r.submitted_at DESC LIMIT 100`,
        [me.id]
      );
      return r.rows.map(toView);
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<EmployeeChangeRequestView> {
    await this.requireSelf(claims);
    return this.db.withClaims(claims, async (client) => {
      const me = await this.myEmployee(client, claims);
      const r = await client.query(
        `UPDATE employee_change_requests SET status = 'cancelled', decided_at = now(), updated_at = now()
          WHERE id = $1 AND employee_id = $2 AND status = 'pending' RETURNING *`,
        [id, me.id]
      );
      if (r.rowCount === 0) throw new NotFoundException("No open request of yours with that id");
      if (r.rows[0].payment_account_id) await this.bank.withdrawPending(client, r.rows[0].payment_account_id);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_change_request.cancel", target: id });
      return toView({ ...r.rows[0], employee_number: me.employee_number, first_name: me.first_name, last_name: me.last_name });
    });
  }

  // ---------------------------------------------------------------- HR side

  async list(claims: RequestClaims, status?: EmployeeChangeRequestStatus): Promise<EmployeeChangeRequestView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT r.*, e.employee_number, e.first_name, e.last_name FROM employee_change_requests r JOIN employees e ON e.id = r.employee_id
          WHERE ($1::text IS NULL OR r.status = $1) ORDER BY (r.status = 'pending') DESC, r.submitted_at DESC LIMIT 300`,
        [status ?? null]
      );
      const views = r.rows.map(toView);
      for (const v of views) {
        if (v.status !== "pending" || v.action === "add") continue;
        if (v.requestType === "marital_status") {
          const cur = await client.query("SELECT marital_status FROM employees WHERE id = $1", [v.employeeId]);
          v.current = { maritalStatus: cur.rows[0]?.marital_status ?? null };
        } else if (v.targetId && v.requestType in TABLE) {
          const cur = await client.query(`SELECT * FROM ${TABLE[v.requestType as keyof typeof TABLE]} WHERE id = $1`, [v.targetId]);
          if (cur.rows[0]) {
            const c = camel(cur.rows[0]);
            v.current = v.action === "update" ? Object.fromEntries(Object.keys(v.payload).map((k) => [k, c[k] ?? null])) : c;
          }
        }
      }
      return views;
    });
  }

  async approve(claims: RequestClaims, id: string, note?: string): Promise<EmployeeChangeRequestView> {
    await this.requireManage(claims);
    // Claim it first (so two approvers cannot both apply it), then apply; if applying fails, put it back to pending.
    const claimed = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE employee_change_requests SET status = 'approved', decided_by_user_account_id = $2, decided_at = now(), decision_note = $3, updated_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id, claims.sub, note?.trim() || null]
      );
      if (r.rowCount === 0) throw new BadRequestException("This request is not open any more");
      return r.rows[0];
    });
    try {
      await this.apply(claims, claimed);
    } catch (err) {
      await this.db.withClaims(claims, (client) =>
        client.query(
          "UPDATE employee_change_requests SET status = 'pending', decided_by_user_account_id = NULL, decided_at = NULL, decision_note = NULL, updated_at = now() WHERE id = $1",
          [id]
        )
      );
      throw err;
    }
    const approved = await this.db.withClaims(claims, async (client) => {
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_change_request.approve",
        target: id,
        metadata: { employeeId: claimed.employee_id, requestType: claimed.request_type, change: claimed.action },
      });
      return this.one(client, id);
    });
    await this.tellEmployee(claims, approved, true);
    return approved;
  }

  async reject(claims: RequestClaims, id: string, note: string): Promise<EmployeeChangeRequestView> {
    await this.requireManage(claims);
    if (!note || !note.trim()) throw new BadRequestException("Give the employee a reason");
    const rejected = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE employee_change_requests SET status = 'rejected', decided_by_user_account_id = $2, decided_at = now(), decision_note = $3, updated_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id, claims.sub, note.trim()]
      );
      if (r.rowCount === 0) throw new BadRequestException("This request is not open any more");
      if (r.rows[0].payment_account_id) await this.bank.withdrawPending(client, r.rows[0].payment_account_id);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_change_request.reject",
        target: id,
        reason: note.trim(),
        metadata: { employeeId: r.rows[0].employee_id, requestType: r.rows[0].request_type },
      });
      return this.one(client, id);
    });
    await this.tellEmployee(claims, rejected, false);
    return rejected;
  }

  /** BACKLOG51 - the employee hears HR's decision in their bell (and by email if they want it). */
  private async tellEmployee(claims: RequestClaims, view: EmployeeChangeRequestView, approved: boolean): Promise<void> {
    if (!this.inbox || !claims.company_id) return;
    const owner = await this.db.withClaims(claims, (client) => client.query("SELECT user_account_id FROM employees WHERE id = $1", [view.employeeId]));
    await this.inbox.notify({
      companyId: claims.company_id,
      userAccountIds: [owner.rows[0]?.user_account_id],
      category: "request_decisions",
      title: approved ? "HR approved your request" : "HR did not approve your request",
      body: `${view.summary}${view.decisionNote ? ` - ${view.decisionNote}` : ""}`,
      link: "/app/profile",
    });
  }

  // ---------------------------------------------------------------- internals

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async apply(claims: RequestClaims, req: any): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = openForApply(req.company_id, req.payload ?? {}) as any;
    switch (req.request_type as EmployeeChangeRequestType) {
      case "marital_status":
        await this.employees.update(claims, req.employee_id, { maritalStatus: payload.maritalStatus });
        return;
      case "bank_account":
        // Becomes effective through the payment accounts approval (the employee submitted it, so HR is the second person).
        if (!req.payment_account_id) throw new BadRequestException("The bank account behind this request is missing");
        await this.bank.approve(claims, req.payment_account_id);
        return;
      case "contact":
        if (req.action === "add") await this.contacts.create(claims, { ...payload, employeeId: req.employee_id });
        else if (req.action === "update") await this.contacts.update(claims, req.target_id, payload);
        else await this.contacts.end(claims, req.target_id);
        return;
      case "address":
        if (req.action === "add") await this.addresses.create(claims, { ...payload, employeeId: req.employee_id });
        else if (req.action === "update") await this.addresses.update(claims, req.target_id, payload);
        else await this.addresses.end(claims, req.target_id);
        return;
      case "family_member":
        if (req.action === "add") await this.family.create(claims, { ...payload, employeeId: req.employee_id });
        else if (req.action === "update") await this.family.update(claims, req.target_id, payload);
        else await this.family.end(claims, req.target_id);
        return;
    }
  }

  private async one(client: PoolClient, id: string): Promise<EmployeeChangeRequestView> {
    const r = await client.query(
      `SELECT r.*, e.employee_number, e.first_name, e.last_name FROM employee_change_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1`,
      [id]
    );
    if (r.rowCount === 0) throw new NotFoundException();
    return toView(r.rows[0]);
  }

  private async assertValid(cls: AnyDto, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const instance = plainToInstance(cls, input);
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      throw new BadRequestException(errors.flatMap((e) => Object.values(e.constraints ?? {})).join("; ") || "Some values are not valid");
    }
    // keep only the fields the DTO knows and the caller actually sent
    const known = Object.keys(instance as object).filter((k) => input[k] !== undefined);
    return Object.fromEntries(known.map((k) => [k, (instance as Record<string, unknown>)[k]]));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async myEmployee(client: PoolClient, claims: RequestClaims): Promise<any> {
    const r = await client.query(
      `SELECT id, employee_number, first_name, last_name FROM employees WHERE user_account_id = $1
        ORDER BY (employment_status = 'terminated'), created_at DESC LIMIT 1`,
      [claims.sub]
    );
    if (r.rowCount === 0) throw new NotFoundException("Your login is not linked to an employee record yet.");
    return r.rows[0];
  }

  private async requireSelf(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new NotFoundException();
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "employee.view.self", { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Requires HR Admin");
  }
}

/** Family-member CNIC and date of birth are stored encrypted inside the request, shown to HR as "provided", and decrypted only when the change is applied. */
const SEALED_KEYS = ["cnic", "dateOfBirth"];
function sealPayload(companyId: string, type: EmployeeChangeRequestType, payload: Record<string, unknown>): Record<string, unknown> {
  if (type !== "family_member") return payload;
  const out: Record<string, unknown> = { ...payload };
  const sealed: Record<string, string> = {};
  for (const k of SEALED_KEYS) {
    if (typeof out[k] === "string" && out[k]) {
      sealed[k] = sensitive.encrypt(companyId, String(out[k]))!;
      delete out[k];
    }
  }
  if (Object.keys(sealed).length > 0) out.__sealed = sealed;
  return out;
}
function openForDisplay(payload: Record<string, unknown>): Record<string, unknown> {
  const { __sealed, ...rest } = payload as Record<string, unknown> & { __sealed?: Record<string, string> };
  const shown: Record<string, unknown> = { ...rest };
  for (const k of Object.keys(__sealed ?? {})) shown[k] = "Provided";
  return shown;
}
function openForApply(companyId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const { __sealed, ...rest } = payload as Record<string, unknown> & { __sealed?: Record<string, string> };
  const out: Record<string, unknown> = { ...rest };
  for (const [k, v] of Object.entries(__sealed ?? {})) out[k] = sensitive.decrypt(companyId, v);
  return out;
}

function pick(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined && src[k] !== null && src[k] !== "") out[k] = typeof src[k] === "string" ? String(src[k]).trim() : src[k];
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function camel(row: any): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
}

function describe(type: EmployeeChangeRequestType, p: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null || v === "" ? "" : String(v));
  if (type === "contact") return [s(p.contactType).replace(/_/g, " "), s(p.value), p.label ? `(${s(p.label)})` : "", p.relationship ? `- ${s(p.relationship)}` : ""].filter(Boolean).join(" ");
  if (type === "address") return [s(p.addressType), s(p.line1), s(p.city)].filter(Boolean).join(", ");
  if (type === "family_member") return [s(p.fullName), p.relationship ? `(${s(p.relationship)})` : ""].filter(Boolean).join(" ");
  return "";
}

