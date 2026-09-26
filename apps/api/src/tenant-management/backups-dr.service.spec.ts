import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { TenantConfigurationService } from "./tenant-configuration.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MailerService } from "../mailer/mailer.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { SessionSecurityService } from "../auth/session-security.service";
import { CacheService } from "../cache/cache.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "dr-test-spec" };

/**
 * Phase 3 item #7 — Backup & Disaster Recovery (advanced), the honest
 * proportionate version: a manual DR test EVIDENCE log (recordDrTest/
 * listDrTests on BackupsService), never an automated failover harness —
 * see BackupsService.recordDrTest's own doc comment. Also proves the
 * OTHER half of this item — RTO/RPO targets — needed literally zero new
 * backend read-side code: they ride the pre-existing
 * TenantConfigurationService/tenant_configuration_defaults mechanism, and
 * the new 'backup_dr' category rows just show up.
 */
describe("BackupsService — DR test evidence log", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: BackupsService;
  let configService: TenantConfigurationService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const audit = new AuditService();
    service = new BackupsService(
      db,
      audit,
      new NotificationsService(db, new MailerService()),
      new LocalFileStorageService()
    );
    configService = new TenantConfigurationService(db, audit, new SessionSecurityService(db, new CacheService()));

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `DR Test Spec Co ${stamp}`,
        `dr-test-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("404s for an unknown company", async () => {
    await expect(service.listDrTests(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });

  it("starts with an empty DR test log", async () => {
    const list = await service.listDrTests(FIXTURE_CLAIMS, companyId);
    expect(list).toEqual([]);
  });

  it("rejects an invalid testedAt", async () => {
    await expect(
      service.recordDrTest(FIXTURE_CLAIMS, companyId, { testedAt: "not-a-date", outcome: "pass" })
    ).rejects.toThrow(BadRequestException);
  });

  it("records a real DR test result and lists it back", async () => {
    const entry = await service.recordDrTest(FIXTURE_CLAIMS, companyId, {
      testedAt: "2026-06-01T10:00:00.000Z",
      outcome: "pass",
      notes: "Restored latest backup into a scratch environment; all employee records verified intact.",
    });
    expect(entry.companyId).toBe(companyId);
    expect(entry.outcome).toBe("pass");
    expect(entry.recordedBy).toBe(FIXTURE_CLAIMS.sub);
    expect(entry.notes).toContain("scratch environment");

    const list = await service.listDrTests(FIXTURE_CLAIMS, companyId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
  });

  it("lists multiple DR test entries most-recent-tested-first", async () => {
    await service.recordDrTest(FIXTURE_CLAIMS, companyId, {
      testedAt: "2026-01-01T10:00:00.000Z",
      outcome: "fail",
      notes: "Restore script failed on the employees table; fixed and re-tested below.",
    });
    await service.recordDrTest(FIXTURE_CLAIMS, companyId, {
      testedAt: "2026-08-01T10:00:00.000Z",
      outcome: "partial",
    });

    const list = await service.listDrTests(FIXTURE_CLAIMS, companyId);
    expect(list).toHaveLength(3);
    const testedAtDates = list.map((e) => new Date(e.testedAt).getTime());
    expect(testedAtDates).toEqual([...testedAtDates].sort((a, b) => b - a));
    expect(list[0].outcome).toBe("partial");
    expect(list[list.length - 1].outcome).toBe("fail");
  });

  it("rejects an unknown outcome value at the database CHECK constraint level if bypassed", async () => {
    // recordDrTest() itself only accepts the three known outcomes (enforced
    // by the controller DTO's @IsIn, mirrored by DrTestOutcome's type) —
    // this proves the DB's own CHECK constraint is a real backstop, not
    // just client-side validation.
    await expect(
      db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "INSERT INTO tenant_dr_test_log (company_id, tested_at, outcome, recorded_by) VALUES ($1, now(), 'bogus', $2)",
          [companyId, FIXTURE_CLAIMS.sub]
        )
      )
    ).rejects.toThrow();
  });

  it("audits every recorded DR test as tenant_dr_test.recorded", async () => {
    const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT action, metadata FROM audit_log WHERE company_id = $1 AND action = 'tenant_dr_test.recorded'", [
        companyId,
      ])
    );
    expect(auditRows.rowCount).toBe(3);
    for (const row of auditRows.rows) {
      expect(["pass", "fail", "partial"]).toContain(row.metadata.outcome);
    }
  });

  it("proves the design decision: new 'backup_dr' tenant_configuration_defaults rows appear via the EXISTING TenantConfigurationService.getEffective() with zero code changes to that service", async () => {
    const settings = await configService.getEffective(FIXTURE_CLAIMS, companyId);
    const rto = settings.find((s) => s.category === "backup_dr" && s.settingKey === "rto_hours");
    const rpo = settings.find((s) => s.category === "backup_dr" && s.settingKey === "rpo_hours");
    expect(rto).toBeDefined();
    expect(rto!.defaultValue).toBe(24);
    expect(rto!.effectiveValue).toBe(24);
    expect(rto!.isOverridden).toBe(false);
    expect(rpo).toBeDefined();
    expect(rpo!.defaultValue).toBe(24);
  });

  it("the same generic override mechanism already works for the new category, unmodified", async () => {
    const overridden = await configService.setOverride(FIXTURE_CLAIMS, companyId, "backup_dr", "rto_hours", 4);
    expect(overridden.effectiveValue).toBe(4);
    expect(overridden.isOverridden).toBe(true);

    const settings = await configService.getEffective(FIXTURE_CLAIMS, companyId);
    const rto = settings.find((s) => s.category === "backup_dr" && s.settingKey === "rto_hours");
    expect(rto!.effectiveValue).toBe(4);

    await configService.resetToDefault(FIXTURE_CLAIMS, companyId, "backup_dr", "rto_hours");
    const afterReset = await configService.getEffective(FIXTURE_CLAIMS, companyId);
    expect(afterReset.find((s) => s.settingKey === "rto_hours")!.effectiveValue).toBe(24);
  });
});
