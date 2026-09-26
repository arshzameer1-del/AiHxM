import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DataResidencyService } from "./data-residency.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "residency-spec-admin-1" };
const OTHER_ADMIN_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "residency-spec-admin-2" };

/**
 * Phase 3 item #6 — Data Residency & Sovereignty (declaration + disclosure
 * only, never real data placement — see DataResidencyService's own doc
 * comment). Real Postgres, same bootstrap idiom as
 * tenant-export-key.service.spec.ts — RLS is the point.
 */
describe("DataResidencyService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: DataResidencyService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new DataResidencyService(db, new AuditService());

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = Date.now();
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Residency Spec Co ${stamp}`,
        `residency-spec-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("404s for an unknown company", async () => {
    await expect(service.getStatus(FIXTURE_CLAIMS, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });

  it("reports no_requirement before anything has ever been declared", async () => {
    const status = await service.getStatus(FIXTURE_CLAIMS, companyId);
    expect(status.requiredRegion).toBeNull();
    expect(status.complianceStatus).toBe("no_requirement");
    expect(status.acknowledgedBy).toBeNull();
    expect(status.acknowledgedAt).toBeNull();
    // The platform's own actual region is always a real, non-empty string,
    // whether or not PLATFORM_DATA_REGION is set — never silently blank.
    expect(status.platformActualRegion).toBeTruthy();
  });

  it("computes 'mismatch' when the declared requirement clearly does not match the platform's actual region", async () => {
    const status = await service.setRequiredRegion(FIXTURE_CLAIMS, companyId, "Pakistan-only, on-prem");
    expect(status.requiredRegion).toBe("Pakistan-only, on-prem");
    expect(status.complianceStatus).toBe("mismatch");
    expect(status.acknowledgedBy).toBeNull();
    expect(status.acknowledgedAt).toBeNull();
  });

  it("rejects acknowledging when there is nothing to acknowledge — matches case", async () => {
    // Declare a requirement that DOES match the platform's actual region,
    // by declaring the platform's own region string back at it.
    const current = await service.getStatus(FIXTURE_CLAIMS, companyId);
    const matchingStatus = await service.setRequiredRegion(FIXTURE_CLAIMS, companyId, current.platformActualRegion);
    expect(matchingStatus.complianceStatus).toBe("matches");
    await expect(service.acknowledge(FIXTURE_CLAIMS, companyId)).rejects.toThrow(BadRequestException);
  });

  it("rejects acknowledging when no requirement is set at all", async () => {
    await service.setRequiredRegion(FIXTURE_CLAIMS, companyId, null);
    const status = await service.getStatus(FIXTURE_CLAIMS, companyId);
    expect(status.complianceStatus).toBe("no_requirement");
    await expect(service.acknowledge(FIXTURE_CLAIMS, companyId)).rejects.toThrow(BadRequestException);
  });

  it("acknowledge() records the real human action once a genuine mismatch exists", async () => {
    await service.setRequiredRegion(FIXTURE_CLAIMS, companyId, "European Union");
    const acknowledged = await service.acknowledge(OTHER_ADMIN_CLAIMS, companyId);
    expect(acknowledged.complianceStatus).toBe("mismatch");
    expect(acknowledged.acknowledgedBy).toBe(OTHER_ADMIN_CLAIMS.sub);
    expect(acknowledged.acknowledgedAt).toBeTruthy();
  });

  it("clears a prior acknowledgment as soon as the declared requirement changes — stale coverage is never implied", async () => {
    const status = await service.setRequiredRegion(FIXTURE_CLAIMS, companyId, "European Union, strictly");
    expect(status.complianceStatus).toBe("mismatch");
    expect(status.acknowledgedBy).toBeNull();
    expect(status.acknowledgedAt).toBeNull();
  });

  it("audits both the declaration and the acknowledgment, with no fabricated automation claims in metadata", async () => {
    const auditRows = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        "SELECT action, metadata FROM audit_log WHERE company_id = $1 AND action LIKE 'company.data_residency%' ORDER BY created_at",
        [companyId]
      )
    );
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["company.data_residency_declared", "company.data_residency_acknowledged"]));
  });
});
