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
import { UpdatePayrollDisbursementSettingsDto } from "./dto/update-payroll-disbursement-settings.dto";
import { VoidPaymentBatchDto } from "./dto/void-payment-batch.dto";
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

  // Phase P5 — read-only preview (row/excluded-employee counts, the
  // existing batch if any) BEFORE committing to a new
  // `payroll_payment_batches` row. The frontend calls this first so HR can
  // see the duplicate-payment warning / excluded list and decide, rather
  // than finding out only after a file has already downloaded.
  @Get("payroll/runs/:id/disbursement/preview")
  previewDisbursementFile(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.previewDisbursementFile(claims, id);
  }

  @Get("payroll/runs/:id/disbursement")
  async disbursementFile(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Query("confirmRegenerate") confirmRegenerate: string | undefined,
    @Res() res: Response
  ) {
    const { csv, batch, excluded } = await this.payroll.generateDisbursementFile(claims, id, confirmRegenerate === "true");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-disbursement-${id}.csv"`);
    // Phase P5 — the browser-download endpoint can't return a JSON body
    // alongside the file, so the batch reference / excluded count ride as
    // headers (the frontend's `previewDisbursementFile()` call already
    // showed the full excluded list before this request was even made).
    res.setHeader("X-Payroll-Batch-Reference", batch.batchReference);
    res.setHeader("X-Payroll-Excluded-Count", String(excluded.length));
    res.send(csv);
  }

  @Get("payroll/runs/:id/payment-batches")
  listPaymentBatches(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.listPaymentBatches(claims, id);
  }

  @Post("payroll/payment-batches/:id/void")
  voidPaymentBatch(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: VoidPaymentBatchDto) {
    return this.payroll.voidPaymentBatch(claims, id, dto.reason);
  }

  @Get("payroll/disbursement-settings")
  getDisbursementSettings(@CurrentClaims() claims: RequestClaims) {
    return this.payroll.getDisbursementSettings(claims);
  }

  @Patch("payroll/disbursement-settings")
  updateDisbursementSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdatePayrollDisbursementSettingsDto) {
    return this.payroll.updateDisbursementSettings(claims, dto);
  }

  @Get("payroll/runs/:id/cost-breakdown")
  getCostCenterBreakdown(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.getCostCenterBreakdown(claims, id);
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
