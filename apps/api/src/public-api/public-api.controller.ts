import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { ApiKeyScope } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { ApiKeyGuard } from "./api-key.guard";
import { OPENAPI } from "./openapi";

type KeyInfo = { id: string; companyId: string; scopes: ApiKeyScope[] };
const page = (limit?: string, offset?: string) => ({ limit: Math.min(500, Math.max(1, Number(limit) || 100)), offset: Math.max(0, Number(offset) || 0) });
const claimsOf = (k: KeyInfo): RequestClaims => ({ is_platform_admin: false, company_id: k.companyId, sub: k.id });
const need = (k: KeyInfo, s: ApiKeyScope) => {
  if (!k.scopes.includes(s)) throw new ForbiddenException(`This key does not have the ${s} scope`);
};

/** Read-only public API. No personal contact, identity, bank or pay data is ever returned here. */
@Controller("public-api/v1")
export class PublicApiController {
  constructor(private readonly db: DatabaseService) {}

  @Get("openapi.json")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  spec() {
    return OPENAPI;
  }

  @Get("employees")
  @UseGuards(ApiKeyGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async employees(@Req() req: { apiKey: KeyInfo }, @Query("limit") limit?: string, @Query("offset") offset?: string, @Query("status") status?: string) {
    need(req.apiKey, "employees.read");
    const p = page(limit, offset);
    const st = status === "terminated" || status === "all" ? status : "active";
    return this.db.withClaims(claimsOf(req.apiKey), async (c) => {
      const r = await c.query(
        `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.employment_status, e.date_of_joining, e.termination_date, u.name AS org_unit, p.position_title
           FROM employees e LEFT JOIN org_units u ON u.id = e.org_unit_id LEFT JOIN positions p ON p.id = e.position_id
          WHERE e.company_id = $1 AND ($2 = 'all' OR e.employment_status = $2) ORDER BY e.employee_number LIMIT $3 OFFSET $4`,
        [req.apiKey.companyId, st, p.limit, p.offset]
      );
      return {
        data: r.rows.map((e) => ({
          id: e.id,
          employeeNumber: e.employee_number,
          firstName: e.first_name,
          lastName: e.last_name,
          status: e.employment_status,
          dateOfJoining: e.date_of_joining ? new Date(e.date_of_joining).toISOString().slice(0, 10) : null,
          terminationDate: e.termination_date ? new Date(e.termination_date).toISOString().slice(0, 10) : null,
          orgUnit: e.org_unit ?? null,
          positionTitle: e.position_title ?? null,
        })),
        limit: p.limit,
        offset: p.offset,
      };
    });
  }

  @Get("org-units")
  @UseGuards(ApiKeyGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async orgUnits(@Req() req: { apiKey: KeyInfo }) {
    need(req.apiKey, "org.read");
    return this.db.withClaims(claimsOf(req.apiKey), async (c) => {
      const r = await c.query("SELECT id, name, unit_type FROM org_units WHERE company_id = $1 ORDER BY name LIMIT 2000", [req.apiKey.companyId]);
      return { data: r.rows.map((u) => ({ id: u.id, name: u.name, type: u.unit_type })) };
    });
  }
}
