import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CreateEsignRequest, EsignRequestView } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";

const MANAGE = "esign.manage";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const day = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

/** The receipt ties the exact text, the person and the moment together; altering any one of them changes it. */
export const receiptOf = (bodySha: string, employeeId: string, signedName: string, signedAtIso: string) => sha(`${bodySha}|${employeeId}|${norm(signedName)}|${signedAtIso}`);

/**
 * Documents to sign. HR sends a text to one or more employees; each reads it and types their full name to agree, or declines with a reason.
 * This records agreement with the exact text; it is not a certified digital signature, and nobody signs on anyone else's behalf.
 */
@Injectable()
export class EsignService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly inbox: UserNotificationsService
  ) {}

  // ------------------------------------------------------------ HR
  async list(claims: RequestClaims, status?: string): Promise<EsignRequestView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const filter = status && ["pending", "signed", "declined", "cancelled"].includes(status) ? "AND r.status = $2" : "";
      const r = await c.query(`${SELECT} WHERE r.company_id = $1 ${filter} ORDER BY r.created_at DESC LIMIT 300`, filter ? [claims.company_id, status] : [claims.company_id]);
      return r.rows.map(toView);
    });
  }

  async create(claims: RequestClaims, input: CreateEsignRequest): Promise<{ created: number }> {
    await this.requireManage(claims);
    const title = (input.title ?? "").trim();
    const body = (input.body ?? "").trim();
    if (!title || title.length > 200) throw new BadRequestException("Give the document a title");
    if (!body || body.length > 20000) throw new BadRequestException("Paste the text people should read and agree to");
    const ids = [...new Set(input.employeeIds ?? [])];
    if (ids.length === 0 || ids.length > 1000) throw new BadRequestException("Choose who should sign (up to 1,000 people)");
    if (input.dueOn && (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) || input.dueOn < localToday())) throw new BadRequestException("The due date cannot be in the past");
    const people = await this.db.withClaims(claims, async (c) => {
      const emps = (await c.query("SELECT id, user_account_id FROM employees WHERE company_id = $1 AND id = ANY($2) AND employment_status = 'active'", [claims.company_id, ids])).rows;
      if (emps.length !== ids.length) throw new BadRequestException("Some of the chosen people are not active employees of this company");
      const bs = sha(body);
      for (const e of emps) await c.query("INSERT INTO esign_requests (company_id, employee_id, title, body, body_sha256, due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [claims.company_id, e.id, title, body, bs, input.dueOn || null, claims.sub]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "esign.create", target: title, metadata: { people: emps.length } });
      return emps;
    });
    const users = people.map((p) => p.user_account_id).filter(Boolean) as string[];
    if (users.length) await this.inbox.notify({ companyId: claims.company_id!, userAccountIds: users, category: "hr_inbox", title: `Please read and sign: ${title}`, body: input.dueOn ? `Due ${input.dueOn}` : "", link: "/app/ess/sign" });
    return { created: people.length };
  }

  async cancel(claims: RequestClaims, id: string): Promise<EsignRequestView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const cur = (await c.query("SELECT status FROM esign_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw new NotFoundException("Document not found");
      if (cur.status !== "pending") throw new ConflictException("Only a document that is still waiting can be cancelled");
      await c.query("UPDATE esign_requests SET status = 'cancelled' WHERE id = $1", [id]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "esign.cancel", target: id, metadata: {} });
      return toView((await c.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0]);
    });
  }

  // ------------------------------------------------------------ employee
  async mine(claims: RequestClaims): Promise<EsignRequestView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const r = await c.query(`${SELECT} WHERE r.employee_id = $1 AND r.status <> 'cancelled' ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`, [me.id]);
      return r.rows.map(toView);
    });
  }

  async count(claims: RequestClaims): Promise<{ waiting: number }> {
    return { waiting: (await this.mine(claims)).filter((r) => r.status === "pending").length };
  }

  /** Typing your own full name is the signature. It must match the name on your record, ignoring case and spacing. */
  async sign(claims: RequestClaims, id: string, typedName: string): Promise<EsignRequestView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const r = (await c.query("SELECT * FROM esign_requests WHERE id = $1 AND employee_id = $2 FOR UPDATE", [id, me.id])).rows[0];
      if (!r) throw new NotFoundException("Document not found");
      if (r.status !== "pending") throw new ConflictException("This document is no longer waiting for a signature");
      if (norm(typedName ?? "") !== norm(`${me.first_name} ${me.last_name}`)) throw new BadRequestException("Type your full name exactly as it appears on your record to sign");
      if (sha(r.body) !== r.body_sha256) throw new ConflictException("The text of this document has changed since it was sent. Ask HR to send it again.");
      const at = new Date();
      const receipt = receiptOf(r.body_sha256, me.id, typedName, at.toISOString());
      await c.query("UPDATE esign_requests SET status = 'signed', signed_name = $2, signed_at = $3, receipt_sha256 = $4 WHERE id = $1", [id, typedName.trim(), at, receipt]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "esign.sign", target: id, metadata: { receipt } });
      return toView((await c.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0]);
    });
  }

  async decline(claims: RequestClaims, id: string, reason: string): Promise<EsignRequestView> {
    await this.requireModule(claims);
    const why = (reason ?? "").trim();
    if (!why || why.length > 500) throw new BadRequestException("Say briefly why you are not signing");
    return this.db.withClaims(claims, async (c) => {
      const me = await this.myEmployee(c, claims);
      const r = (await c.query("SELECT status FROM esign_requests WHERE id = $1 AND employee_id = $2 FOR UPDATE", [id, me.id])).rows[0];
      if (!r) throw new NotFoundException("Document not found");
      if (r.status !== "pending") throw new ConflictException("This document is no longer waiting for a signature");
      await c.query("UPDATE esign_requests SET status = 'declined', decline_reason = $2 WHERE id = $1", [id, why]);
      await this.audit.record(c, claims, { companyId: claims.company_id ?? null, action: "esign.decline", target: id, metadata: {} });
      return toView((await c.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0]);
    });
  }

  /** Anyone with the receipt text can check that a stored signature still matches the stored text. */
  async verify(claims: RequestClaims, id: string): Promise<{ valid: boolean }> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = (await c.query("SELECT * FROM esign_requests WHERE id = $1 AND status = 'signed'", [id])).rows[0];
      if (!r) throw new NotFoundException("Signed document not found");
      const ok = sha(r.body) === r.body_sha256 && receiptOf(r.body_sha256, r.employee_id, r.signed_name, r.signed_at.toISOString()) === r.receipt_sha256;
      return { valid: ok };
    });
  }

  private async myEmployee(c: PoolClient, claims: RequestClaims) {
    const r = await c.query("SELECT id, first_name, last_name FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub]);
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string; first_name: string; last_name: string };
  }

  private async requireModule(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims) {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to send documents to sign");
  }
}

const SELECT = `SELECT r.*, trim(e.first_name || ' ' || e.last_name) AS employee_name FROM esign_requests r JOIN employees e ON e.id = r.employee_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(x: any): EsignRequestView {
  return {
    id: x.id,
    employeeId: x.employee_id,
    employeeName: x.employee_name,
    title: x.title,
    body: x.body,
    status: x.status,
    dueOn: day(x.due_on),
    signedName: x.signed_name,
    signedAt: x.signed_at ? x.signed_at.toISOString() : null,
    receipt: x.receipt_sha256,
    bodySha256: x.body_sha256,
    declineReason: x.decline_reason,
    createdAt: x.created_at.toISOString(),
  };
}
