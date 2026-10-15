import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollAccountingService } from "./payroll-accounting.service";
import { GenerateJournalDto, PostJournalDto, ReverseJournalDto, UpdateJournalTypeDto, UpsertGlMappingDto } from "./dto/payroll-accounting.dto";

/** PAY-17 accounting and costing. Permissions are decided in the service (existing payroll.* permissions, payroll-area scoped). */
@Controller()
@UseGuards(SessionGuard)
export class PayrollAccountingController {
  constructor(private readonly accounting: PayrollAccountingService) {}

  @Get("payroll/gl-mappings")
  listMappings(@CurrentClaims() claims: RequestClaims) {
    return this.accounting.listMappings(claims);
  }

  @Post("payroll/gl-mappings")
  upsertMapping(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertGlMappingDto) {
    return this.accounting.upsertMapping(claims, dto);
  }

  @Delete("payroll/gl-mappings/:id")
  deleteMapping(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounting.deleteMapping(claims, id);
  }

  @Get("payroll/journal-types")
  listTypes(@CurrentClaims() claims: RequestClaims) {
    return this.accounting.listJournalTypes(claims);
  }

  @Patch("payroll/journal-types/:id")
  updateType(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateJournalTypeDto) {
    return this.accounting.updateJournalType(claims, id, dto);
  }

  @Get("payroll/runs/:runId/accounting/preview")
  preview(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string) {
    return this.accounting.preview(claims, runId);
  }

  @Post("payroll/runs/:runId/accounting/generate")
  generate(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string, @Body() dto: GenerateJournalDto) {
    return this.accounting.generate(claims, runId, dto);
  }

  @Get("payroll/runs/:runId/journals")
  listJournals(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string) {
    return this.accounting.listJournals(claims, runId);
  }

  @Get("payroll/runs/:runId/costing")
  costing(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string) {
    return this.accounting.costing(claims, runId);
  }

  @Post("payroll/runs/:runId/costing/generate")
  generateCosting(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string) {
    return this.accounting.generateCosting(claims, runId);
  }

  @Get("payroll/journals/:id")
  getJournal(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounting.getJournal(claims, id);
  }

  @Get("payroll/journals/:id/csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  csv(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounting.journalCsv(claims, id);
  }

  @Post("payroll/journals/:id/post")
  post(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: PostJournalDto) {
    return this.accounting.post(claims, id, dto);
  }

  @Post("payroll/journals/:id/discard")
  discard(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounting.discard(claims, id);
  }

  @Post("payroll/journals/:id/reverse")
  reverse(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReverseJournalDto) {
    return this.accounting.reversePosting(claims, id, dto.reason);
  }
}
