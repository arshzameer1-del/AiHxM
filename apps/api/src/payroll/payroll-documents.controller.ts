import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { PayrollDocumentType } from "@aihxm/shared-types";
import { PayrollDocumentsService } from "./payroll-documents.service";
import {
  GenerateRunPayslipsDto,
  GenerateSalaryCertificateDto,
  GenerateTaxCertificateDto,
  RevokeDocumentDto,
  RunPublicationDto,
  UpdateDocumentSettingsDto,
} from "./dto/payroll-documents.dto";

/** PAY-20 payslip / certificate documents. Permissions are decided in the service. */
@Controller()
@UseGuards(SessionGuard)
export class PayrollDocumentsController {
  constructor(private readonly documents: PayrollDocumentsService) {}

  @Get("payroll/document-settings")
  settings(@CurrentClaims() claims: RequestClaims) {
    return this.documents.getSettings(claims);
  }

  @Patch("payroll/document-settings")
  updateSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdateDocumentSettingsDto) {
    return this.documents.updateSettings(claims, dto);
  }

  @Get("payroll/document-placeholders")
  placeholders() {
    return this.documents.placeholders();
  }

  @Get("payroll/documents")
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("employeeId") employeeId?: string,
    @Query("runId") runId?: string,
    @Query("documentType") documentType?: PayrollDocumentType,
    @Query("status") status?: string
  ) {
    return this.documents.list(claims, { employeeId, runId, documentType, status });
  }

  @Get("payroll/my-documents")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.documents.listMine(claims);
  }

  @Get("payroll/documents/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.documents.get(claims, id);
  }

  @Post("payroll/runs/:runId/payslip-documents")
  generatePayslips(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string, @Body() dto: GenerateRunPayslipsDto) {
    return this.documents.generatePayslips(claims, runId, dto);
  }

  @Post("payroll/runs/:runId/payslip-documents/publication")
  runPublication(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string, @Body() dto: RunPublicationDto) {
    return this.documents.setRunPublication(claims, runId, dto.published);
  }

  @Post("payroll/tax-certificates")
  taxCertificate(@CurrentClaims() claims: RequestClaims, @Body() dto: GenerateTaxCertificateDto) {
    return this.documents.generateTaxCertificate(claims, dto);
  }

  @Post("payroll/salary-certificates")
  salaryCertificate(@CurrentClaims() claims: RequestClaims, @Body() dto: GenerateSalaryCertificateDto) {
    return this.documents.generateSalaryCertificate(claims, dto);
  }

  @Post("payroll/documents/:id/publication")
  publication(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: RunPublicationDto) {
    return this.documents.setPublication(claims, id, dto.published);
  }

  @Post("payroll/documents/:id/revoke")
  revoke(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: RevokeDocumentDto) {
    return this.documents.revoke(claims, id, dto.reason);
  }
}
