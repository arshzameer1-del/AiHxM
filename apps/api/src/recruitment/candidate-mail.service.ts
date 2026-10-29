import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { MailerService } from "../mailer/mailer.service";
import { loadRecruitmentSettings } from "./recruitment.mappers";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "candidate-mail" };

export type CandidateMailKind = "application_receipt" | "interview_invitation" | "application_rejected";

const SETTING_FOR: Record<CandidateMailKind, "sendApplicationReceipt" | "sendInterviewEmails" | "sendRejectionEmails"> = {
  application_receipt: "sendApplicationReceipt",
  interview_invitation: "sendInterviewEmails",
  application_rejected: "sendRejectionEmails",
};

const fmt = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: process.env.COMPANY_TIME_ZONE ?? "Asia/Karachi" }).format(d);

/**
 * The e-mails a candidate gets: a receipt when they apply, an invitation when an interview is booked and, when the
 * company switches it on, a courteous no-thanks. A candidate has no login, so nothing is shown in the app; every message
 * is written to notification_log (template key candidate_*) whether or not mail is configured. It never throws: a failed
 * e-mail must not undo a hire-pipeline action.
 */
@Injectable()
export class CandidateMailService {
  private readonly logger = new Logger(CandidateMailService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mailer: MailerService
  ) {}

  async send(kind: CandidateMailKind, applicationId: string, extra: { interviewId?: string } = {}): Promise<"sent" | "logged" | "failed" | "skipped"> {
    try {
      const ctx = await this.db.withClaims(SERVICE_CLAIMS, async (client) => {
        const a = await client.query(
          `SELECT a.id, a.company_id, c.first_name, c.email, c.anonymised_at, r.title, co.name AS company_name
             FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN job_requisitions r ON r.id = a.requisition_id JOIN companies co ON co.id = a.company_id
            WHERE a.id = $1`,
          [applicationId]
        );
        if (!a.rowCount) return null;
        const row = a.rows[0];
        const settings = await loadRecruitmentSettings(client, row.company_id);
        let interview: { start: Date; end: Date; type: string; location: string | null; link: string | null } | null = null;
        if (extra.interviewId) {
          const i = await client.query("SELECT scheduled_start, scheduled_end, interview_type, location_text, meeting_link FROM interviews WHERE id = $1", [extra.interviewId]);
          if (i.rowCount) interview = { start: i.rows[0].scheduled_start, end: i.rows[0].scheduled_end, type: i.rows[0].interview_type, location: i.rows[0].location_text, link: i.rows[0].meeting_link };
        }
        return { row, settings, interview };
      });
      if (!ctx || !ctx.row.email || ctx.row.anonymised_at || !ctx.settings[SETTING_FOR[kind]]) return "skipped";
      const { row, interview } = ctx;
      const to = String(row.email).trim();
      const { subject, text } = this.compose(kind, row.first_name, row.title, row.company_name, interview);

      const sent = this.mailer.isConfigured()
        ? await this.mailer.sendMail({ to, subject, text }).then(() => true, () => false)
        : null;
      const status = sent === null ? "logged" : sent ? "sent" : "failed";
      await this.db.withClaims(SERVICE_CLAIMS, (client) =>
        client.query(
          "INSERT INTO notification_log (company_id, channel, recipient, template_key, payload, status) VALUES ($1, 'email', $2, $3, $4::jsonb, $5)",
          [row.company_id, to, `candidate_${kind}`, JSON.stringify({ applicationId, subject }), status]
        )
      );
      return status;
    } catch (err) {
      this.logger.warn(`Candidate e-mail ${kind} for application ${applicationId} failed: ${(err as Error).message}`);
      return "failed";
    }
  }

  private compose(
    kind: CandidateMailKind, firstName: string, job: string, company: string,
    interview: { start: Date; end: Date; type: string; location: string | null; link: string | null } | null
  ): { subject: string; text: string } {
    const hello = `Dear ${firstName},`;
    const sign = `Kind regards,\n${company} recruitment team`;
    if (kind === "application_receipt") {
      return {
        subject: `We received your application for ${job}`,
        text: `${hello}\n\nThank you for applying for ${job} at ${company}. We have received your application and our team will review it. If your profile matches, we will contact you about the next step.\n\n${sign}`,
      };
    }
    if (kind === "interview_invitation") {
      const where = interview?.type === "video" || interview?.type === "phone" ? (interview.link ? `Join: ${interview.link}` : `Type: ${interview.type}`) : `Venue: ${interview?.location ?? "to be confirmed"}`;
      return {
        subject: `Interview invitation: ${job} at ${company}`,
        text: `${hello}\n\nWe would like to invite you to an interview for ${job}.\n\nWhen: ${interview ? `${fmt(interview.start)} to ${fmt(interview.end)}` : "to be confirmed"}\n${where}\n\nPlease reply to this e-mail if the time does not suit you.\n\n${sign}`,
      };
    }
    return {
      subject: `Your application for ${job}`,
      text: `${hello}\n\nThank you for your interest in ${job} at ${company} and for the time you put into your application. After careful consideration we will not be taking your application further for this role. We will keep your details on file in line with our privacy practice and wish you every success.\n\n${sign}`,
    };
  }
}
