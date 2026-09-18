import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import type { AddressInfo } from "net";

/**
 * A real, local SMTP server for tests to point `MailerService` at — not a
 * mock of `nodemailer`, an actual SMTP listener on `127.0.0.1` accepting
 * real SMTP protocol traffic. This is what makes `mailer.service.spec.ts`
 * and the "real delivery" describe blocks in `notifications.service.spec.ts`
 * genuine integration tests of the wiring (env vars -> nodemailer ->
 * real SMTP handshake -> DATA -> a message this catcher actually
 * received) rather than a mock proving only that a function was called.
 * Never used outside tests; nothing in `apps/api/src`'s real request path
 * imports this file.
 */
export interface CaughtEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export class TestSmtpCatcher {
  readonly port: number;

  private constructor(
    private readonly server: SMTPServer,
    port: number,
    private readonly emails: CaughtEmail[]
  ) {
    this.port = port;
  }

  static async start(): Promise<TestSmtpCatcher> {
    const emails: CaughtEmail[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS", "AUTH"],
      logger: false,
      onData(stream, _session, callback) {
        simpleParser(stream)
          .then((parsed) => {
            const toAddresses: string[] = [];
            const toField = parsed.to;
            const toGroups = Array.isArray(toField) ? toField : toField ? [toField] : [];
            for (const group of toGroups) {
              for (const addr of group.value) {
                if (addr.address) toAddresses.push(addr.address);
              }
            }
            emails.push({
              from: parsed.from?.value[0]?.address ?? "",
              to: toAddresses,
              subject: parsed.subject ?? "",
              text: (parsed.text ?? "").trim(),
            });
            callback();
          })
          .catch((err) => callback(err as Error));
      },
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.server.address() as AddressInfo;
    return new TestSmtpCatcher(server, address.port, emails);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  all(): CaughtEmail[] {
    return this.emails;
  }

  clear(): void {
    this.emails.length = 0;
  }
}
