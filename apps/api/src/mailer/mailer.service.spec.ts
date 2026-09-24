import { MailerService } from "./mailer.service";
import { TestSmtpCatcher } from "./test-smtp-catcher";

/**
 * No Postgres here — like `rules-engine.engine.spec.ts`, this is pure
 * infrastructure with no database dependency. What it DOES need, and
 * gets, is a real SMTP transaction: `TestSmtpCatcher` is a genuine local
 * SMTP listener, so these tests prove `MailerService` actually speaks
 * SMTP correctly (host/port/from/to/subject/body all really cross the
 * wire), not just that it calls a mocked `nodemailer.sendMail`.
 */
describe("MailerService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isConfigured()", () => {
    it("is false when SMTP_HOST is not set", () => {
      delete process.env.SMTP_HOST;
      expect(new MailerService().isConfigured()).toBe(false);
    });

    it("is true once SMTP_HOST is set", () => {
      process.env.SMTP_HOST = "127.0.0.1";
      expect(new MailerService().isConfigured()).toBe(true);
    });
  });

  describe("sendMail()", () => {
    it("throws rather than silently no-op-ing when called while unconfigured", async () => {
      delete process.env.SMTP_HOST;
      const mailer = new MailerService();
      await expect(mailer.sendMail({ to: "a@example.com", subject: "x", text: "y" })).rejects.toThrow();
    });

    it("really delivers a message over SMTP to a live local server", async () => {
      const catcher = await TestSmtpCatcher.start();
      try {
        process.env.SMTP_HOST = "127.0.0.1";
        process.env.SMTP_PORT = String(catcher.port);
        process.env.SMTP_FROM = "no-reply@aihxm.local";
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
        const mailer = new MailerService();

        await mailer.sendMail({
          to: "recipient@example.com",
          subject: "Reset your AIHXM password",
          text: "Reset it here: https://example.com/reset?token=abc123",
        });

        const received = catcher.all();
        expect(received).toHaveLength(1);
        expect(received[0].from).toBe("no-reply@aihxm.local");
        expect(received[0].to).toEqual(["recipient@example.com"]);
        expect(received[0].subject).toBe("Reset your AIHXM password");
        expect(received[0].text).toContain("https://example.com/reset?token=abc123");
      } finally {
        await catcher.stop();
      }
    });

    it("rejects when the configured SMTP host refuses the connection", async () => {
      process.env.SMTP_HOST = "127.0.0.1";
      process.env.SMTP_PORT = "1"; // nothing listens on port 1
      const mailer = new MailerService();
      await expect(mailer.sendMail({ to: "a@example.com", subject: "x", text: "y" })).rejects.toThrow();
    });
  });
});
