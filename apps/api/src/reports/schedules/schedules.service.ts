import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { ReportDatePreset, ReportDeliverySummary, ReportExportFormat, ReportInboxItem, ReportScheduleSummary, SaveScheduleRequest, ShareGrantee } from "@aihxm/shared-types";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { MailerService } from "../../mailer/mailer.service";
import { REPORT_BY_ID } from "../catalog/report-catalog";
import { DATE_PRESETS } from "../engine/presets";
import { UUID_RE } from "../engine/sql";
import { EXPORT_FORMATS, ExportService } from "../export/export.service";
import { ReportsService } from "../reports.service";
import { ReportRunnerService, type ReportSource } from "../saved/runner.service";
import { SavedReportsService } from "../saved/saved-reports.service";
import { nextLocalRun, recipientMayReceive } from "./schedule-time";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "report-scheduler" };
export const MAX_RECIPIENTS = 25;
export const MAX_SCHEDULES_PER_USER = 20;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TTL_DAYS = 14;
export const FAILURE_LIMIT = 3;
const PRESET_KEY = "__preset";

type ScheduleRow = {
  id: string;
  company_id: string;
  owner_user_account_id: string;
  name: string;
  saved_report_id: string | null;
  report_id: string | null;
  filters: Record<string, unknown>;
  frequency: "daily" | "weekly" | "monthly";
  day_of_week: number | null;
  day_of_month: number | null;
  hour_local: number;
  format: ReportExportFormat;
  recipients: string[];
  status: "active" | "paused" | "failed";
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_status: string | null;
  consecutive_failures: number;
  owner_name?: string | null;
  saved_name?: string | null;
};

const SELECT = `
  SELECT s.*, (SELECT TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) FROM employees e WHERE e.user_account_id = s.owner_user_account_id AND e.company_id = s.company_id LIMIT 1) AS owner_name,
         (SELECT sr.name FROM saved_reports sr WHERE sr.id = s.saved_report_id) AS saved_name
    FROM report_schedules s`;

