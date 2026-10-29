import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  AnnouncementAdminView,
  AnnouncementDeliverySummary,
  AnnouncementReceiptView,
  AnnouncementView,
  MessagingChannelsView,
  SaveAnnouncementRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../mailer/mailer.service";
import { MessagingService } from "../messaging/messaging.service";
import { NotificationsService } from "../notifications/notifications.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";

const MODULE_KEY = "employee" as const;
const MANAGE = "announcement.manage";
const MAX_MESSAGES = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v?.toISOString ? v.toISOString() : v ?? null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10)) : null);

/** A visible announcement for employee `e` (alias) today ($2). */
const VISIBLE = `a.status = 'published' AND (a.expires_on IS NULL OR a.expires_on >= $2::date)
  AND (a.audience_type = 'all' OR (a.audience_type = 'org_unit' AND e.org_unit_id = ANY(a.audience_ids)) OR (a.audience_type = 'location' AND e.location_id = ANY(a.audience_ids)))`;

/**
 * The company notice board. HR writes and publishes; every employee in the audience sees it on their own board, can
 * confirm they have read it when HR asked for that, and is told through the bell (and optionally email, SMS or WhatsApp).
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly inbox: UserNotificationsService,
    private readonly mailer: MailerService,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService
  ) {}

  channels(): MessagingChannelsView {
    return this.messaging.status();
  }

  // ------------------------------------------------------------------ HR

  async listAdmin(claims: RequestClaims): Promise<AnnouncementAdminView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT a.*,
                (SELECT COUNT(*)::int FROM announcement_receipts x WHERE x.announcement_id = a.id AND x.read_at IS NOT NULL) AS read_count,
                (SELECT COUNT(*)::int FROM announcement_receipts x WHERE x.announcement_id = a.id AND x.acknowledged_at IS NOT NULL) AS ack_count,
                CASE WHEN a.audience_type = 'org_unit' THEN (SELECT COALESCE(array_agg(name ORDER BY name), '{}') FROM org_units WHERE id = ANY(a.audience_ids))
                     WHEN a.audience_type = 'location' THEN (SELECT COALESCE(array_agg(name ORDER BY name), '{}') FROM locations WHERE id = ANY(a.audience_ids))
                     ELSE '{}'::text[] END AS audience_names
           FROM announcements a WHERE a.company_id = $1 ORDER BY (a.status = 'draft') DESC, COALESCE(a.published_at, a.created_at) DESC LIMIT 200`,
        [claims.company_id]
      );
      const out: AnnouncementAdminView[] = [];
      for (const row of r.rows) out.push(this.toAdmin(row, await this.audienceCount(client, row)));
      return out;
    });
  }

  async create(claims: RequestClaims, input: SaveAnnouncementRequest): Promise<AnnouncementAdminView> {
    await this.requireManage(claims);
    const v = this.validate(input);
    this.assertChannels(v);
    const id = await this.db.withClaims(claims, async (client) => {
      await this.assertAudience(client, v.audienceType, v.audienceIds);
      const r = await client.query(
        `INSERT INTO announcements (company_id, title, body, priority, audience_type, audience_ids, pinned, require_ack, expires_on, send_email, send_sms, send_whatsapp, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [claims.company_id, v.title, v.body, v.priority, v.audienceType, v.audienceIds, v.pinned, v.requireAck, v.expiresOn, v.sendEmail, v.sendSms, v.sendWhatsapp, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "announcement.create", target: r.rows[0].id, metadata: { title: v.title } });
      return r.rows[0].id as string;
    });
    return input.publish ? this.publish(claims, id) : this.getAdmin(claims, id);
  }

  async update(claims: RequestClaims, id: string, input: SaveAnnouncementRequest): Promise<AnnouncementAdminView> {
    await this.requireManage(claims);
    const v = this.validate(input);
    await this.db.withClaims(claims, async (client) => {
      const row = await this.load(client, id);
      if (row.status === "archived") throw new ConflictException("An archived announcement cannot be changed");
      if (row.status === "draft") {
        this.assertChannels(v);
        await this.assertAudience(client, v.audienceType, v.audienceIds);
        await client.query(
          `UPDATE announcements SET title=$2, body=$3, priority=$4, audience_type=$5, audience_ids=$6::uuid[], pinned=$7, require_ack=$8, expires_on=$9,
                  send_email=$10, send_sms=$11, send_whatsapp=$12, updated_at=now() WHERE id=$1`,
          [id, v.title, v.body, v.priority, v.audienceType, v.audienceIds, v.pinned, v.requireAck, v.expiresOn, v.sendEmail, v.sendSms, v.sendWhatsapp]
        );
      } else {
        // once published, who got it and how cannot change; the wording, priority, pin and expiry can
        await client.query("UPDATE announcements SET title=$2, body=$3, priority=$4, pinned=$5, expires_on=$6, updated_at=now() WHERE id=$1", [id, v.title, v.body, v.priority, v.pinned, v.expiresOn]);
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "announcement.update", target: id, metadata: { status: row.status } });
    });
    return input.publish ? this.publish(claims, id) : this.getAdmin(claims, id);
  }

  async publish(claims: RequestClaims, id: string): Promise<AnnouncementAdminView> {
    await this.requireManage(claims);
    const today = localToday();
    const { row, people } = await this.db.withClaims(claims, async (client) => {
      const locked = (await client.query("SELECT * FROM announcements WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!locked) throw new NotFoundException("Announcement not found");
      if (locked.status !== "draft") throw new ConflictException(locked.status === "published" ? "This announcement is already published" : "An archived announcement cannot be published");
      if (locked.expires_on && day(locked.expires_on)! < today) throw new BadRequestException("The expiry date has already passed");
      this.assertChannels({ sendSms: locked.send_sms, sendWhatsapp: locked.send_whatsapp });
      await client.query("UPDATE announcements SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1", [id]);
      const recipients = await this.audienceRows(client, locked);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "announcement.publish", target: id, metadata: { audience: recipients.length } });
      return { row: locked, people: recipients };
    });

    const summary = await this.deliver(claims, row, people);
    await this.db.withClaims(claims, (client) => client.query("UPDATE announcements SET delivery_summary = $2::jsonb WHERE id = $1", [id, JSON.stringify(summary)]));
    return this.getAdmin(claims, id);
  }

  async archive(claims: RequestClaims, id: string): Promise<AnnouncementAdminView> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const row = await this.load(client, id);
      if (row.status === "archived") throw new ConflictException("This announcement is already archived");
      await client.query("UPDATE announcements SET status = 'archived', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "announcement.archive", target: id });
    });
    return this.getAdmin(claims, id);
  }

  /** Everyone in the audience with whether they read / confirmed. */
  async receipts(claims: RequestClaims, id: string): Promise<AnnouncementReceiptView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.load(client, id);
      const people = await this.audienceRows(client, row);
      const rec = await client.query("SELECT employee_id, read_at, acknowledged_at FROM announcement_receipts WHERE announcement_id = $1", [id]);
      const byEmp = new Map(rec.rows.map((x) => [x.employee_id as string, x]));
      return people
        .map((p) => ({
          employeeId: p.id as string,
          employeeNumber: p.employee_number as string,
          employeeName: `${p.first_name} ${p.last_name}`.trim(),
          readAt: iso(byEmp.get(p.id)?.read_at),
          acknowledgedAt: iso(byEmp.get(p.id)?.acknowledged_at),
        }))
        .sort((a, b) => Number(!!a.readAt) - Number(!!b.readAt) || a.employeeName.localeCompare(b.employeeName));
    });
  }

  // ------------------------------------------------------------------ employee

  async mine(claims: RequestClaims): Promise<AnnouncementView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.myEmployee(client, claims);
      const r = await client.query(
        `SELECT a.*, rc.read_at, rc.acknowledged_at
           FROM announcements a
           JOIN employees e ON e.id = $1 AND e.company_id = a.company_id
           LEFT JOIN announcement_receipts rc ON rc.announcement_id = a.id AND rc.employee_id = e.id
          WHERE ${VISIBLE}
          ORDER BY a.pinned DESC, a.published_at DESC LIMIT 100`,
        [emp.id, localToday()]
      );
      return r.rows.map(
        (x): AnnouncementView => ({
          id: x.id, title: x.title, body: x.body, priority: x.priority, pinned: x.pinned, requireAck: x.require_ack,
          publishedAt: iso(x.published_at)!, expiresOn: day(x.expires_on), read: !!x.read_at, acknowledged: !!x.acknowledged_at,
        })
      );
    });
  }

  /** How many are unread and how many still wait for a confirmation (the badge). */
  async summary(claims: RequestClaims): Promise<{ unread: number; needsAck: number }> {
    const list = await this.mine(claims);
    return { unread: list.filter((a) => !a.read).length, needsAck: list.filter((a) => a.requireAck && !a.acknowledged).length };
  }

  async markRead(claims: RequestClaims, id: string): Promise<void> {
    await this.touch(claims, id, false);
  }

  async acknowledge(claims: RequestClaims, id: string): Promise<void> {
    await this.touch(claims, id, true);
  }

  // ------------------------------------------------------------------ internals

  private async touch(claims: RequestClaims, id: string, ack: boolean): Promise<void> {
    await this.requireModule(claims);
    await this.db.withClaims(claims, async (client) => {
      const emp = await this.myEmployee(client, claims);
      const vis = await client.query(`SELECT a.id, a.require_ack FROM announcements a JOIN employees e ON e.id = $1 AND e.company_id = a.company_id WHERE a.id = $3 AND ${VISIBLE}`, [emp.id, localToday(), id]);
      if (!vis.rowCount) throw new NotFoundException("Announcement not found");
      if (ack && !vis.rows[0].require_ack) throw new BadRequestException("This announcement does not need a confirmation");
      await client.query(
        `INSERT INTO announcement_receipts (announcement_id, employee_id, company_id, read_at, acknowledged_at)
         VALUES ($1, $2, $3, now(), CASE WHEN $4 THEN now() END)
         ON CONFLICT (announcement_id, employee_id) DO UPDATE
           SET read_at = COALESCE(announcement_receipts.read_at, now()),
               acknowledged_at = CASE WHEN $4 THEN COALESCE(announcement_receipts.acknowledged_at, now()) ELSE announcement_receipts.acknowledged_at END`,
        [id, emp.id, emp.company_id, ack]
      );
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async deliver(claims: RequestClaims, row: any, people: any[]): Promise<AnnouncementDeliverySummary> {
    const summary: AnnouncementDeliverySummary = { recipients: people.length };
    const link = "/app/announcements";
    await this.inbox.notify({
      companyId: claims.company_id!, userAccountIds: people.map((p) => p.user_account_id), category: "announcements",
      title: `${row.priority === "urgent" ? "URGENT: " : ""}${row.title}`, body: String(row.body).slice(0, 300), link,
    });
    const text = `${row.title}\n\n${row.body}`.slice(0, 1000);
    if (row.send_email && this.mailer.isConfigured()) {
      const optedOut = await this.inbox.emailOptedOut(people.map((p) => p.user_account_id), "announcements");
      const base = process.env.APP_BASE_URL ?? "http://localhost:5173";
      let sent = 0;
      for (const p of people) {
        const to = p.email ?? p.account_email;
        if (!to || (p.user_account_id && optedOut.has(p.user_account_id))) continue;
        try {
          await this.mailer.sendMail({ to, subject: row.title, text: `${row.body}\n\n${base}${link}` });
          sent++;
        } catch {
          /* counted as not sent */
        }
      }
      summary.email = sent;
    }
    for (const channel of ["sms", "whatsapp"] as const) {
      if (!(channel === "sms" ? row.send_sms : row.send_whatsapp)) continue;
      let ok = 0;
      let failed = 0;
      let noPhone = 0;
      const targets: Array<{ to: string }> = [];
      for (const p of people) {
        const to = MessagingService.normalizePhone(p.phone);
        if (to) targets.push({ to });
        else noPhone++;
      }
      for (let i = 0; i < Math.min(targets.length, MAX_MESSAGES); i += 10) {
        const batch = targets.slice(i, i + 10);
        const results = await Promise.all(batch.map((t) => this.notifications.dispatch(claims, { channel, recipient: t.to, templateKey: "announcement", payload: { announcementId: row.id, text } }).catch(() => null)));
        for (const res of results) (res && res.status === "sent" ? ok++ : failed++);
      }
      failed += Math.max(0, targets.length - MAX_MESSAGES);
      if (channel === "sms") Object.assign(summary, { smsSent: ok, smsFailed: failed });
      else Object.assign(summary, { whatsappSent: ok, whatsappFailed: failed });
      summary.noPhone = Math.max(summary.noPhone ?? 0, noPhone);
    }
    return summary;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async audienceRows(client: PoolClient, a: any) {
    const r = await client.query(
      `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.user_account_id, e.phone, e.email, u.email AS account_email
         FROM employees e LEFT JOIN user_accounts u ON u.id = e.user_account_id
        WHERE e.company_id = $1 AND e.employment_status = 'active'
          AND ($2 = 'all' OR ($2 = 'org_unit' AND e.org_unit_id = ANY($3::uuid[])) OR ($2 = 'location' AND e.location_id = ANY($3::uuid[])))
        ORDER BY e.employee_number`,
      [a.company_id, a.audience_type, a.audience_ids]
    );
    return r.rows;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async audienceCount(client: PoolClient, a: any): Promise<number> {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n FROM employees e WHERE e.company_id = $1 AND e.employment_status = 'active'
          AND ($2 = 'all' OR ($2 = 'org_unit' AND e.org_unit_id = ANY($3::uuid[])) OR ($2 = 'location' AND e.location_id = ANY($3::uuid[])))`,
      [a.company_id, a.audience_type, a.audience_ids]
    );
    return r.rows[0].n;
  }

  private async getAdmin(claims: RequestClaims, id: string): Promise<AnnouncementAdminView> {
    const all = await this.listAdmin(claims);
    const found = all.find((a) => a.id === id);
    if (!found) throw new NotFoundException("Announcement not found");
    return found;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toAdmin(r: any, audienceCount: number): AnnouncementAdminView {
    return {
      id: r.id, title: r.title, body: r.body, priority: r.priority, audienceType: r.audience_type, audienceIds: r.audience_ids ?? [],
      audienceNames: r.audience_names ?? [], pinned: r.pinned, requireAck: r.require_ack, status: r.status, expiresOn: day(r.expires_on),
      sendEmail: r.send_email, sendSms: r.send_sms, sendWhatsapp: r.send_whatsapp, deliverySummary: r.delivery_summary ?? {},
      publishedAt: iso(r.published_at), createdAt: iso(r.created_at)!, audienceCount, readCount: r.read_count ?? 0, acknowledgedCount: r.ack_count ?? 0,
    };
  }

  private validate(input: SaveAnnouncementRequest) {
    const title = (input.title ?? "").trim();
    const body = (input.body ?? "").trim();
    if (!title) throw new BadRequestException("Give the announcement a title");
    if (title.length > 200) throw new BadRequestException("Keep the title under 200 characters");
    if (!body) throw new BadRequestException("Write the announcement");
    if (body.length > 10000) throw new BadRequestException("Keep the announcement under 10,000 characters");
    const audienceType = input.audienceType ?? "all";
    const audienceIds = audienceType === "all" ? [] : Array.from(new Set(input.audienceIds ?? []));
    if (audienceType !== "all" && audienceIds.length === 0) throw new BadRequestException(`Choose at least one ${audienceType === "org_unit" ? "department" : "location"}`);
    if (input.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn)) throw new BadRequestException("Expiry must be a valid date");
    return {
      title, body, audienceType, audienceIds, priority: input.priority ?? "normal", pinned: !!input.pinned, requireAck: !!input.requireAck,
      expiresOn: input.expiresOn || null, sendEmail: !!input.sendEmail, sendSms: !!input.sendSms, sendWhatsapp: !!input.sendWhatsapp,
    };
  }

  private assertChannels(v: { sendSms?: boolean; sendWhatsapp?: boolean }) {
    if (v.sendSms && !this.messaging.isConfigured("sms")) throw new BadRequestException("SMS is not set up yet, so it cannot be used. Ask your administrator to connect an SMS provider.");
    if (v.sendWhatsapp && !this.messaging.isConfigured("whatsapp")) throw new BadRequestException("WhatsApp is not set up yet, so it cannot be used. Ask your administrator to connect WhatsApp.");
  }

  private async assertAudience(client: PoolClient, type: string, ids: string[]) {
    if (type === "all") return;
    const table = type === "org_unit" ? "org_units" : "locations";
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    if (r.rows[0].n !== ids.length) throw new BadRequestException(`One of the chosen ${type === "org_unit" ? "departments" : "locations"} does not exist`);
  }

  private async load(client: PoolClient, id: string) {
    const r = await client.query("SELECT * FROM announcements WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Announcement not found");
    return r.rows[0];
  }

  private async myEmployee(client: PoolClient, claims: RequestClaims) {
    const r = await client.query("SELECT id, company_id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub]);
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string; company_id: string };
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to manage announcements");
  }
}
