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
    @Query("limit") limit?: string
  ) {
    return this.db.withClaims(claims, (client) =>
      this.audit.list(client, {
        companyId: companyId || undefined,
        limit: limit ? Number(limit) : undefined,
      })
    );
  }
}
