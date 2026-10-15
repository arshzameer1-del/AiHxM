import { Pool } from "pg";
import { DomainEventsService, deliveryBackoffSeconds } from "./domain-events.service";
import { eventTypeMatches, redactPayload, REDACTED } from "./payload-redaction";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { runWithContext } from "../common/request-context";
import { randomUUID } from "crypto";

const SVC: RequestClaims = { is_platform_admin: true, company_id: null, sub: "events-fixtures" };

describe("payload redaction + pattern matching (SEC-13)", () => {
  it("drops CNIC, bank, salary and secret values at any depth, in snake and camel case", () => {
    const out = redactPayload({
      employeeId: "e1",
      firstName: "Ayesha",
      cnic: "35202-1234567-1",
      bankAccountNumber: "0001234",
      nested: { iban: "PK36...", salary_amount: 90000, ok: "yes", list: [{ dateOfBirth: "1990-01-01", city: "Lahore" }] },
      apiToken: "tok_live_x",
    });
    expect(out).toEqual({
      employeeId: "e1",
      firstName: "Ayesha",
      cnic: REDACTED,
      bankAccountNumber: REDACTED,
      nested: { iban: REDACTED, salary_amount: REDACTED, ok: "yes", list: [{ dateOfBirth: REDACTED, city: "Lahore" }] },
      apiToken: REDACTED,
    });
  });

  it("matches exact types, trailing wildcards and the catch-all", () => {
    expect(eventTypeMatches("employee.hired", "employee.hired")).toBe(true);
    expect(eventTypeMatches("employee.*", "employee.address.changed")).toBe(true);
    expect(eventTypeMatches("employee.*", "payroll.run.finalized")).toBe(false);
    expect(eventTypeMatches("employee.*", "employeeX.hired")).toBe(false);
    expect(eventTypeMatches("*", "anything.at.all")).toBe(true);
  });

  it("backs off exponentially, capped at 6h", () => {
    expect([1, 2, 3].map(deliveryBackoffSeconds)).toEqual([30, 60, 120]);
    expect(deliveryBackoffSeconds(40)).toBe(6 * 3600);
  });
});

