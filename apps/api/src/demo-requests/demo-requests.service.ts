import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { MailerService } from "../mailer/mailer.service";
import type { DemoRequest, DemoRequestStatus } from "@aihxm/shared-types";
import { CreateDemoRequestDto, UpdateDemoRequestDto } from "./dto/demo-request.dto";

/** No user session exists behind the public form — same pattern as SignupService (see its SIGNUP_CLAIMS comment). */
const DEMO_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "demo-requests-service" };

/** At most this many NEW requests from one network address per hour. The route also has a per-minute @Throttle. */
const MAX_PER_IP_PER_HOUR = 5;

export type DemoRequestReceipt = { ok: true; reference: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDemoRequest(row: any): DemoRequest {
  return {
    id: row.id,
    fullName: row.full_name,
    workEmail: row.work_email,
    companyName: row.company_name,
    phone: row.phone ?? null,
    jobTitle: row.job_title ?? null,
    employeeCount: row.employee_count ?? null,
    interests: row.interests ?? [],
    message: row.message ?? null,
    sourcePage: row.source_page ?? null,
    status: row.status,
    internalNotes: row.internal_notes ?? null,
    duplicateCount: row.duplicate_count,
    createdAt: row.created_at.toISOString(),
    lastSubmittedAt: row.last_submitted_at.toISOString(),
  };
}

@Injectable()
export class DemoRequestsService {
  private readonly logger = new Logger(DemoRequestsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService
  ) {}

  /** Salted hash, never the raw address: enough to spot a flood from one place, not enough to identify a person. */
  private hashIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    const salt = process.env.DEMO_IP_SALT || process.env.JWT_SECRET || "aihxm-demo";
    return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32);
  }

  async submit(dto: CreateDemoRequestDto, ip: string | null | undefined): Promise<DemoRequestReceipt> {
    // Honeypot: bots fill the hidden field. Pretend success so they learn nothing; store nothing.
    if (dto.website && dto.website.trim() !== "") {
      this.logger.warn("Demo request dropped by honeypot");
      return { ok: true, reference: "AiHxM-0000" };
    }

    const email = dto.workEmail.trim().toLowerCase();
    const ipHash = this.hashIp(ip);

    const result = await this.db.withClaims(DEMO_CLAIMS, async (client) => {
      // Same person submitting again within a day: count it, do not create a second lead or a second notification.
      const dup = await client.query(
        `UPDATE demo_requests
            SET duplicate_count = duplicate_count + 1, last_submitted_at = now(), updated_at = now()
          WHERE id = (SELECT id FROM demo_requests
                       WHERE lower(work_email) = $1 AND created_at > now() - interval '24 hours'
                       ORDER BY created_at DESC LIMIT 1)
        RETURNING id`,
        [email]
      );
      if ((dup.rowCount ?? 0) > 0) return { id: dup.rows[0].id as string, isNew: false };

      if (ipHash) {
        const recent = await client.query(
          `SELECT count(*)::int AS n FROM demo_requests WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`,
          [ipHash]
        );
        if ((recent.rows[0].n as number) >= MAX_PER_IP_PER_HOUR) {
          throw new HttpException("Too many requests from this network. Please try again later.", HttpStatus.TOO_MANY_REQUESTS);
        }
      }

      const ins = await client.query(
        `INSERT INTO demo_requests
           (full_name, work_email, company_name, phone, job_title, employee_count, interests, message, source_page,
            consent_privacy, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)
         RETURNING id`,
        [
          dto.fullName,
          email,
          dto.companyName,
          dto.phone || null,
          dto.jobTitle || null,
          dto.employeeCount ?? null,
          dto.interests ?? [],
          dto.message || null,
          dto.sourcePage || null,
          ipHash,
        ]
      );
      return { id: ins.rows[0].id as string, isNew: true };
    });

    if (result.isNew) await this.notify(result.id, dto, email);

    return { ok: true, reference: `AiHxM-${result.id.slice(0, 8).toUpperCase()}` };
  }

  /**
   * Optional email to the sales inbox. Only runs when BOTH an SMTP server and DEMO_NOTIFY_EMAIL are configured; the
   * request is already saved, so a mail failure never fails the visitor's submission — it is logged and the request
   * simply stays without a `notified_at` timestamp in the Platform Admin list.
   */
  private async notify(id: string, dto: CreateDemoRequestDto, email: string): Promise<void> {
    const to = process.env.DEMO_NOTIFY_EMAIL;
    if (!to || !this.mailer.isConfigured()) return;
    try {
      const lines = [
        `New demo request (${id})`,
        ``,
        `Name: ${dto.fullName}`,
        `Work email: ${email}`,
        `Company: ${dto.companyName}`,
        `Phone: ${dto.phone || "-"}`,
        `Job title: ${dto.jobTitle || "-"}`,
        `Employees: ${dto.employeeCount || "-"}`,
        `Interested in: ${(dto.interests ?? []).join(", ") || "-"}`,
        `From page: ${dto.sourcePage || "-"}`,
        ``,
        `Message:`,
        dto.message || "-",
      ];
      await this.mailer.sendMail({ to, subject: `AiHxM demo request: ${dto.companyName}`, text: lines.join("\n") });
      await this.db.withClaims(DEMO_CLAIMS, (client) =>
        client.query(`UPDATE demo_requests SET notified_at = now() WHERE id = $1`, [id])
      );
    } catch (err) {
      this.logger.warn(`Demo request ${id} saved but notification email failed: ${(err as Error).message}`);
    }
  }

  async list(claims: RequestClaims, opts: { status?: DemoRequestStatus; limit?: number }): Promise<DemoRequest[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    return this.db.withClaims(claims, async (client) => {
      const params: unknown[] = [];
      let where = "";
      if (opts.status) {
        params.push(opts.status);
        where = `WHERE status = $1`;
      }
      params.push(limit);
      const res = await client.query(
        `SELECT * FROM demo_requests ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params as never[]
      );
      return res.rows.map(toDemoRequest);
    });
  }

  async update(claims: RequestClaims, id: string, dto: UpdateDemoRequestDto): Promise<DemoRequest> {
    return this.db.withClaims(claims, async (client) => {
      const res = await client.query(
        `UPDATE demo_requests
            SET status = COALESCE($2, status),
                internal_notes = CASE WHEN $3::boolean THEN $4 ELSE internal_notes END,
                updated_at = now()
          WHERE id = $1
        RETURNING *`,
        [id, dto.status ?? null, dto.internalNotes !== undefined, dto.internalNotes ?? null]
      );
      if ((res.rowCount ?? 0) === 0) throw new NotFoundException("Demo request not found");
      await this.audit.record(client, claims, {
        companyId: null,
        action: "demo_request.update",
        target: id,
        metadata: { status: dto.status ?? null, notesChanged: dto.internalNotes !== undefined },
      });
      return toDemoRequest(res.rows[0]);
    });
  }
}
