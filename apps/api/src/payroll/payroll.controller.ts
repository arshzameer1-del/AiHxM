import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollService } from "./payroll.service";
import { SetCompensationDto } from "./dto/set-compensation.dto";
import { UpdatePayrollSettingsDto } from "./dto/update-payroll-settings.dto";
import { SetTaxSlabsDto } from "./dto/set-tax-slabs.dto";
import { CreatePayrollRunDto } from "./dto/create-payroll-run.dto";

/**
 * Any real session can call these (SessionGuard) — PayrollService's own
 * entitlement + `payroll.manage.all` / `payroll_review.view.self`
 * permission checks are what actually decide who succeeds, the same
 * split every module since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Post("payroll/compensation")
  setCompensation(@CurrentClaims() claims: RequestClaims, @Body() dto: SetCompensationDto) {
    return this.payroll.setCompensation(claims, dto);
  }

  @Get("payroll/compensation/:employeeId")
  getCompensationHistory(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.payroll.getCompensationHistory(claims, employeeId);
  }

  @Get("payroll/settings")
  getSettings(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.getSettings(claims);
  }

  @Patch("payroll/settings")
  updateSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdatePayrollSettingsDto) {
    return this.payroll.updateSettings(claims, dto);
  }

  @Get("payroll/tax-slabs")
  listTaxSlabs(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.listTaxSlabs(claims);
  }

  @Post("payroll/tax-slabs")
  setTaxSlabs(@CurrentClaims() claims: RequestClaims, @Body() dto: SetTaxSlabsDto) {
    return this.payroll.setTaxSlabs(claims, {
      slabs: dto.slabs.map((s) => ({ ...s, maxAnnualIncome: s.maxAnnualIncome ?? null })),
    });
  }

  @Post("payroll/runs")
  createRun(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePayrollRunDto) {
    return this.payroll.createRun(claims, dto);
  }

  @Get("payroll/runs")
  listRuns(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.listRuns(claims);
  }

  @Get("payroll/runs/:id")
  getRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.getRun(claims, id);
  }

  @Post("payroll/runs/:id/calculate")
  calculateRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.calculateRun(claims, id);
  }

  @Post("payroll/runs/:id/finalize")
  finalizeRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.finalizeRun(claims, id);
  }

  @Get("payroll/runs/:id/disbursement")
  async disbursementFile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Res() res: Response) {
    const csv = await this.payroll.generateDisbursementFile(claims, id);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-disbursement-${id}.csv"`);
    res.send(csv);
  }

  @Get("payslips")
  listPayslips(
    @CurrentClaims() claims: RequestClaims,
    @Query("payrollRunId") payrollRunId?: string,
    @Query("employeeId") employeeId?: string
  ) {
    return this.payroll.listPayslips(claims, { payrollRunId, employeeId });
  }

  @Get("payslips/:id")
  getPayslip(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.getPayslip(claims, id);
  }
}