describe("DomainEventsService outbox (PLT-04)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let events: DomainEventsService;
  let companyId: string;
  let otherCompanyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    events = new DomainEventsService();
    const stamp = Date.now();
    const mk = (n: string) =>
      db.withClaims(SVC, async (c) => {
        const r = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Events ${n} ${stamp}`, `events-${n}-${stamp}`]);
        return r.rows[0].id as string;
      });
    companyId = await mk("a");
    otherCompanyId = await mk("b");
  });

  afterAll(async () => {
    // company delete cascades domain_events despite the append-only trigger
    await db.withClaims(SVC, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  it("stores a redacted event carrying the request correlation id", async () => {
    const correlationId = randomUUID();
    const ev = await runWithContext({ correlationId }, () =>
      db.withClaims(SVC, (c) =>
        events.publish(c, SVC, {
          companyId,
          eventType: "employee.hired",
          aggregateType: "employee",
          aggregateId: "emp-1",
          aggregateVersion: 1,
          payload: { employeeId: "emp-1", cnic: "35202-1234567-1", department: "Finance" },
        })
      )
    );
    expect(ev.correlationId).toBe(correlationId);
    expect(ev.payload).toEqual({ employeeId: "emp-1", cnic: REDACTED, department: "Finance" });
    const raw = await db.withClaims(SVC, (c) => c.query("SELECT payload::text AS p FROM domain_events WHERE id = $1", [ev.id]));
    expect(raw.rows[0].p).not.toContain("35202");
  });

  it("rolls back with the business transaction (no event without the change)", async () => {
    const marker = `rollback-${Date.now()}`;
    await expect(
      db.withClaims(SVC, async (c) => {
        await events.publish(c, SVC, { companyId, eventType: "x.y", aggregateType: "x", aggregateId: marker });
        throw new Error("business change failed");
      })
    ).rejects.toThrow("business change failed");
    const found = await db.withClaims(SVC, (c) => events.listEvents(c, { companyId, aggregateId: marker }));
    expect(found).toHaveLength(0);
  });

  it("is immutable: UPDATE and DELETE are rejected", async () => {
    const ev = await db.withClaims(SVC, (c) =>
      events.publish(c, SVC, { companyId, eventType: "x.immutable", aggregateType: "x", aggregateId: "i1" })
    );
    // app role: no UPDATE/DELETE privilege at all
    await expect(db.withClaims(SVC, (c) => c.query("UPDATE domain_events SET event_type = 'z' WHERE id = $1", [ev.id]))).rejects.toThrow(/permission denied/);
    await expect(db.withClaims(SVC, (c) => c.query("DELETE FROM domain_events WHERE id = $1", [ev.id]))).rejects.toThrow(/permission denied/);
    // table owner: blocked by the append-only trigger
    const owner = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await expect(owner.query("UPDATE domain_events SET event_type = 'z' WHERE id = $1", [ev.id])).rejects.toThrow(/append-only/);
      await expect(owner.query("DELETE FROM domain_events WHERE id = $1", [ev.id])).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });

  it("fans out to every matching active subscription, many per tenant, and nothing else", async () => {
    const sfx = Date.now();
    const subs = await db.withClaims(SVC, async (c) => [
      await events.createSubscription(c, SVC, { companyId, name: `hr-${sfx}`, eventPatterns: ["employee.*"], targetUrl: "https://example.test/a" }),
      await events.createSubscription(c, SVC, { companyId, name: `all-${sfx}`, eventPatterns: ["*"], targetUrl: "https://example.test/b" }),
      await events.createSubscription(c, SVC, { companyId, name: `pay-${sfx}`, eventPatterns: ["payroll.*"], targetUrl: "https://example.test/c" }),
    ]);
    await db.withClaims(SVC, (c) => c.query("UPDATE event_subscriptions SET status = 'paused' WHERE id = $1", [subs[1].id]));
    await db.withClaims(SVC, (c) =>
      events.createSubscription(c, SVC, { companyId: otherCompanyId, name: `other-${sfx}`, eventPatterns: ["*"], targetUrl: "https://example.test/d" })
    );

    const ev = await db.withClaims(SVC, (c) =>
      events.publish(c, SVC, { companyId, eventType: "employee.terminated", aggregateType: "employee", aggregateId: `fan-${sfx}` })
    );
    const deliveries = await db.withClaims(SVC, (c) =>
      c.query("SELECT subscription_id FROM event_deliveries WHERE event_id = $1", [ev.id])
    );
    expect(deliveries.rows.map((r) => r.subscription_id)).toEqual([subs[0].id]); // not paused, not payroll, not other tenant
  });

  it("retries with backoff, dead-letters when exhausted, and replays by the original event id", async () => {
    const sfx = Date.now();
    const sub = await db.withClaims(SVC, (c) =>
      events.createSubscription(c, SVC, { companyId, name: `flaky-${sfx}`, eventPatterns: ["retry.*"], targetUrl: "https://example.test/f", maxAttempts: 2 })
    );
    const ev = await db.withClaims(SVC, (c) =>
      events.publish(c, SVC, { companyId, eventType: "retry.me", aggregateType: "r", aggregateId: `r-${sfx}` })
    );
    const d = (await db.withClaims(SVC, (c) => c.query("SELECT id FROM event_deliveries WHERE event_id = $1", [ev.id]))).rows[0].id;

    const one = await db.withClaims(SVC, (c) => events.recordDeliveryAttempt(c, d, { ok: false, statusCode: 503, error: "unavailable" }));
    expect(one).toEqual({ status: "pending", deadLettered: false });
    const two = await db.withClaims(SVC, (c) => events.recordDeliveryAttempt(c, d, { ok: false, statusCode: 503, error: "unavailable" }));
    expect(two).toEqual({ status: "failed", deadLettered: true });

    const replayed = await db.withClaims(SVC, (c) => events.replay(c, ev.id, sub.id));
    expect(replayed).toBe(1);
    const ok = await db.withClaims(SVC, (c) => events.recordDeliveryAttempt(c, d, { ok: true, statusCode: 200 }));
    expect(ok.status).toBe("delivered");
    const row = (await db.withClaims(SVC, (c) => c.query("SELECT replay_count, event_id FROM event_deliveries WHERE id = $1", [d]))).rows[0];
    expect(row).toMatchObject({ replay_count: 1, event_id: ev.id });
  });

  it("tenant isolation: a tenant session cannot read another tenant's events or subscriptions", async () => {
    const asOther: RequestClaims = { is_platform_admin: false, company_id: otherCompanyId, sub: "u" };
    const events1 = await db.withClaims(asOther, (c) => c.query("SELECT DISTINCT company_id FROM domain_events"));
    expect(events1.rows.every((r) => r.company_id === otherCompanyId)).toBe(true);
    const subs = await db.withClaims(asOther, (c) => c.query("SELECT DISTINCT company_id FROM event_subscriptions"));
    expect(subs.rows.every((r) => r.company_id === otherCompanyId)).toBe(true);
  });
});
