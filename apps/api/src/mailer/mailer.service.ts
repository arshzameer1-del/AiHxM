import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";

/**
 * The one piece of real email delivery in this codebase — everywhere
 * else that needs to send an email (`NotificationsService`'s tenant-
 * scoped dispatch log, `AuthService`'s pre-auth password-reset flow)
 * calls this instead of talking to an SMTP transport directly. Kept
 * deliberately as its own tiny, controller-less module (the same shape
 * `EffectiveDatingModule`/`RulesEngineModule` already use for shared
 * infrastructure no single domain owns) rather than folded into
 * `NotificationsModule`, because `AuthService` needs to send a real,
 * security-critical email (password reset) from a PRE-AUTH context that
 * has no tenant/`company_id` to scope a `notification_log` row against —
 * see that method's own comment for why it deliberately does not go
 * through `NotificationsService.dispatch()`. This module knows nothing
 * about tenants, templates, or a notification log; it knows exactly one
 * thing, "send this email over SMTP," the same narrow-engine discipline
 * `RulesEngine` and `EffectiveDatingEngine` already established.
 *
 * Configuration is read from the environment on every call rather than
 * cached at construction — `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/
 * `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`. `isConfigured()` (no `SMTP_HOST`
 * means "not configured") is the one thing every caller checks before
 * deciding whether to attempt a real send at all — this is what keeps
 * every existing test and every unconfigured dev/CI environment behaving
 * EXACTLY as before this module existed: no `SMTP_HOST` means this
 * module is never invoked, matching NotificationsService's original
 * "just logging for now" behavior and AuthService's original
 * `devModeToken` fallback untouched. See KNOWN_ISSUES.md's former "no
 * real notification provider" entry, now closed by this module plus its
 * two call sites.
 */
/** How long a mail server that could not be reached is left alone before the next attempt. */
const UNREACHABLE_PAUSE_MS = 60_000;
const CONNECTION_ERRORS = new Set(["ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "ESOCKET", "EDNS", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);
// host:port -> time until which sending is skipped; shared by every instance because the problem is the network, not the caller.
const pausedUntil = new Map<string, number>();

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  isConfigured(): boolean {
    return !!process.env.SMTP_HOST;
  }

  async sendMail(input: { to: string; subject: string; text: string; html?: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string }> }): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("MailerService.sendMail called while unconfigured — callers must check isConfigured() first");
    }
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
    const secure = process.env.SMTP_SECURE === "true";
    const target = `${process.env.SMTP_HOST}:${port}`;
    const paused = pausedUntil.get(target) ?? 0;
    if (paused > Date.now()) {
      // A host that just timed out would make every action wait for the full timeout again (an e-mail goes out after nearly every
      // request). Fail at once for a minute, then try again.
      throw new Error(`Mail server ${target} could not be reached a moment ago; not retrying yet`);
    }
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      // nodemailer waits two minutes for a connection by default; a blocked SMTP port (common on shared hosting) must not hold a request that long.
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 20_000,
    });
    const from = process.env.SMTP_FROM ?? "no-reply@aihxm.local";
    try {
      await transport.sendMail({ from, to: input.to, subject: input.subject, text: input.text, html: input.html, ...(input.attachments ? { attachments: input.attachments } : {}) });
    } catch (err) {
      if (CONNECTION_ERRORS.has((err as { code?: string }).code ?? "")) pausedUntil.set(target, Date.now() + UNREACHABLE_PAUSE_MS);
      this.logger.warn(`Failed to send email to ${input.to}: ${(err as Error).message}`);
      throw err;
    }
  }
}