type Err = Error & { getStatus?: () => number };

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService,
    private readonly saved: SavedReportsService,
    private readonly runner: ReportRunnerService,
    private readonly exports: ExportService,
    private readonly mailer: MailerService
  ) {}

  // ------------------------------------------------------------------ helpers

  private claimsOf(companyId: string, userId: string): RequestClaims {
    return { is_platform_admin: false, company_id: companyId, sub: userId };
  }

  private async need(claims: RequestClaims): Promise<void> {
    const ctx = await this.reports.callerContext(claims);
    if (!ctx.held.has("reports.schedule")) throw new ForbiddenException("Not permitted to schedule reports");
  }

  /** Local date and hour in the company's zone, and the instant a local date+hour corresponds to. */
  private async localNow(client: { query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, companyId: string): Promise<{ tz: string; date: string; hour: number }> {
    const r = await client.query(
      `SELECT COALESCE((SELECT c.timezone FROM companies c JOIN pg_timezone_names n ON n.name = c.timezone WHERE c.id = $1), 'UTC') AS tz`,
      [companyId]
    );
    const tz = String(r.rows[0]?.tz ?? "UTC");
    const n = await client.query(`SELECT ((now() AT TIME ZONE $1)::date)::text AS d, EXTRACT(HOUR FROM now() AT TIME ZONE $1)::int AS h`, [tz]);
    return { tz, date: String(n.rows[0]?.d), hour: Number(n.rows[0]?.h) };
  }

  private async nextInstant(client: Parameters<SchedulesService["localNow"]>[0], companyId: string, rule: { frequency: "daily" | "weekly" | "monthly"; dayOfWeek: number | null; dayOfMonth: number | null; hourLocal: number }): Promise<Date> {
    const now = await this.localNow(client, companyId);
    const next = nextLocalRun(rule, { date: now.date, hour: now.hour });
    const r = await client.query(`SELECT (($1::date + make_interval(hours => $2::int))::timestamp AT TIME ZONE $3) AS at`, [next.date, next.hour, now.tz]);
    return r.rows[0]?.at as Date;
  }

  private presetOf(filters: Record<string, unknown>): ReportDatePreset | null {
    const p = filters[PRESET_KEY];
    return typeof p === "string" && (DATE_PRESETS as readonly string[]).includes(p) && p !== "custom" ? (p as ReportDatePreset) : null;
  }

  private cleanFilters(filters: Record<string, unknown>): Record<string, unknown> {
    const { [PRESET_KEY]: _p, ...rest } = filters;
    return rest;
  }

  private async sourceOf(owner: RequestClaims, s: ScheduleRow): Promise<ReportSource> {
    if (s.saved_report_id) return (await this.saved.sourceFor(owner, s.saved_report_id)).source;
    return { kind: "catalog", reportId: s.report_id as string, filters: this.cleanFilters(s.filters), preset: this.presetOf(s.filters), compare: false };
  }

  private titleOf(s: ScheduleRow): string {
    return s.saved_name ?? (s.report_id ? REPORT_BY_ID.get(s.report_id)?.title ?? s.report_id : "Report");
  }

  private async recipientLabels(client: Parameters<SchedulesService["localNow"]>[0], companyId: string, ids: string[]): Promise<ShareGrantee[]> {
    if (!ids.length) return [];
    const r = await client.query(
      `SELECT e.user_account_id::text AS id, TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS label FROM employees e WHERE e.company_id = $1 AND e.user_account_id = ANY($2::uuid[])`,
      [companyId, ids]
    );
    const byId = new Map(r.rows.map((x) => [String(x.id), String(x.label)]));
    return ids.map((id) => ({ type: "user" as const, id, label: byId.get(id) ?? "Unknown" }));
  }

  private async summary(claims: RequestClaims, s: ScheduleRow, warnings?: string[]): Promise<ReportScheduleSummary> {
    const recipients = await this.db.withClaims(claims, (c) => this.recipientLabels(c, s.company_id, s.recipients));
    return {
      id: s.id,
      name: s.name,
      reportId: s.report_id,
      savedReportId: s.saved_report_id,
      reportTitle: this.titleOf(s),
      frequency: s.frequency,
      dayOfWeek: s.day_of_week,
      dayOfMonth: s.day_of_month,
      hourLocal: s.hour_local,
      format: s.format,
      recipients,
      status: s.status,
      nextRunAt: s.next_run_at?.toISOString() ?? null,
      lastRunAt: s.last_run_at?.toISOString() ?? null,
      lastStatus: s.last_status,
      isOwner: s.owner_user_account_id === claims.sub,
      ...(warnings ? { warnings } : {}),
    };
  }

  // ------------------------------------------------------------------ CRUD

  async list(claims: RequestClaims): Promise<ReportScheduleSummary[]> {
    await this.need(claims);
    const rows = await this.db.withClaims(claims, async (c) => (await c.query<ScheduleRow>(`${SELECT} WHERE s.owner_user_account_id = $1 ORDER BY s.created_at DESC LIMIT 100`, [claims.sub])).rows);
    return Promise.all(rows.map((r) => this.summary(claims, r)));
  }

  private async mustOwn(claims: RequestClaims, id: string): Promise<ScheduleRow> {
    if (!UUID_RE.test(id)) throw new NotFoundException("No such schedule");
    await this.need(claims);
    const row = await this.db.withClaims(claims, async (c) => (await c.query<ScheduleRow>(`${SELECT} WHERE s.id = $1 AND s.owner_user_account_id = $2`, [id, claims.sub])).rows[0]);
    if (!row) throw new NotFoundException("No such schedule");
    return row;
  }

  private validate(body: SaveScheduleRequest): void {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 120) throw new BadRequestException("Give the schedule a name of up to 120 characters");
    if (!["daily", "weekly", "monthly"].includes(body.frequency)) throw new BadRequestException("Choose daily, weekly or monthly");
    if (!Number.isInteger(body.hourLocal) || body.hourLocal < 0 || body.hourLocal > 23) throw new BadRequestException("Choose an hour from 0 to 23");
    if (body.frequency === "weekly" && !(Number.isInteger(body.dayOfWeek) && (body.dayOfWeek as number) >= 0 && (body.dayOfWeek as number) <= 6)) throw new BadRequestException("Choose a day of the week");
    if (body.frequency === "monthly" && !(Number.isInteger(body.dayOfMonth) && (body.dayOfMonth as number) >= 1 && (body.dayOfMonth as number) <= 28)) throw new BadRequestException("Choose a day of the month from 1 to 28");
    if (!(EXPORT_FORMATS as readonly string[]).includes(body.format)) throw new BadRequestException("Choose CSV, Excel or PDF");
    if (!Array.isArray(body.recipientUserIds) || body.recipientUserIds.length > MAX_RECIPIENTS || body.recipientUserIds.some((x) => typeof x !== "string" || !UUID_RE.test(x))) {
      throw new BadRequestException(`Choose up to ${MAX_RECIPIENTS} recipients`);
    }
    if ((body.reportId == null) === (body.savedReportId == null)) throw new BadRequestException("Schedule either a catalog report or a saved report");
    if (body.reportId && !REPORT_BY_ID.has(body.reportId)) throw new BadRequestException("Unknown report");
    if (body.savedReportId && !UUID_RE.test(body.savedReportId)) throw new BadRequestException("Unknown saved report");
    if (body.preset && !(DATE_PRESETS as readonly string[]).includes(body.preset)) throw new BadRequestException("Unknown date period");
  }

  /** Recipients who could not receive this report today, with the reason, so the owner is told at save time. */
  private async eligibility(companyId: string, ownerId: string, source: ReportSource, recipientIds: string[]): Promise<{ ok: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const ok: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of recipientIds) {
      const access = await this.runner.accessFor(this.claimsOf(companyId, id), source);
      if (recipientMayReceive({ id, access }, ownerId)) ok.push(id);
      else if (!access) skipped.push({ id, reason: "does not have access to this report" });
      else if (!access.canExport) skipped.push({ id, reason: "is not allowed to export this report" });
      else skipped.push({ id, reason: "only sees part of the company, so a file built with your access could show more than they may see" });
    }
    return { ok, skipped };
  }

  private async write(claims: RequestClaims, id: string | null, body: SaveScheduleRequest): Promise<{ id: string; warnings: string[] }> {
    await this.need(claims);
    this.validate(body);
    const source: ReportSource = body.savedReportId
      ? (await this.saved.sourceFor(claims, body.savedReportId)).source
      : { kind: "catalog", reportId: body.reportId as string, filters: body.filters ?? {}, preset: body.preset ?? null, compare: false };
    const access = await this.runner.accessFor(claims, source);
    if (!access) throw new ForbiddenException("Not permitted to run this report");
    if (!access.canExport) throw new ForbiddenException("Not permitted to export this report, so it cannot be delivered");
    const recipients = [...new Set([claims.sub, ...body.recipientUserIds])];
    const { skipped } = await this.eligibility(claims.company_id as string, claims.sub, source, recipients.filter((r) => r !== claims.sub));
    const labels = await this.db.withClaims(claims, (c) => this.recipientLabels(c, claims.company_id as string, skipped.map((s) => s.id)));
    const warnings = skipped.map((s) => `${labels.find((l) => l.id === s.id)?.label ?? "A recipient"} ${s.reason}; they will be skipped.`);
    const filters = body.reportId ? { ...(body.filters ?? {}), ...(body.preset && body.preset !== "custom" ? { [PRESET_KEY]: body.preset } : {}) } : {};

    const out = await this.db.withClaims(claims, async (client) => {
      const known = await client.query<{ n: number }>("SELECT COUNT(DISTINCT user_account_id)::int AS n FROM employees WHERE company_id = $1 AND user_account_id = ANY($2::uuid[])", [claims.company_id, recipients]);
      if ((known.rows[0]?.n ?? 0) !== recipients.length) throw new BadRequestException("You can only send to people in your company");
      if (!id) {
        const c = await client.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM report_schedules WHERE owner_user_account_id = $1", [claims.sub]);
        if ((c.rows[0]?.n ?? 0) >= MAX_SCHEDULES_PER_USER) throw new BadRequestException(`You can have up to ${MAX_SCHEDULES_PER_USER} schedules. Remove one first.`);
      }
      const next = await this.nextInstant(client, claims.company_id as string, { frequency: body.frequency, dayOfWeek: body.frequency === "weekly" ? (body.dayOfWeek as number) : null, dayOfMonth: body.frequency === "monthly" ? (body.dayOfMonth as number) : null, hourLocal: body.hourLocal });
      const params = [body.name.trim(), body.savedReportId ?? null, body.reportId ?? null, JSON.stringify(filters), body.frequency, body.frequency === "weekly" ? body.dayOfWeek : null, body.frequency === "monthly" ? body.dayOfMonth : null, body.hourLocal, body.format, JSON.stringify(recipients), next];
      if (id) {
        await client.query(
          `UPDATE report_schedules SET name = $2, saved_report_id = $3, report_id = $4, filters = $5::jsonb, frequency = $6, day_of_week = $7, day_of_month = $8, hour_local = $9, format = $10,
                  recipients = $11::jsonb, next_run_at = $12, status = 'active', consecutive_failures = 0, updated_at = now() WHERE id = $1`,
          [id, ...params]
        );
        return id;
      }
      const r = await client.query<{ id: string }>(
        `INSERT INTO report_schedules (company_id, owner_user_account_id, name, saved_report_id, report_id, filters, frequency, day_of_week, day_of_month, hour_local, format, recipients, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13) RETURNING id`,
        [claims.company_id, claims.sub, ...params]
      );
      return (r.rows[0] as { id: string }).id;
    });
    return { id: out, warnings };
  }

  async create(claims: RequestClaims, body: SaveScheduleRequest): Promise<ReportScheduleSummary> {
    const { id, warnings } = await this.write(claims, null, body);
    return this.summary(claims, await this.mustOwn(claims, id), warnings);
  }

  async update(claims: RequestClaims, id: string, body: SaveScheduleRequest): Promise<ReportScheduleSummary> {
    await this.mustOwn(claims, id);
    const w = await this.write(claims, id, body);
    return this.summary(claims, await this.mustOwn(claims, id), w.warnings);
  }

  async setStatus(claims: RequestClaims, id: string, status: "active" | "paused"): Promise<ReportScheduleSummary> {
    const row = await this.mustOwn(claims, id);
    await this.db.withClaims(claims, async (client) => {
      const next = status === "active" ? await this.nextInstant(client, row.company_id, { frequency: row.frequency, dayOfWeek: row.day_of_week, dayOfMonth: row.day_of_month, hourLocal: row.hour_local }) : row.next_run_at;
      await client.query("UPDATE report_schedules SET status = $2, next_run_at = $3, consecutive_failures = CASE WHEN $2 = 'active' THEN 0 ELSE consecutive_failures END, updated_at = now() WHERE id = $1", [id, status, next]);
    });
    return this.summary(claims, await this.mustOwn(claims, id));
  }

  async remove(claims: RequestClaims, id: string): Promise<{ deleted: true }> {
    await this.mustOwn(claims, id);
    await this.db.withClaims(claims, (c) => c.query("DELETE FROM report_schedules WHERE id = $1", [id]));
    return { deleted: true };
  }

  // ------------------------------------------------------------------ deliveries

  async deliveries(claims: RequestClaims, id: string): Promise<ReportDeliverySummary[]> {
    await this.mustOwn(claims, id);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(`SELECT id, run_at, status, row_count, recipient_count, skipped_recipients, error_category, file_name, (file_bytes IS NOT NULL) AS downloadable FROM report_deliveries WHERE schedule_id = $1 ORDER BY run_at DESC LIMIT 30`, [id]);
      return r.rows.map((x) => ({ id: x.id, runAt: (x.run_at as Date).toISOString(), status: x.status, rowCount: x.row_count, recipientCount: x.recipient_count, skippedRecipients: x.skipped_recipients, errorCategory: x.error_category, fileName: x.file_name, downloadable: x.downloadable }));
    });
  }

  /** Files other people scheduled to me that are still available to download. */
  async inbox(claims: RequestClaims): Promise<ReportInboxItem[]> {
    await this.reports.callerContext(claims);
    return this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `SELECT d.id, d.run_at, d.file_name, d.file_expires_at, s.name AS schedule_name, COALESCE(sr.name, s.report_id) AS report_ref,
                (SELECT TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) FROM employees e WHERE e.user_account_id = s.owner_user_account_id AND e.company_id = s.company_id LIMIT 1) AS owner_name
           FROM report_deliveries d JOIN report_schedules s ON s.id = d.schedule_id LEFT JOIN saved_reports sr ON sr.id = s.saved_report_id
          WHERE s.recipients @> jsonb_build_array($1::text) AND d.file_bytes IS NOT NULL AND d.file_expires_at > now() AND d.status IN ('sent', 'stored')
          ORDER BY d.run_at DESC LIMIT 50`,
        [claims.sub]
      );
      return r.rows.map((x) => ({
        deliveryId: x.id,
        scheduleName: x.schedule_name,
        reportTitle: REPORT_BY_ID.get(String(x.report_ref))?.title ?? String(x.report_ref),
        runAt: (x.run_at as Date).toISOString(),
        fileName: x.file_name,
        expiresAt: x.file_expires_at ? (x.file_expires_at as Date).toISOString() : null,
        ownerName: x.owner_name || null,
      }));
    });
  }

  /** The stored file of one delivery, for its owner or a listed recipient who can still receive it today. */
  async download(claims: RequestClaims, deliveryId: string): Promise<{ filename: string; mime: string; buffer: Buffer }> {
    if (!UUID_RE.test(deliveryId)) throw new NotFoundException("No such file");
    await this.reports.callerContext(claims);
    const d = await this.db.withClaims(claims, async (c) => {
      const r = await c.query(
        `SELECT d.file_name, d.file_mime, d.file_bytes, s.id AS schedule_id, s.owner_user_account_id, s.recipients FROM report_deliveries d JOIN report_schedules s ON s.id = d.schedule_id
          WHERE d.id = $1 AND d.file_bytes IS NOT NULL AND d.file_expires_at > now()`,
        [deliveryId]
      );
      return r.rows[0];
    });
    if (!d) throw new NotFoundException("This file is no longer available");
    const isOwner = d.owner_user_account_id === claims.sub;
    if (!isOwner) {
      if (!(d.recipients as string[]).includes(claims.sub)) throw new NotFoundException("This file is no longer available");
      // re-check today: a recipient whose access was reduced since the file was built no longer gets it
      const sched = await this.db.withClaims(SERVICE, async (c) => (await c.query<ScheduleRow>(`${SELECT} WHERE s.id = $1`, [d.schedule_id])).rows[0]);
      if (!sched) throw new NotFoundException("This file is no longer available");
      const source = await this.sourceOf(this.claimsOf(sched.company_id, sched.owner_user_account_id), sched).catch(() => null);
      const access = source ? await this.runner.accessFor(claims, source) : null;
      if (!recipientMayReceive({ id: claims.sub, access }, sched.owner_user_account_id)) throw new ForbiddenException("You no longer have access to this report");
    }
    return { filename: d.file_name, mime: d.file_mime, buffer: d.file_bytes as Buffer };
  }

  // ------------------------------------------------------------------ running

  /** Sends one schedule now (the owner's "Send now"). Does not move the regular next run. */
  async runNow(claims: RequestClaims, id: string): Promise<ReportDeliverySummary> {
    const row = await this.mustOwn(claims, id);
    return this.execute(row);
  }

  /** The worker entry point: claims every due schedule once (moving next_run_at first, so two instances never both send), then delivers. */
  async runDue(): Promise<number> {
    const due = await this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query<ScheduleRow>(`${SELECT} WHERE s.status = 'active' AND s.next_run_at IS NOT NULL AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 20 FOR UPDATE OF s SKIP LOCKED`);
      for (const s of r.rows) {
        const next = await this.nextInstant(client, s.company_id, { frequency: s.frequency, dayOfWeek: s.day_of_week, dayOfMonth: s.day_of_month, hourLocal: s.hour_local });
        await client.query("UPDATE report_schedules SET next_run_at = $2 WHERE id = $1", [s.id, next]);
      }
      return r.rows;
    });
    for (const s of due) {
      try {
        await this.execute(s);
      } catch (e) {
        this.logger.warn(`Schedule ${s.id} failed outside its own handling: ${(e as Error).message}`);
      }
    }
    return due.length;
  }

  async purgeExpiredFiles(): Promise<number> {
    return this.db.withClaims(SERVICE, async (c) => (await c.query("UPDATE report_deliveries SET file_bytes = NULL WHERE file_bytes IS NOT NULL AND file_expires_at < now()")).rowCount ?? 0);
  }

  private async execute(s: ScheduleRow): Promise<ReportDeliverySummary> {
    const started = Date.now();
    const owner = this.claimsOf(s.company_id, s.owner_user_account_id);
    let status: "sent" | "stored" | "failed" | "skipped" = "failed";
    let category: string | null = null;
    let rowCount: number | null = null;
    let recipientCount = 0;
    let skippedCount = 0;
    let file: { name: string; mime: string; buffer: Buffer } | null = null;
    try {
      const source = await this.sourceOf(owner, s);
      const built = await this.exports.build(owner, source, s.format, { title: undefined, savedReportId: s.saved_report_id });
      rowCount = built.rowCount;
      if (built.buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error("file too large"), { category: "too_large" });
      file = { name: built.filename, mime: built.mime, buffer: built.buffer };
      const { ok, skipped } = await this.eligibility(s.company_id, s.owner_user_account_id, source, s.recipients);
      skippedCount = skipped.length;
      recipientCount = ok.length;
      if (!ok.length) {
        status = "skipped";
        category = "no_eligible_recipient";
      } else if (this.mailer.isConfigured()) {
        const emails = await this.db.withClaims(SERVICE, async (c) => (await c.query<{ email: string }>("SELECT email FROM user_accounts WHERE id = ANY($1::uuid[]) AND status = 'active'", [ok])).rows.map((x) => x.email));
        let failed = 0;
        for (const to of emails) {
          try {
            await this.mailer.sendMail({
              to,
              subject: `[AiHxM] ${built.title}`,
              text: `Your scheduled report "${built.title}" is attached (${built.rowCount} rows).\n\nIt was prepared for you from the report schedule "${s.name}". It may contain confidential employee information; please do not forward it.\n\nYou can also download it in AiHxM under Reports > Scheduled for 14 days.`,
              attachments: [{ filename: built.filename, content: built.buffer, contentType: built.mime }],
            });
          } catch {
            failed += 1;
          }
        }
        if (failed > 0) {
          status = "failed";
          category = "email";
        } else status = "sent";
      } else {
        status = "stored";
      }
    } catch (e) {
      const err = e as Err & { category?: string };
      const http = err.getStatus?.();
      category = err.category ?? (http === 403 ? "forbidden" : http === 404 ? "report_unavailable" : http === 408 ? "timeout" : "error");
      status = "failed";
    }
    const ms = Date.now() - started;
    const keepFile = file && status !== "skipped";
    const id = await this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query<{ id: string; run_at: Date }>(
        `INSERT INTO report_deliveries (company_id, schedule_id, status, row_count, recipient_count, skipped_recipients, error_category, duration_ms, file_name, file_mime, file_bytes, file_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, run_at`,
        [s.company_id, s.id, status, rowCount, recipientCount, skippedCount, category, ms, keepFile ? file?.name : null, keepFile ? file?.mime : null, keepFile ? file?.buffer : null, keepFile ? new Date(Date.now() + FILE_TTL_DAYS * 86_400_000) : null]
      );
      const failures = status === "failed" ? s.consecutive_failures + 1 : 0;
      await client.query(
        `UPDATE report_schedules SET last_run_at = now(), last_status = $2, consecutive_failures = $3, status = CASE WHEN $3 >= ${FAILURE_LIMIT} THEN 'failed' ELSE status END WHERE id = $1`,
        [s.id, status === "failed" ? `failed: ${category}` : status === "skipped" ? "skipped: no one could receive it" : status, failures]
      );
      return r.rows[0] as { id: string; run_at: Date };
    });
    return { id: id.id, runAt: id.run_at.toISOString(), status, rowCount, recipientCount, skippedRecipients: skippedCount, errorCategory: category, fileName: keepFile ? file?.name ?? null : null, downloadable: !!keepFile };
  }
}
