import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { DataResidencyComplianceStatus, DataResidencyStatus } from "@aihxm/shared-types";

// This platform runs on a single Supabase Postgres project, in whatever
// single region that project was created in — there is no per-tenant, or
// even per-environment, region to choose between. `PLATFORM_DATA_REGION`
// is deliberately just a documented, overridable-for-clarity constant, not
// a secret and not something any code branches on, so it carries no CI
// env-var burden (unlike JWT_SECRET/MFA_ENCRYPTION_KEY/EXPORT_ENCRYPTION_KEY,
// this has a safe, honest fallback and never fails a request if unset).
// No real Supabase project is wired up in this sandbox (SUPABASE_URL is
// blank in .env) so there is no actual region to name here truthfully —
// the fallback says so plainly rather than inventing one.
const DEFAULT_PLATFORM_DATA_REGION = "unspecified — see Supabase project settings";

function platformActualRegion(): string {
  const configured = process.env.PLATFORM_DATA_REGION?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_PLATFORM_DATA_REGION;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeStatus(row: any): DataResidencyStatus {
  const platformRegion = platformActualRegion();
  const required: string | null = row.data_residency_required ?? null;
  let complianceStatus: DataResidencyComplianceStatus;
  if (!required || !required.trim()) {
    complianceStatus = "no_requirement";
  } else {
    const a = required.trim().toLowerCase();
    const b = platformRegion.trim().toLowerCase();
    complianceStatus = a === b || b.includes(a) || a.includes(b) ? "matches" : "mismatch";
  }
  return {
    companyId: row.id,
    platformActualRegion: platformRegion,
    requiredRegion: required,
    complianceStatus,
    acknowledgedBy: row.data_residency_acknowledged_by ?? null,
    acknowledgedAt: row.data_residency_acknowledged_at?.toISOString?.() ?? null,
  };
}

/**
 * Phase 3 item #6 — "Data Residency & Sovereignty", the honest,
 * proportionate version. See `DataResidencyStatus`'s own doc comment
 * (shared-types) for the full design. In short: this platform cannot
 * actually place or move tenant data across regions (single Supabase
 * region, no multi-region infrastructure), so this service does not
 * pretend to — it is a DECLARATION + DISCLOSURE mechanism. A Platform
 * Admin records what a tenant's own contract/expectation says
 * (`requiredRegion`, freely-entered text); this service compares that,
 * at read time, against the platform's one real region and surfaces a
 * plain compliance status. When there's a genuine mismatch, a Platform
 * Admin can `acknowledge()` it — a real recorded human action ("I've told
 * this customer"), never an automated fix, mirroring the same discipline
 * Phase 1 item #5's second-approver rule and SCIM's Groups-out-of-scope
 * decision already apply in this codebase: record what a human actually
 * did, don't fake automating something the system can't actually do.
 */
@Injectable()
export class DataResidencyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async getStatus(claims: RequestClaims, companyId: string): Promise<DataResidencyStatus> {
    return this.db.withClaims(claims, async (client) => {
      const row = await this.findCompany(client, companyId);
      return computeStatus(row);
    });
  }

  /** Records/updates the tenant's declared residency requirement. Changing it always clears any prior acknowledgment — an acknowledgment of a DIFFERENT stated requirement must never be read as covering this new one. */
  async setRequiredRegion(claims: RequestClaims, companyId: string, requiredRegion: string | null): Promise<DataResidencyStatus> {
    return this.db.withClaims(claims, async (client) => {
      await this.findCompany(client, companyId);
      const normalized = requiredRegion?.trim() ? requiredRegion.trim() : null;
      const result = await client.query(
        `UPDATE companies
         SET data_residency_required = $2,
             data_residency_acknowledged_by = NULL,
             data_residency_acknowledged_at = NULL,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, normalized]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.data_residency_declared",
        target: companyId,
        metadata: { requiredRegion: normalized },
      });

      return computeStatus(result.rows[0]);
    });
  }

  /**
   * The only real action this feature offers: a Platform Admin confirming
   * they've disclosed a genuine mismatch to the tenant. Rejected outright
   * when there is no mismatch to acknowledge — this is not a generic
   * "dismiss the banner" button.
   */
  async acknowledge(claims: RequestClaims, companyId: string): Promise<DataResidencyStatus> {
    return this.db.withClaims(claims, async (client) => {
      const row = await this.findCompany(client, companyId);
      const current = computeStatus(row);
      if (current.complianceStatus !== "mismatch") {
        throw new BadRequestException("There is no residency mismatch to acknowledge for this tenant.");
      }

      const result = await client.query(
        `UPDATE companies
         SET data_residency_acknowledged_by = $2,
             data_residency_acknowledged_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [companyId, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId,
        action: "company.data_residency_acknowledged",
        target: companyId,
        metadata: { requiredRegion: current.requiredRegion, platformActualRegion: current.platformActualRegion },
      });

      return computeStatus(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findCompany(client: PoolClient, companyId: string): Promise<any> {
    const result = await client.query("SELECT * FROM companies WHERE id = $1", [companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Company not found");
    return result.rows[0];
  }
}
