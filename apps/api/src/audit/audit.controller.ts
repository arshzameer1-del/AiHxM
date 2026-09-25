import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "./audit.service";

@Controller("platform/audit-log")
@UseGuards(PlatformAdminGuard)
export class AuditController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("companyId") companyId?: string,
    @Query("actor") actor?: string,
    @Query("action") action?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string
  ) {
    return this.db.withClaims(claims, (client) =>
      this.audit.list(client, {
        companyId: companyId || undefined,
        actor: actor || undefined,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: limit ? Number(limit) : undefined,
      })
    );
  }
}
