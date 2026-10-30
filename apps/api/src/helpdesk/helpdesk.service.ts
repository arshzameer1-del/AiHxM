import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { HelpdeskCategoryView, HelpdeskMessageView, HelpdeskSummaryView, HelpdeskTicketStatus, HelpdeskTicketView, RaiseHelpdeskTicketRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";

const MANAGE = "helpdesk.manage";
const MAX_OPEN_PER_PERSON = 10;
const STARTER_CATEGORIES = ["Payroll and payslips", "Leave and attendance", "Benefits and loans", "Letters and documents", "Something else"];

const TICKET_SELECT = `
  SELECT t.*, trim(e.first_name || ' ' || e.last_name) AS employee_name,
         (t.respond_by IS NOT NULL AND t.first_response_at IS NULL AND t.status <> 'resolved' AND now() > t.respond_by) AS overdue,
         floor(extract(epoch FROM (COALESCE(t.resolved_at, now()) - t.created_at)) / 3600)::int AS age_hours
    FROM helpdesk_tickets t JOIN employees e ON e.id = t.employee_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTicket(t: any): HelpdeskTicketView {
  return {
    id: t.id,
    employeeId: t.employee_id,
    employeeName: t.employee_name,
    categoryName: t.category_name,
    subject: t.subject,
    status: t.status,
    slaHours: t.sla_hours,
    respondBy: t.respond_by ? t.respond_by.toISOString() : null,
    firstResponseAt: t.first_response_at ? t.first_response_at.toISOString() : null,
    responseOverdue: Boolean(t.overdue),
    ageHours: t.age_hours,
    createdAt: t.created_at.toISOString(),
    resolvedAt: t.resolved_at ? t.resolved_at.toISOString() : null,
  };
}

/**
 * HR help desk. An employee raises a question, HR answers in a thread, and each category can carry a target time for the first reply.
 * The clock counts calendar hours (not working hours) and only measures; nothing is escalated or sent on its own.
 */
@Injectable()
export class HelpdeskService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly inbox: UserNotificationsService
  ) {}

  // -------------------------------------------------------------- employee side
  async categoriesForEmployee(claims: RequestClaims): Promise<HelpdeskCategoryView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (c) => (await c.query("SELECT * FROM helpdesk_categories WHERE company_id = $1 AND is_active ORDER BY name", [claims.company_id])).rows.map(toCategory));
  }

  async mine(claims: RequestClaims): Promise<HelpdeskTicketView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const r = await c.query(`${TICKET_SELECT} WHERE t.employee_id = $1 ORDER BY (t.status = 'resolved'), t.created_at DESC LIMIT 100`, [me.id]);
      return r.rows.map(toTicket);
    });
  }

  async raise(claims: RequestClaims, input: RaiseHelpdeskTicketRequest): Promise<HelpdeskTicketView> {
    await this.requireModule(claims);
    const subject = (input.subject ?? "").trim();
    const body = (input.body ?? "").trim();
    if (!subject || subject.length > 200) throw new BadRequestException("Give your question a short title");
    if (!body || body.length > 4000) throw new BadRequestException("Describe your question");
    const id = await this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const open = (await c.query("SELECT count(*)::int AS n FROM helpdesk_tickets WHERE employee_id = $1 AND status <> 'resolved'", [me.id])).rows[0].n as number;
      if (open >= MAX_OPEN_PER_PERSON) throw new BadRequestException(`You already have ${MAX_OPEN_PER_PERSON} open questions. Wait for answers or close some first.`);
      let cat: { id: string; name: string; sla_hours: number | null } | null = null;
      if (input.categoryId) {
        cat = (await c.query("SELECT id, name, sla_hours FROM helpdesk_categories WHERE id = $1 AND company_id = $2 AND is_active", [input.categoryId, claims.company_id])).rows[0] ?? null;
        if (!cat) throw new BadRequestException("That category is not available");
      }
      const t = await c.query(
        `INSERT INTO helpdesk_tickets (company_id, employee_id, category_id, category_name, subject, sla_hours, respond_by)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(hours => $6::int) END) RETURNING id`,
        [claims.company_id, me.id, cat?.id ?? null, cat?.name ?? null, subject, cat?.sla_hours ?? null]
      );
      await c.query("INSERT INTO helpdesk_messages (ticket_id, company_id, author_user_id, from_hr, body) VALUES ($1,$2,$3,false,$4)", [t.rows[0].id, claims.company_id, claims.sub, body]);
      return t.rows[0].id as string;
    });
    const view = await this.getFor(claims, id, false);
    await this.inbox.notify({ companyId: claims.company_id!, userAccountIds: await this.inbox.hrAdminUserIds(claims.company_id!), category: "hr_inbox", title: `${view.employeeName} asked: ${subject}`, body: body.slice(0, 200), link: "/app/employees/helpdesk" });
    return view;
  }

  async getMine(claims: RequestClaims, id: string): Promise<HelpdeskTicketView> {
    await this.requireModule(claims);
    return this.getFor(claims, id, false);
  }

  async reply(claims: RequestClaims, id: string, bodyIn: string): Promise<HelpdeskTicketView> {
    await this.requireModule(claims);
    const body = (bodyIn ?? "").trim();
    if (!body || body.length > 4000) throw new BadRequestException("Write your reply");
    const hr = await this.rbac.can(claims, MANAGE);
    const info = await this.db.withClaims(claims, async (c) => {
      const t = (await c.query("SELECT * FROM helpdesk_tickets WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw new NotFoundException("Question not found");
      let fromHr = false;
      if (hr) fromHr = true;
      else {
        const me = await this.myEmployee(c, claims);
        if (t.employee_id !== me.id) throw new NotFoundException("Question not found");
      }
      if (fromHr && t.status === "resolved") throw new ConflictException("This question is resolved. Ask the employee to reopen it by replying.");
      await c.query("INSERT INTO helpdesk_messages (ticket_id, company_id, author_user_id, from_hr, body) VALUES ($1,$2,$3,$4,$5)", [id, claims.company_id, claims.sub, fromHr, body]);
      const next: HelpdeskTicketStatus = fromHr ? "waiting_on_employee" : "open";
      await c.query(
        `UPDATE helpdesk_tickets SET status = $2, updated_at = now(), resolved_at = NULL,
                first_response_at = CASE WHEN $3 AND first_response_at IS NULL THEN now() ELSE first_response_at END WHERE id = $1`,
        [id, next, fromHr]
      );
      if (fromHr) await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "helpdesk.reply", target: id, metadata: {} });
      return { fromHr, employeeId: t.employee_id as string, subject: t.subject as string };
    });
    if (info.fromHr) {
      const uid = (await this.db.withClaims(claims, async (c) => (await c.query("SELECT user_account_id FROM employees WHERE id = $1", [info.employeeId])).rows[0]?.user_account_id)) as string | null;
      if (uid) await this.inbox.notify({ companyId: claims.company_id!, userAccountIds: [uid], category: "request_decisions", title: `HR replied: ${info.subject}`, body: body.slice(0, 200), link: "/app/ess/helpdesk" });
    } else {
      await this.inbox.notify({ companyId: claims.company_id!, userAccountIds: await this.inbox.hrAdminUserIds(claims.company_id!), category: "hr_inbox", title: `New reply: ${info.subject}`, body: body.slice(0, 200), link: "/app/employees/helpdesk" });
    }
    return this.getFor(claims, id, hr);
  }

  /** The employee can close their own question; HR can resolve any. */
  async resolve(claims: RequestClaims, id: string): Promise<HelpdeskTicketView> {
    await this.requireModule(claims);
    const hr = await this.rbac.can(claims, MANAGE);
    await this.db.withClaims(claims, async (c) => {
      const t = (await c.query("SELECT * FROM helpdesk_tickets WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw new NotFoundException("Question not found");
      if (!hr && t.employee_id !== (await this.myEmployee(c, claims)).id) throw new NotFoundException("Question not found");
      if (t.status === "resolved") throw new ConflictException("Already resolved");
      await c.query("UPDATE helpdesk_tickets SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1", [id]);
      if (hr) await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "helpdesk.resolve", target: id, metadata: {} });
    });
    return this.getFor(claims, id, hr);
  }

  // -------------------------------------------------------------- HR side
  async queue(claims: RequestClaims, status?: string): Promise<HelpdeskTicketView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const where = status === "overdue" ? "AND (t.respond_by IS NOT NULL AND t.first_response_at IS NULL AND t.status <> 'resolved' AND now() > t.respond_by)" : status && ["open", "waiting_on_employee", "resolved"].includes(status) ? "AND t.status = $2" : "AND t.status <> 'resolved'";
      const params: unknown[] = [claims.company_id];
      if (status && ["open", "waiting_on_employee", "resolved"].includes(status)) params.push(status);
      const r = await c.query(`${TICKET_SELECT} WHERE t.company_id = $1 ${where} ORDER BY (t.respond_by IS NULL), t.respond_by NULLS LAST, t.created_at ASC LIMIT 300`, params);
      return r.rows.map(toTicket);
    });
  }

  async getAdmin(claims: RequestClaims, id: string): Promise<HelpdeskTicketView> {
    await this.requireManage(claims);
    return this.getFor(claims, id, true);
  }

  async summary(claims: RequestClaims): Promise<HelpdeskSummaryView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = (
        await c.query(
          `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'waiting_on_employee')::int AS waiting,
                  count(*) FILTER (WHERE respond_by IS NOT NULL AND first_response_at IS NULL AND status <> 'resolved' AND now() > respond_by)::int AS overdue,
                  count(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - interval '30 days')::int AS resolved30,
                  avg(extract(epoch FROM (first_response_at - created_at)) / 3600) FILTER (WHERE first_response_at IS NOT NULL AND created_at > now() - interval '90 days') AS avg_first
             FROM helpdesk_tickets WHERE company_id = $1`,
          [claims.company_id]
        )
      ).rows[0];
      return { open: r.open, waitingOnEmployee: r.waiting, overdue: r.overdue, resolvedLast30Days: r.resolved30, averageFirstResponseHours: r.avg_first === null ? null : Math.round(Number(r.avg_first) * 10) / 10 };
    });
  }

  async categoriesAdmin(claims: RequestClaims): Promise<HelpdeskCategoryView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => (await c.query("SELECT * FROM helpdesk_categories WHERE company_id = $1 ORDER BY is_active DESC, name", [claims.company_id])).rows.map(toCategory));
  }

  async saveCategory(claims: RequestClaims, input: { id?: string; name: string; slaHours?: number | null; isActive?: boolean }): Promise<HelpdeskCategoryView[]> {
    await this.requireManage(claims);
    const name = (input.name ?? "").trim();
    if (!name || name.length > 60) throw new BadRequestException("Give the category a name");
    const sla = input.slaHours === undefined || input.slaHours === null ? null : Number(input.slaHours);
    if (sla !== null && (!Number.isInteger(sla) || sla < 1 || sla > 720)) throw new BadRequestException("The first-reply target must be a whole number of hours between 1 and 720");
    await this.db.withClaims(claims, async (c) => {
      try {
        if (input.id) {
          const r = await c.query("UPDATE helpdesk_categories SET name = $2, sla_hours = $3, is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING id", [input.id, name, sla, input.isActive ?? null]);
          if (!r.rowCount) throw new NotFoundException("Category not found");
        } else {
          await c.query("INSERT INTO helpdesk_categories (company_id, name, sla_hours) VALUES ($1,$2,$3)", [claims.company_id, name, sla]);
        }
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ConflictException("A category with this name already exists");
        throw e;
      }
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "helpdesk.category.save", target: input.id ?? name, metadata: { slaHours: sla } });
    });
    return this.categoriesAdmin(claims);
  }

  /** Adds a few common categories without any target time. Nothing is added until HR asks. */
  async addStarterCategories(claims: RequestClaims): Promise<HelpdeskCategoryView[]> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (c) => {
      for (const n of STARTER_CATEGORIES) await c.query("INSERT INTO helpdesk_categories (company_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [claims.company_id, n]);
    });
    return this.categoriesAdmin(claims);
  }

  // -------------------------------------------------------------- shared
  private async getFor(claims: RequestClaims, id: string, asHr: boolean): Promise<HelpdeskTicketView> {
    return this.db.withClaims(claims, async (c) => {
      const t = (await c.query(`${TICKET_SELECT} WHERE t.id = $1`, [id])).rows[0];
      if (!t) throw new NotFoundException("Question not found");
      if (!asHr && t.employee_id !== (await this.myEmployee(c, claims)).id) throw new NotFoundException("Question not found");
      const m = await c.query(
        `SELECT m.*, COALESCE(NULLIF(trim(e.first_name || ' ' || e.last_name), ''), u.email, 'Someone') AS author
           FROM helpdesk_messages m LEFT JOIN user_accounts u ON u.id = m.author_user_id LEFT JOIN employees e ON e.user_account_id = m.author_user_id AND e.company_id = m.company_id
          WHERE m.ticket_id = $1 ORDER BY m.created_at`,
        [id]
      );
      const messages: HelpdeskMessageView[] = m.rows.map((x) => ({ id: x.id, fromHr: x.from_hr, authorName: x.from_hr ? "HR" : x.author, body: x.body, createdAt: x.created_at.toISOString() }));
      return { ...toTicket(t), messages };
    });
  }

  private async myEmployee(c: PoolClient, claims: RequestClaims) {
    const r = await c.query("SELECT id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub]);
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string };
  }

  private async requireModule(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims) {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to manage the help desk");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCategory(x: any): HelpdeskCategoryView {
  return { id: x.id, name: x.name, slaHours: x.sla_hours, isActive: x.is_active };
}
