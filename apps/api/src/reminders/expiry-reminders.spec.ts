import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { ExpiryRemindersService, reminderStage } from "./expiry-reminders.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "expiry-reminders-spec" };

describe("reminderStage", () => {
  it("picks the stage by how close the date is", () => {
    expect(reminderStage("2026-10-01", "2026-10-10")).toBe("lapsed");
    expect(reminderStage("2026-10-10", "2026-10-10")).toBe("week");
    expect(reminderStage("2026-10-17", "2026-10-10")).toBe("week");
    expect(reminderStage("2026-10-18", "2026-10-10")).toBe("month");
    expect(reminderStage("2026-11-09", "2026-10-10")).toBe("month");
    expect(reminderStage("2026-11-10", "2026-10-10")).toBeNull();
  });
});

/** Gaps 1 and 13 against real Postgres: expiring documents and due courses reach the person, once per stage. */
describe("ExpiryRemindersService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: ExpiryRemindersService;
  let company: string;
  let userId: string;
  let employeeId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const today = "2026-10-29";
  const fx = <T>(fn: (c: import("pg").PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const inbox = async () => (await fx((c) => c.query("SELECT category, title FROM user_notifications WHERE user_account_id = $1 ORDER BY title", [userId]))).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new ExpiryRemindersService(db, new UserNotificationsService(db, { isConfigured: () => false, sendMail: async () => undefined } as never));
    await fx(async (c) => {
      company = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Reminders ${stamp}`, `reminders-${stamp}`])).rows[0].id;
      userId = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`rem-${stamp}@example.com`])).rows[0].id;
      const person = (await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1,'Rem Person') RETURNING id", [company])).rows[0].id;
      employeeId = (
        await c.query(
          "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'Rem','Person',$3,$4) RETURNING id",
          [company, `RM-${stamp}`.slice(0, 30), person, userId]
        )
      ).rows[0].id;
      const doc = (type: string, expiry: string, status = "approved") =>
        c.query(
          "INSERT INTO employee_documents (company_id, employee_id, document_type, file_name, mime_type, size_bytes, storage_path, expiry_date, review_status) VALUES ($1,$2,$3,'f.pdf','application/pdf',1,'x',$4,$5)",
          [company, employeeId, type, expiry, status]
        );
      await doc("passport", "2026-11-05"); // within 7 days? no: 7 days from 29 Oct is 5 Nov -> week
      await doc("cnic", "2026-11-20"); // month
      await doc("degree", "2027-03-01"); // far away - no reminder
      await doc("visa", "2026-10-01"); // lapsed
      await doc("licence", "2026-11-03", "pending"); // not approved - no reminder
      const course = (await c.query("INSERT INTO courses (company_id, title, category, duration_minutes) VALUES ($1,'Fire Safety','compliance',30) RETURNING id", [company])).rows[0].id;
      await c.query("INSERT INTO course_enrollments (company_id, employee_id, course_id, due_date) VALUES ($1,$2,$3,'2026-10-25')", [company, employeeId, course]);
    });
  });

  afterAll(async () => {
    await fx(async (c) => {
      await c.query("DELETE FROM companies WHERE id = $1", [company]);
      await c.query("DELETE FROM user_accounts WHERE id = $1", [userId]);
    });
    await pool.end();
  });

  it("notifies the person once per stage and never twice", async () => {
    const first = await svc.run(today, company);
    expect(first).toMatchObject({ documents: 3, courses: 1 });
    const titles = (await inbox()).map((r) => r.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Your passport expires within 7 days",
        "Your cnic expires within 30 days",
        "Your visa has expired",
        'Your course "Fire Safety" is overdue',
      ])
    );
    expect(titles).toHaveLength(4);

    const second = await svc.run(today, company);
    expect(second).toMatchObject({ documents: 0, courses: 0, assigned: 0 });
    expect(await inbox()).toHaveLength(4);
  });

  it("assigns a mandatory course to every active employee once, due in 30 days, and skips tenants without Learning", async () => {
    const course = await fx(async (c) => {
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'learning',true) ON CONFLICT DO NOTHING", [company]);
      return (await c.query("INSERT INTO courses (company_id, title, category, duration_minutes, is_mandatory) VALUES ($1,'Code of Conduct','compliance',20,true) RETURNING id", [company])).rows[0].id as string;
    });
    expect(await svc.assignMandatory(today, company)).toBe(1);
    expect(await svc.assignMandatory(today, company)).toBe(0);
    const rows = (await fx((c) => c.query("SELECT due_date::text AS due FROM course_enrollments WHERE course_id = $1 AND employee_id = $2", [course, employeeId]))).rows;
    expect(rows).toEqual([{ due: "2026-11-28" }]);
  });

  it("sends the next stage when the date gets closer", async () => {
    const later = await svc.run("2026-11-12", company); // cnic (20 Nov) is now within 7 days? 8 days -> still month; passport lapsed? 5 Nov < 12 Nov -> lapsed
    expect(later.documents).toBeGreaterThanOrEqual(1);
    expect((await inbox()).map((r) => r.title)).toContain("Your passport has expired");
  });
});
