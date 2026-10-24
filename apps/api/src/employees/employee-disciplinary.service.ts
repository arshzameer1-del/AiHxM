import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { CreateEmployeeDisciplinaryRecordRequest, EmployeeDisciplinaryRecordView } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";
import { isOwnEmployee } from "./employee-self-read";

const MODULE_KEY = "employee" as const;
const VIEW = "employee.disciplinary.view";
const MANAGE = "employee.disciplinary.manage";

const TYPE_LABEL: Record<string, string> = {
  verbal_warning: "a verbal warning",
  written_warning: "a written warning",
  final_warning: "a final warning",
  show_cause: "a show-cause notice",
  suspension: "a suspension notice",
  other: "a disciplinary notice",
};

const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (r: any): EmployeeDisciplinaryRecordView => ({
  id: r.id,
  employeeId: r.employee_id,
  recordType: r.record_type,
  subject: r.subject,
  description: r.description,
  incidentDate: day(r.incident_date),
  issuedDate: day(r.issued_date)!,
  actionTaken: r.action_taken,
  status: r.status,
  withdrawnReason: r.withdrawn_reason,
  withdrawnAt: iso(r.withdrawn_at),
  issuedByName: r.issued_by_name ?? null,
  acknowledgedAt: iso(r.acknowledged_at),
  employeeComment: r.employee_comment,
  createdAt: iso(r.created_at)!,
});

const SELECT = `
  SELECT d.*, NULLIF(btrim(COALESCE(ie.first_name, '') || ' ' || COALESCE(ie.last_name, '')), '') AS issued_by_name
    FROM employee_disciplinary_records d
    LEFT JOIN employees ie ON ie.user_account_id = d.issued_by_user_account_id AND ie.company_id = d.company_id`;

/**
 * BACKLOG54 - disciplinary records. Strict access: only HR (employee.disciplinary.view / .manage, hr_admin) can see
 * everyone's, issue and withdraw them; the person concerned sees their own and can acknowledge each one (with an
 * optional comment). Records are never deleted - withdrawing keeps the history.
 */
@Injectable()
export class EmployeeDisciplinaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Optional() private readonly inbox?: UserNotificationsService
  ) {}

  async list(claims: RequestClaims, employeeId: string): Promise<EmployeeDisciplinaryRecordView[]> {
    await this.requireViewOrSelf(claims, employeeId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`${SELECT} WHERE d.employee_id = $1 ORDER BY d.issued_date DESC, d.created_at DESC`, [employeeId]);
      return r.rows.map(toView);
    });
  }

  async create(claims: RequestClaims, input: CreateEmployeeDisciplinaryRecordRequest): Promise<EmployeeDisciplinaryRecordView> {
    await this.requireManage(claims);
    const subject = input.subject.trim();
    const description = input.description.trim();
    if (!subject || !description) throw new BadRequestException("Enter a subject and what happened");
    if (input.incidentDate && input.issuedDate && input.incidentDate > input.issuedDate) {
      throw new BadRequestException("The incident cannot be after the date the notice is issued");
    }
    const actor = claims.sub && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
    const created = await this.db.withClaims(claims, async (client) => {
      const emp = await client.query("SELECT user_account_id FROM employees WHERE id = $1 AND company_id = $2", [input.employeeId, claims.company_id]);
      if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
      const ins = await client.query(
        `INSERT INTO employee_disciplinary_records
           (company_id, employee_id, record_type, subject, description, incident_date, issued_date, action_taken, issued_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE), $8, $9) RETURNING id`,
        [claims.company_id, input.employeeId, input.recordType, subject, description, input.incidentDate || null, input.issuedDate || null, input.actionTaken?.trim() || null, actor]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_disciplinary.create",
        target: ins.rows[0].id,
        // the type only - never the wording of the notice
        metadata: { employeeId: input.employeeId, recordType: input.recordType },
      });
      const row = await client.query(`${SELECT} WHERE d.id = $1`, [ins.rows[0].id]);
      return { view: toView(row.rows[0]), userAccountId: emp.rows[0].user_account_id as string | null };
    });
    if (this.inbox && claims.company_id && created.userAccountId) {
      await this.inbox.notify({
        companyId: claims.company_id,
        userAccountIds: [created.userAccountId],
        category: "request_decisions",
        title: `HR issued you ${TYPE_LABEL[input.recordType] ?? "a disciplinary notice"}`,
        body: "Open My Disciplinary Records to read it and acknowledge it.",
        link: "/app/ess/disciplinary",
      });
    }
    return created.view;
  }

  async withdraw(claims: RequestClaims, id: string, reason: string): Promise<EmployeeDisciplinaryRecordView> {
    await this.requireManage(claims);
    const why = reason.trim();
    if (!why) throw new BadRequestException("Say why it is being withdrawn");
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT status FROM employee_disciplinary_records WHERE id = $1", [id]);
      if (cur.rowCount === 0) throw new NotFoundException("Record not found");
      if (cur.rows[0].status === "withdrawn") throw new ConflictException("This record is already withdrawn");
      await client.query(
        "UPDATE employee_disciplinary_records SET status = 'withdrawn', withdrawn_reason = $2, withdrawn_at = now(), updated_at = now() WHERE id = $1",
        [id, why]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_disciplinary.withdraw", target: id });
      const row = await client.query(`${SELECT} WHERE d.id = $1`, [id]);
      return toView(row.rows[0]);
    });
  }

  /** Only the person the record is about can acknowledge it - reading and acknowledging is not agreeing, and HR cannot do it for them. */
  async acknowledge(claims: RequestClaims, id: string, comment?: string): Promise<EmployeeDisciplinaryRecordView> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const cur = await this.db.withClaims(claims, (client) =>
      client.query("SELECT employee_id, acknowledged_at FROM employee_disciplinary_records WHERE id = $1", [id])
    );
    if (cur.rowCount === 0) throw new NotFoundException("Record not found");
    if (!(await isOwnEmployee(this.db, this.rbac, claims, cur.rows[0].employee_id))) {
      throw new ForbiddenException("Only the person this record is about can acknowledge it");
    }
    if (cur.rows[0].acknowledged_at) throw new ConflictException("You have already acknowledged this record");
    return this.db.withClaims(claims, async (client) => {
      await client.query(
        "UPDATE employee_disciplinary_records SET acknowledged_at = now(), employee_comment = $2, updated_at = now() WHERE id = $1",
        [id, comment?.trim() || null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_disciplinary.acknowledge", target: id });
      const row = await client.query(`${SELECT} WHERE d.id = $1`, [id]);
      return toView(row.rows[0]);
    });
  }

  private async requireViewOrSelf(claims: RequestClaims, employeeId: string): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (await isOwnEmployee(this.db, this.rbac, claims, employeeId)) return;
    if ((await this.rbac.can(claims, VIEW)) || (await this.rbac.can(claims, MANAGE))) return;
    throw new ForbiddenException("Not permitted to see disciplinary records");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to issue disciplinary records");
  }
}
