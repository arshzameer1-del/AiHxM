import { Injectable, Logger } from "@nestjs/common";

export type MessagingChannel = "sms" | "whatsapp";
export type MessagingResult = { ok: true; providerRef: string | null } | { ok: false; error: string };
export type MessagingStatus = Record<MessagingChannel, { configured: boolean; provider: "twilio" | "webhook" | null }>;

/**
 * SMS and WhatsApp delivery. Nothing is sent until a provider is configured through the environment, so every dev, test
 * and unconfigured tenant keeps behaving exactly as before (the message is only logged).
 *
 * Two providers are supported:
 *   - Twilio:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM and/or TWILIO_WHATSAPP_FROM (whatsapp:+...)
 *   - Webhook: SMS_WEBHOOK_URL / WHATSAPP_WEBHOOK_URL (+ optional *_TOKEN as a bearer token). Receives
 *              POST {"channel","to","text"} and answers 2xx when it accepted the message. This is the way to plug in
 *              a local Pakistani SMS gateway or the WhatsApp Business API without changing the platform.
 * The webhook wins when both are set for a channel.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  status(): MessagingStatus {
    const provider = (channel: MessagingChannel) => this.providerFor(channel);
    return {
      sms: { configured: provider("sms") !== null, provider: provider("sms") },
      whatsapp: { configured: provider("whatsapp") !== null, provider: provider("whatsapp") },
    };
  }

  isConfigured(channel: MessagingChannel): boolean {
    return this.providerFor(channel) !== null;
  }

  /** Pakistani mobile numbers are stored many ways (0300-1234567, 92 300 1234567, +923001234567); providers want E.164. */
  static normalizePhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let digits = raw.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) digits = digits.slice(1);
    else if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
    else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
    if (!/^\d{10,15}$/.test(digits)) return null;
    return `+${digits}`;
  }

  async send(channel: MessagingChannel, to: string, text: string): Promise<MessagingResult> {
    const provider = this.providerFor(channel);
    if (!provider) return { ok: false, error: `${channel === "sms" ? "SMS" : "WhatsApp"} is not set up` };
    const number = MessagingService.normalizePhone(to);
    if (!number) return { ok: false, error: "The phone number is not valid" };
    const body = text.slice(0, 1500);
    try {
      return provider === "webhook" ? await this.viaWebhook(channel, number, body) : await this.viaTwilio(channel, number, body);
    } catch (err) {
      this.logger.warn(`${channel} to ${number} failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }

  private providerFor(channel: MessagingChannel): "twilio" | "webhook" | null {
    const env = process.env;
    if (channel === "sms" ? env.SMS_WEBHOOK_URL : env.WHATSAPP_WEBHOOK_URL) return "webhook";
    const hasAccount = !!env.TWILIO_ACCOUNT_SID && !!env.TWILIO_AUTH_TOKEN;
    if (hasAccount && (channel === "sms" ? env.TWILIO_SMS_FROM : env.TWILIO_WHATSAPP_FROM)) return "twilio";
    return null;
  }

  private async viaWebhook(channel: MessagingChannel, to: string, text: string): Promise<MessagingResult> {
    const url = channel === "sms" ? process.env.SMS_WEBHOOK_URL! : process.env.WHATSAPP_WEBHOOK_URL!;
    const token = channel === "sms" ? process.env.SMS_WEBHOOK_TOKEN : process.env.WHATSAPP_WEBHOOK_TOKEN;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ channel, to, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `The gateway answered ${res.status}` };
    return { ok: true, providerRef: res.headers.get("x-message-id") };
  }

  private async viaTwilio(channel: MessagingChannel, to: string, text: string): Promise<MessagingResult> {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const from = channel === "sms" ? process.env.TWILIO_SMS_FROM! : process.env.TWILIO_WHATSAPP_FROM!;
    const form = new URLSearchParams({
      To: channel === "whatsapp" ? `whatsapp:${to}` : to,
      From: channel === "whatsapp" && !from.startsWith("whatsapp:") ? `whatsapp:${from}` : from,
      Body: text,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, error: json.message ?? `Twilio answered ${res.status}` };
    return { ok: true, providerRef: json.sid ?? null };
  }
}
