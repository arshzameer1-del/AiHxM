import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollService } from "./payroll.service";
import { UpdatePayrollSettingsDto } from "./dto/update-payroll-settings.dto";
import { SetTaxSlabsDto } from "./dto/set-tax-slabs.dto";
import { CreatePayrollRunDto } from "./dto/create-payroll-run.dto";
import { ReversePayrollRunDto } from "./dto/reverse-payroll-run.dto";
import { DecideLeaveRequestDto } from "../leave/dto/decide-leave-request.dto";

/**
 * Any real session can call these (SessionGuard) — PayrollService's own
 * entitlement + permission checks (`payroll.calculate.all` /
 * `.finalize.all` / `.disburse.all` / `.approve.all` /
 * `payroll_review.view.self` — see PayrollService's own header constants)
 * are what actually decide who succeeds, the same split every module
 * since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  // Compensation moved to `employees/compensation*`
  // (EmployeeCompensationController, 2026-09-27, kumail's own architecture
  // correction) — it is Core Employee master data (the SAP IT0008/IT0014
  // equivalent), not a Payroll-owned record. See
  // EmployeeCompensationService's own doc comment.

  @Get("payroll/settings")
  getSettings(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.getSettings(claims);
  }

  @Patch("payroll/settings")
  updateSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdatePayrollSettingsDto) {
    return this.payroll.updateSettings(claims, dto);
  }

  @Get("payroll/settings/history")
  getSettingsHistory(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.getSettingsHistory(claims);
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

  @Get("payroll/tax-slabs/history")
  getTaxSlabHistory(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.getTaxSlabHistory(claims);
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

  // Phase P2 — approval workflow. `DecideLeaveRequestDto` reused for the
  // decision body, same {decision, comment?} shape RecruitmentController
  // already reuses it for.
  @Post("payroll/runs/:id/submit-for-approval")
  submitForApproval(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.submitForApproval(claims, id);
  }

  @Patch("payroll/runs/:id/approval-decision")
  decideApproval(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideLeaveRequestDto) {
    return this.payroll.decideApproval(claims, id, dto);
  }

  @Get("payroll/runs/:id/disbursement")
  async disbursementFile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Res() res: Response) {
    const csv = await this.payroll.generateDisbursementFile(claims, id);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-disbursement-${id}.csv"`);
    res.send(csv);
  }

  // Phase P2 — Correction/Reversal. Only a `finalized` run can be
  // reversed; see PayrollService.reverseRun()'s own doc comment.
  @Post("payroll/runs/:id/reverse")
  reverseRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ReversePayrollRunDto) {
    return this.payroll.reverseRun(claims, id, dto);
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
