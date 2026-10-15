import { Pool } from "pg";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import { TenantConfigurationService } from "./tenant-configuration.service";

const ADMIN: RequestClaims = { is_platform_admin: true, company_id: null, sub: "tenant-config-step3" };

/** Gap Register CFG-03 -- scheduled (future-dated) tenant configuration. */
describe("TenantConfigurationService -- scheduled changes (CFG-03)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: TenantConfigurationService;
  let companyId: string;
  const CAT = "attendance";
  const KEY = "late_grace_minutes";

  const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const effective = async () => (await svc.getEffective(ADMIN, companyId)).find((s) => s.category === CAT && s.settingKey === KEY)!;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new TenantConfigurationService(db, new AuditService(), new SessionSecurityService(db, new CacheService()));
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(ADMIN, async (c) => (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Sched ${stamp}`, `sched-${stamp}`])).rows[0].id);
  });

  afterAll(async () => {
    await db.withClaims(ADMIN, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("scheduling does not touch the live value", async () => {
    const before = await effective();
    const v = await svc.scheduleChange(ADMIN, companyId, CAT, KEY, 25, days(30), "winter hours");
    expect(v.status).toBe("scheduled");
    expect(v.effectiveFrom).toBe(days(30));
    const after = await effective();
    expect(after.effectiveValue).toBe(before.effectiveValue);
    expect(after.isOverridden).toBe(false);
    expect(await svc.listScheduled(ADMIN, companyId)).toHaveLength(1);
  });

  it("rejects today/past dates, bad types, unknown settings and duplicate dates", async () => {
    await expect(svc.scheduleChange(ADMIN, companyId, CAT, KEY, 5, days(0))).rejects.toThrow(BadRequestException);
    await expect(svc.scheduleChange(ADMIN, companyId, CAT, KEY, 5, days(-3))).rejects.toThrow(BadRequestException);
    await expect(svc.scheduleChange(ADMIN, companyId, CAT, KEY, "ten", days(10))).rejects.toThrow(BadRequestException);
    await expect(svc.scheduleChange(ADMIN, companyId, CAT, "nope", 5, days(10))).rejects.toThrow(NotFoundException);
    await expect(svc.scheduleChange(ADMIN, companyId, CAT, KEY, 5, "10/10/2026")).rejects.toThrow(BadRequestException);
    await expect(svc.scheduleChange(ADMIN, companyId, CAT, KEY, 99, days(30))).rejects.toThrow(/already scheduled/);
  });

  it("a scheduled change can be cancelled once and then never applies", async () => {
    const [sched] = await svc.listScheduled(ADMIN, companyId);
    const cancelled = await svc.cancelScheduled(ADMIN, companyId, sched.id, "plan changed");
    expect(cancelled.status).toBe("cancelled");
    await expect(svc.cancelScheduled(ADMIN, companyId, sched.id)).rejects.toThrow(BadRequestException);
    await expect(svc.rollback(ADMIN, companyId, sched.id)).rejects.toThrow(BadRequestException); // not an applied version
    expect(await svc.listScheduled(ADMIN, companyId)).toHaveLength(0);
  });

  it("a due change is applied on read, history stays intact, and as-of reads give the value then in force", async () => {
    await svc.setOverride(ADMIN, companyId, CAT, KEY, 10); // applied today
    // a change that has become due (inserted as the scheduler would have left it)
    await db.withClaims(ADMIN, (c) =>
      c.query(
        `INSERT INTO tenant_configuration_versions (company_id, category, setting_key, new_value, changed_by, effective_from, status, change_reason)
         VALUES ($1,$2,$3,'40'::jsonb,'tester',CURRENT_DATE,'scheduled','due now')`,
        [companyId, CAT, KEY]
      )
    );
    expect(await svc.applyDue(ADMIN, companyId)).toBe(1);
    expect(await svc.applyDue(ADMIN, companyId)).toBe(0); // idempotent
    expect((await effective()).effectiveValue).toBe(40);

    const history = await svc.getHistory(ADMIN, companyId, CAT, KEY);
    expect(history.map((h) => h.status)).toEqual(expect.arrayContaining(["applied"]));
    expect(history.some((h) => h.newValue === 40 && h.oldValue === 10)).toBe(true);

    // as-of: before any override the default, today the new value
    expect((await svc.resolveAsOf(ADMIN, companyId, CAT, KEY, days(-400))).source).toBe("default");
    const today = await svc.resolveAsOf(ADMIN, companyId, CAT, KEY, days(0));
    expect(today).toMatchObject({ value: 40, source: "override" });
    await expect(svc.resolveAsOf(ADMIN, companyId, CAT, KEY, "bad")).rejects.toThrow(BadRequestException);
  });

  it("getEffective itself promotes due changes", async () => {
    await db.withClaims(ADMIN, (c) =>
      c.query(
        `INSERT INTO tenant_configuration_versions (company_id, category, setting_key, new_value, changed_by, effective_from, status)
         VALUES ($1,$2,$3,'55'::jsonb,'tester',CURRENT_DATE,'scheduled')`,
        [companyId, CAT, KEY]
      )
    );
    expect((await effective()).effectiveValue).toBe(55);
    expect(await svc.listScheduled(ADMIN, companyId)).toHaveLength(0);
  });
});
