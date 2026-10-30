import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { ColleagueView, GiveRecognitionRequest, RecognitionView } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";

const DAILY_LIMIT = 10;
const name = (e: { first_name: string; last_name: string }) => `${e.first_name} ${e.last_name}`.trim();

/**
 * A company-wide thank-you feed. A person writes a short message to a colleague; the colleague is told; everyone in the company can read it.
 * No points, no prizes and nothing paid: it is only words. HR can hide a message that should not be there.
 */
@Injectable()
export class RecognitionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly inbox: UserNotificationsService
  ) {}

  async feed(claims: RequestClaims): Promise<RecognitionView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (c) => {
      const me = (await c.query("SELECT id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub])).rows[0] as { id: string } | undefined;
      const r = await c.query(
        `SELECT g.*, f.first_name AS ff, f.last_name AS fl, t.first_name AS tf, t.last_name AS tl
           FROM recognitions g JOIN employees f ON f.id = g.from_employee_id JOIN employees t ON t.id = g.to_employee_id
          WHERE g.company_id = $1 AND g.hidden_at IS NULL ORDER BY g.created_at DESC LIMIT 100`,
        [claims.company_id]
      );
      return r.rows.map((g) => ({
        id: g.id,
        fromName: name({ first_name: g.ff, last_name: g.fl }),
        toName: name({ first_name: g.tf, last_name: g.tl }),
        toEmployeeId: g.to_employee_id,
        message: g.message,
        valueTag: g.value_tag,
        givenOn: String(g.given_on instanceof Date ? g.given_on.toISOString() : g.given_on).slice(0, 10),
        createdAt: g.created_at.toISOString(),
        mine: !!me && (g.from_employee_id === me.id || g.to_employee_id === me.id),
      }));
    });
  }

  /** Name search for the "who do you want to thank" box. Names only. */
  async colleagues(claims: RequestClaims, q: string): Promise<ColleagueView[]> {
    await this.requireModule(claims);
    const term = (q ?? "").trim();
    if (term.length < 2) return [];
    return this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const r = await c.query(
        `SELECT id, first_name, last_name, employee_number FROM employees
          WHERE company_id = $1 AND employment_status = 'active' AND id <> $2 AND (first_name || ' ' || last_name) ILIKE $3
          ORDER BY first_name, last_name LIMIT 20`,
        [claims.company_id, me.id, `%${term.replace(/[%_\\]/g, "\\$&")}%`]
      );
      return r.rows.map((e) => ({ id: e.id, name: name(e), employeeNumber: e.employee_number }));
    });
  }

  async give(claims: RequestClaims, input: GiveRecognitionRequest): Promise<{ ok: true }> {
    await this.requireModule(claims);
    const message = (input.message ?? "").trim();
    const tag = input.valueTag?.trim() || null;
    if (!message || message.length > 500) throw new BadRequestException("Write a short message, up to 500 characters");
    if (tag && tag.length > 40) throw new BadRequestException("The tag can be up to 40 characters");
    const today = localToday();
    const target = await this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      if (input.toEmployeeId === me.id) throw new BadRequestException("You can thank a colleague, not yourself");
      const to = (await c.query("SELECT id, user_account_id, first_name, last_name FROM employees WHERE id = $1 AND company_id = $2 AND employment_status = 'active'", [input.toEmployeeId, claims.company_id])).rows[0];
      if (!to) throw new NotFoundException("Colleague not found");
      const used = (await c.query("SELECT count(*)::int AS n FROM recognitions WHERE from_employee_id = $1 AND given_on = $2::date", [me.id, today])).rows[0].n as number;
      if (used >= DAILY_LIMIT) throw new BadRequestException(`You have already sent ${DAILY_LIMIT} thank-yous today. Try again tomorrow.`);
      const r = await c.query("INSERT INTO recognitions (company_id, from_employee_id, to_employee_id, message, value_tag, given_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [claims.company_id, me.id, to.id, message, tag, today]);
      const from = (await c.query("SELECT first_name, last_name FROM employees WHERE id = $1", [me.id])).rows[0];
      return { id: r.rows[0].id as string, userId: to.user_account_id as string | null, fromName: name(from) };
    });
    if (target.userId) {
      await this.inbox.notify({ companyId: claims.company_id!, userAccountIds: [target.userId], category: "announcements", title: `${target.fromName} thanked you`, body: message, link: "/app/ess/recognition" });
    }
    return { ok: true };
  }

  async hide(claims: RequestClaims, id: string): Promise<{ ok: true }> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "recognition.moderate"))) throw new ForbiddenException("Not permitted to hide a thank-you");
    await this.db.withClaims(claims, async (c) => {
      const r = await c.query("UPDATE recognitions SET hidden_at = now(), hidden_by = $2 WHERE id = $1 AND hidden_at IS NULL RETURNING id", [id, claims.sub]);
      if (!r.rowCount) throw new NotFoundException("Thank-you not found");
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "recognition.hide", target: id, metadata: {} });
    });
    return { ok: true };
  }

  async canModerate(claims: RequestClaims): Promise<boolean> {
    return this.rbac.can(claims, "recognition.moderate");
  }

  private async myEmployee(c: import("pg").PoolClient, claims: RequestClaims) {
    const r = await c.query("SELECT id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub]);
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string };
  }

  private async requireModule(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
  }
}
