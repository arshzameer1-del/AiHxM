import { Body, Controller, Get, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DummyService } from "./dummy.service";
import { CreateDummyRecordDto } from "./dto/create-dummy-record.dto";
import { ImportDummyRecordsCsvDto } from "./dto/import-dummy-records-csv.dto";

/**
 * Separate from DummyController deliberately: creating fixture data is a
 * Platform-Admin/test-setup action (matches dummy_records' write RLS
 * policy), reading it through the RBAC engine is an ordinary-session
 * action (DummyController, SessionGuard) — the same split as every other
 * object in this codebase between "who can administer this" and "who can
 * use it."
 */
@Controller("platform/dummy-records")
@UseGuards(PlatformAdminGuard)
export class DummyFixturesController {
  constructor(private readonly dummy: DummyService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateDummyRecordDto) {
    return this.dummy.create(claims, dto);
  }

  /**
   * The Phase 6 "Conversions" WRICEF pillar's proof-of-concept
   * integration — see DummyService.importCsv's doc comment. Body is the
   * raw CSV text plus which company it belongs to, since (like create()
   * above) this is Platform-Admin fixture tooling, not a tenant
   * self-service upload yet.
   */
  @Post("import")
  importCsv(@CurrentClaims() claims: RequestClaims, @Body() dto: ImportDummyRecordsCsvDto) {
    return this.dummy.importCsv(claims, dto.companyId, dto.csv);
  }

  @Get("export")
  async exportCsv(@CurrentClaims() claims: RequestClaims, @Query("companyId") companyId: string, @Res() res: Response) {
    const csv = await this.dummy.exportCsv(claims, companyId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="dummy-records.csv"');
    res.send(csv);
  }
}
