import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type { ShareGrantee, ShareTargets } from "@aihxm/shared-types";
import { AuditService } from "../../audit/audit.service";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { UUID_RE } from "../engine/sql";
import { ReportsService } from "../reports.service";

type Target = { column: "saved_report_id" | "dashboard_id"; table: "saved_reports" | "dashboards"; id: string; name: string };

/**
 * Shared by saved reports and dashboards. Sharing grants the right to OPEN the item, nothing more: each run uses the
 * viewer's own report access, so a grantee who may not see the data sees an error, never the owner's numbers.
 */
@Injectable()
export class SharingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService
  ) {}

  async targets(claims: RequestClaims): Promise<ShareTargets> {
    const ctx = await this.reports.callerContext(claims);
    // the same list of colleagues is needed to pick who a schedule is delivered to
    if (!ctx.held.has("reports.share") && !ctx.held.has("reports.schedule")) throw new ForbiddenException("Not permitted to share reports");
    return this.db.withClaims(claims, async (client) => {
      const users = await client.query<{ id: string; label: string }>(
        `SELECT e.user_account_id::text AS id, TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) || CASE WHEN e.employee_number IS NOT NULL THEN ' (' || e.employee_number || ')' ELSE '' END AS label
           FROM employees e WHERE e.company_id = $1 AND e.user_account_id IS NOT NULL AND e.employment_status <> 'terminated' ORDER BY 2 LIMIT 500`,
        [claims.company_id]
      );
      const roles = await client.query<{ key: string; label: string }>(
        "SELECT r.key, r.name AS label FROM roles r WHERE r.is_active AND (r.company_id = $1 OR r.company_id IS NULL) ORDER BY r.name LIMIT 100",
        [claims.company_id]
      );
      return { users: users.rows.filter((u) => u.id !== claims.sub), roles: roles.rows };
    });
  }

  async list(claims: RequestClaims, column: Target["column"], id: string): Promise<ShareGrantee[]> {
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query<ShareGrantee>(
        `SELECT s.grantee_type AS type, COALESCE(s.grantee_user_account_id::text, s.grantee_role_key) AS id,
                COALESCE((SELECT TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) FROM employees e WHERE e.user_account_id = s.grantee_user_account_id AND e.company_id = s.company_id LIMIT 1),
                         (SELECT r.name FROM roles r WHERE r.key = s.grantee_role_key AND (r.company_id = s.company_id OR r.company_id IS NULL) LIMIT 1), 'Unknown') AS label
           FROM report_shares s WHERE s.${column} = $1 ORDER BY s.grantee_type, label`,
        [id]
      );
      return r.rows;
    });
  }

  /** Replaces the share list. The caller has already proven ownership; this checks reports.share and that every grantee is in the company. */
  async replace(claims: RequestClaims, t: Target, grantees: Array<{ type: "user" | "role"; id: string }>): Promise<ShareGrantee[]> {
    const ctx = await this.reports.callerContext(claims);
    if (!ctx.held.has("reports.share")) throw new ForbiddenException("Not permitted to share reports");
    if (!Array.isArray(grantees) || grantees.length > 100) throw new BadRequestException("Share with up to 100 people or roles");
    const users: string[] = [];
    const roles: string[] = [];
    for (const g of grantees) {
      if (g?.type === "user" && typeof g.id === "string" && UUID_RE.test(g.id)) users.push(g.id);
      else if (g?.type === "role" && typeof g.id === "string" && /^[a-z][a-z0-9_]{1,60}$/.test(g.id)) roles.push(g.id);
      else throw new BadRequestException("A person or role to share with is not valid");
    }
    await this.db.withClaims(claims, async (client) => {
      if (users.length) {
        const ok = await client.query<{ n: number }>("SELECT COUNT(DISTINCT user_account_id)::int AS n FROM employees WHERE company_id = $1 AND user_account_id = ANY($2::uuid[])", [claims.company_id, users]);
        if ((ok.rows[0]?.n ?? 0) !== new Set(users).size) throw new BadRequestException("You can only share with people in your company");
      }
      if (roles.length) {
        const ok = await client.query<{ n: number }>("SELECT COUNT(DISTINCT key)::int AS n FROM roles WHERE is_active AND (company_id = $1 OR company_id IS NULL) AND key = ANY($2::text[])", [claims.company_id, roles]);
        if ((ok.rows[0]?.n ?? 0) !== new Set(roles).size) throw new BadRequestException("One of the roles does not exist");
      }
      await client.query(`DELETE FROM report_shares WHERE ${t.column} = $1`, [t.id]);
      for (const u of new Set(users)) {
        if (u === claims.sub) continue;
        await client.query(`INSERT INTO report_shares (company_id, ${t.column}, grantee_type, grantee_user_account_id, created_by) VALUES ($1, $2, 'user', $3, $4)`, [claims.company_id, t.id, u, claims.sub]);
      }
      for (const r of new Set(roles)) {
        await client.query(`INSERT INTO report_shares (company_id, ${t.column}, grantee_type, grantee_role_key, created_by) VALUES ($1, $2, 'role', $3, $4)`, [claims.company_id, t.id, r, claims.sub]);
      }
      await client.query(
        `UPDATE ${t.table} SET visibility = CASE WHEN EXISTS (SELECT 1 FROM report_shares WHERE ${t.column} = $1) THEN 'shared' ELSE 'private' END, updated_at = now() WHERE id = $1`,
        [t.id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id as string,
        action: "report.share",
        target: `${t.table}:${t.id}`,
        metadata: { kind: t.name, users: new Set(users).size, roles: [...new Set(roles)] },
      });
    });
    return this.list(claims, t.column, t.id);
  }
}
