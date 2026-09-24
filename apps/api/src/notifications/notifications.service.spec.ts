import { ForbiddenException } from "@nestjs/common";
import { Pool } from "pg";
import { NotificationsService } from "./notifications.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { MailerService } from "../mailer/mailer.service";
import { TestSmtpCatcher } from "../mailer/test-smtp-catcher";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "notifications-service-fixtures",
};

/**
 * NotificationsService (notifications.service.ts) is deliberately tiny —
 * per the plan doc's own wording, Phase 6's "Interfaces" pillar is
 * "logged/stubbed" only: `dispatch()` writes one row to `notification_log`
 * and returns it, and `list()` reads rows back scoped to the caller's
 * company. There is no send/mark-as-read/preferences/bulk-send surface —
 * this suite tests exactly that real, small API.
 */
describe("NotificationsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let notifications: NotificationsService;
  let companyAId: string;
  let companyBId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    notifications = new NotificationsService(db, new MailerService());

    const stamp = Date.now();
    companyAId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Notifications Spec Co A ${stamp}`,
        `notifications-spec-a-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
    companyBId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Notifications Spec Co B ${stamp}`,
        `notifications-spec-b-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyAId, companyBId]])
    );
    await pool.end();
  });

  describe("dispatch", () => {
    it("writes a notification_log row and returns it with status 'logged'", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };

      const entry = await notifications.dispatch(claims, {
        channel: "email",
        recipient: "employee@example.com",
        templateKey: "leave_request.submitted",
        payload: { leaveRequestId: "abc-123" },
      });

      expect(entry.id).toBeDefined();
      expect(entry.companyId).toBe(companyAId);
      expect(entry.channel).toBe("email");
      expect(entry.recipient).toBe("employee@example.com");
      expect(entry.templateKey).toBe("leave_request.submitted");
      expect(entry.payload).toEqual({ leaveRequestId: "abc-123" });
      expect(entry.status).toBe("logged");
      expect(entry.createdAt).toBeDefined();
    });

    it("defaults payload to {} when omitted", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };

      const entry = await notifications.dispatch(claims, {
        channel: "in_app",
        recipient: "user-1",
        templateKey: "leave_request.approved",
      });

      expect(entry.payload).toEqual({});
    });

    it("supports each real notification channel", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };

      for (const channel of ["email", "whatsapp", "push", "in_app"] as const) {
        const entry = await notifications.dispatch(claims, {
          channel,
          recipient: "recipient@example.com",
          templateKey: `channel.${channel}`,
        });
        expect(entry.channel).toBe(channel);
      }
    });

    it("throws ForbiddenException when the caller has no company_id", async () => {
      const claims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "platform-admin" };

      await expect(
        notifications.dispatch(claims, {
          channel: "email",
          recipient: "someone@example.com",
          templateKey: "no.company",
        })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("list", () => {
    it("returns entries for the caller's company, most recent first", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };

      await notifications.dispatch(claims, {
        channel: "email",
        recipient: "first@example.com",
        templateKey: "list.first",
      });
      await notifications.dispatch(claims, {
        channel: "email",
        recipient: "second@example.com",
        templateKey: "list.second",
      });

      const entries = await notifications.list(claims);

      expect(Array.isArray(entries)).toBe(true);
      expect(entries.every((e) => e.companyId === companyAId)).toBe(true);
      const firstIndex = entries.findIndex((e) => e.templateKey === "list.first");
      const secondIndex = entries.findIndex((e) => e.templateKey === "list.second");
      expect(secondIndex).toBeLessThan(firstIndex);
    });

    it("scopes to the caller's company and excludes other companies' rows", async () => {
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: "user-2" };

      await notifications.dispatch(claimsA, {
        channel: "email",
        recipient: "a@example.com",
        templateKey: "scoped.to.a",
      });
      await notifications.dispatch(claimsB, {
        channel: "email",
        recipient: "b@example.com",
        templateKey: "scoped.to.b",
      });

      const aEntries = await notifications.list(claimsA);

      expect(aEntries.some((e) => e.templateKey === "scoped.to.a")).toBe(true);
      expect(aEntries.some((e) => e.templateKey === "scoped.to.b")).toBe(false);
    });

    it("respects the limit parameter", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };

      await notifications.dispatch(claims, {
        channel: "email",
        recipient: "limit@example.com",
        templateKey: "limit.test",
      });

      const entries = await notifications.list(claims, 1);
      expect(entries.length).toBe(1);
    });

    it("returns an empty array when the caller has no company_id", async () => {
      const claims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "platform-admin" };

      const entries = await notifications.list(claims);
      expect(entries).toEqual([]);
    });
  });

  describe("dispatch() — real email delivery once SMTP is configured (2026-09-18 increment)", () => {
    // Deliberately its own describe block, run last: it's the only place
    // in this file that touches `process.env.SMTP_*`, and it restores
    // those vars afterward so every test above (which all run first, in
    // source order, per Jest's per-file execution model) keeps exercising
    // the original "unconfigured -> logged-only" behavior unchanged.
    let catcher: TestSmtpCatcher;
    let configuredNotifications: NotificationsService;
    const originalEnv = { ...process.env };

    beforeAll(async () => {
      catcher = await TestSmtpCatcher.start();
      process.env.SMTP_HOST = "127.0.0.1";
      process.env.SMTP_PORT = String(catcher.port);
      process.env.SMTP_FROM = "no-reply@aihxm.local";
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      configuredNotifications = new NotificationsService(db, new MailerService());
    });

    afterAll(async () => {
      await catcher.stop();
      process.env = { ...originalEnv };
    });

    it("sends a real email and marks the notification 'sent' when the channel is email and a known template is used", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };
      const entry = await configuredNotifications.dispatch(claims, {
        channel: "email",
        recipient: "reset-target@example.com",
        templateKey: "password_reset",
        payload: { resetLink: "https://app.aihxm.local/reset-password?token=xyz" },
      });

      expect(entry.status).toBe("sent");
      const received = catcher.all();
      const match = received.find((m) => m.to.includes("reset-target@example.com"));
      expect(match).toBeDefined();
      expect(match?.subject).toBe("Reset your AIHXM password");
      expect(match?.text).toContain("https://app.aihxm.local/reset-password?token=xyz");

      // The final status persisted, not just the returned object — a
      // second read (list()) must see 'sent' too, not the transient
      // 'logged' the row briefly held mid-dispatch.
      const listed = await configuredNotifications.list(claims, 50);
      const persisted = listed.find((e) => e.id === entry.id);
      expect(persisted?.status).toBe("sent");
    });

    it("renders an unrecognized templateKey generically instead of throwing or sending a blank email", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };
      const entry = await configuredNotifications.dispatch(claims, {
        channel: "email",
        recipient: "generic-target@example.com",
        templateKey: "some.future.template",
        payload: { foo: "bar" },
      });

      expect(entry.status).toBe("sent");
      const match = catcher.all().find((m) => m.to.includes("generic-target@example.com"));
      expect(match?.subject).toBe("AIHXM notification: some.future.template");
      expect(match?.text).toContain("foo: bar");
    });

    it("does not attempt real delivery for non-email channels even when SMTP is configured", async () => {
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };
      const before = catcher.all().length;
      const entry = await configuredNotifications.dispatch(claims, {
        channel: "in_app",
        recipient: "user-1",
        templateKey: "in_app.only",
      });

      expect(entry.status).toBe("logged");
      expect(catcher.all().length).toBe(before);
    });

    it("marks the notification 'failed' — without throwing out of dispatch() — when the SMTP send fails", async () => {
      // Point at a port nothing is listening on, simulating a real
      // provider outage, without tearing down the shared catcher other
      // tests in this block still rely on.
      const claims: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: "user-1" };
      const brokenPort = process.env.SMTP_PORT;
      process.env.SMTP_PORT = "1";
      try {
        const entry = await configuredNotifications.dispatch(claims, {
          channel: "email",
          recipient: "will-fail@example.com",
          templateKey: "password_reset",
          payload: { resetLink: "https://example.com" },
        });
        expect(entry.status).toBe("failed");
      } finally {
        process.env.SMTP_PORT = brokenPort;
      }
    });
  });
});
