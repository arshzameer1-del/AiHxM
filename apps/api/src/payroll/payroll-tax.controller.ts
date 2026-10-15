import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollTaxService } from "./payroll-tax.service";
import {
  CloneTaxProfileDto, CreateTaxProfileDto, CreateTaxYearDto, PublishTaxRecordDto, SetEmployeeTaxProfileDto, SetTaxProfileSlabsDto,
  TaxCreditDto, TaxExemptionDto, UpdateTaxProfileDto, UpdateTaxYearDto,
} from "./dto/payroll-tax.dto";

/**
 * Step 9F (PAY-09, PAY-10). SessionGuard only - the entitlement and permission checks (`payroll.calculate.all` to
 * manage, `payroll.approve.all` to publish or retire) live in PayrollTaxService.
 */
@Controller()
@UseGuards(SessionGuard)
export class PayrollTaxController {
  constructor(private readonly tax: PayrollTaxService) {}

  @Get("payroll/tax/years")
  listYears(@CurrentClaims() claims: RequestClaims) {
    return this.tax.listYears(claims);
  }

  @Post("payroll/tax/years")
  createYear(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateTaxYearDto) {
    return this.tax.createYear(claims, dto);
  }

  @Patch("payroll/tax/years/:id")
  updateYear(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateTaxYearDto) {
    return this.tax.updateYear(claims, id, dto);
  }

  @Post("payroll/tax/years/:id/publish")
  publishYear(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PublishTaxRecordDto) {
    return this.tax.publishYear(claims, id, dto);
  }

  @Post("payroll/tax/years/:id/retire")
  retireYear(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.tax.retireYear(claims, id);
  }

  @Get("payroll/tax/profiles")
  listProfiles(@CurrentClaims() claims: RequestClaims, @Query("taxYearId") taxYearId?: string) {
    return this.tax.listProfiles(claims, taxYearId);
  }

  @Post("payroll/tax/profiles")
  createProfile(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateTaxProfileDto) {
    return this.tax.createProfile(claims, dto);
  }

  @Get("payroll/tax/profiles/:id")
  getProfile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.tax.getProfile(claims, id);
  }

  @Patch("payroll/tax/profiles/:id")
  updateProfile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateTaxProfileDto) {
    return this.tax.updateProfile(claims, id, dto);
  }

  @Put("payroll/tax/profiles/:id/slabs")
  setSlabs(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetTaxProfileSlabsDto) {
    return this.tax.setProfileSlabs(claims, id, dto.slabs);
  }

  @Post("payroll/tax/profiles/:id/exemptions")
  addExemption(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: TaxExemptionDto) {
    return this.tax.addExemption(claims, id, dto);
  }

  @Post("payroll/tax/profiles/:id/exemptions/:exemptionId/remove")
  removeExemption(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("exemptionId") exemptionId: string) {
    return this.tax.removeExemption(claims, id, exemptionId);
  }

  @Post("payroll/tax/profiles/:id/credits")
  addCredit(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: TaxCreditDto) {
    return this.tax.addCredit(claims, id, dto);
  }

  @Post("payroll/tax/profiles/:id/credits/:creditId/remove")
  removeCredit(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("creditId") creditId: string) {
    return this.tax.removeCredit(claims, id, creditId);
  }

  @Post("payroll/tax/profiles/:id/publish")
  publishProfile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PublishTaxRecordDto) {
    return this.tax.publishProfile(claims, id, dto);
  }

  @Post("payroll/tax/profiles/:id/retire")
  retireProfile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.tax.retireProfile(claims, id);
  }

  @Post("payroll/tax/profiles/:id/clone")
  cloneProfile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CloneTaxProfileDto) {
    return this.tax.cloneProfile(claims, id, dto);
  }

  @Get("payroll/tax/employees/:employeeId")
  getEmployeeTaxProfile(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.tax.getEmployeeTaxProfile(claims, employeeId);
  }

  @Get("payroll/tax/employees/:employeeId/history")
  getEmployeeTaxProfileHistory(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.tax.getEmployeeTaxProfileHistory(claims, employeeId);
  }

  @Put("payroll/tax/employees/:employeeId")
  setEmployeeTaxProfile(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: SetEmployeeTaxProfileDto) {
    return this.tax.setEmployeeTaxProfile(claims, employeeId, dto as never);
  }
}
