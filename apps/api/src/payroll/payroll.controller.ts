import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollService } from "./payroll.service";
import { PayrollRunControlService } from "./payroll-run-control.service";
import { PayrollRetroService } from "./payroll-retro.service";
import { ClosePayrollRunDto, DetectPayrollRetroDto, IncludePayrollRetroDto, PayrollRunReasonDto, ResolvePayrollExceptionDto, SetPayrollOverrideDto } from "./dto/payroll-run-control.dto";
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
  constructor(
    private readonly payroll: PayrollService,
    private readonly control: PayrollRunControlService,
    private readonly retro: PayrollRetroService
  ) {}

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

  // PAY-06 - background calculation, progress and the per-employee error queue.
  @Post("payroll/runs/:id/calculate-async")
  calculateRunAsync(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.calculateRunAsync(claims, id);
  }

  @Get("payroll/runs/:id/calculation")
  getCalculationProgress(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.getCalculationProgress(claims, id);
  }

  @Get("payroll/runs/:id/variance")
  getRunVariance(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.getVariance(claims, id);
  }

  @Get("payroll/runs/:id/exceptions")
  listExceptions(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Query("status") status?: string) {
    return this.control.listExceptions(claims, id, status);
  }

  @Post("payroll/runs/:id/exceptions/:exceptionId/retry")
  retryException(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("exceptionId") exceptionId: string) {
    return this.payroll.retryException(claims, id, exceptionId);
  }

  @Post("payroll/runs/:id/exceptions/:exceptionId/waive")
  waiveException(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("exceptionId") exceptionId: string, @Body() dto: ResolvePayrollExceptionDto) {
    return this.control.waiveException(claims, id, exceptionId, dto.note);
  }

  // PAY-12 - arrears / retro. Same permission and payroll-area scope as calculating the run.
  @Post("payroll/runs/:id/retro/detect")
  detectRetro(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DetectPayrollRetroDto) {
    return this.retro.detect(claims, id, dto);
  }

  @Get("payroll/runs/:id/retro")
  listRetro(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Query("status") status?: string) {
    return this.retro.list(claims, id, status as never);
  }

  @Post("payroll/runs/:id/retro/include")
  includeRetro(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: IncludePayrollRetroDto) {
    return this.retro.include(claims, id, dto);
  }

  @Post("payroll/runs/:id/retro/exclude")
  excludeRetro(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: IncludePayrollRetroDto) {
    return this.retro.exclude(claims, id, dto);
  }

  @Post("payroll/retro/:retroId/dismiss")
  dismissRetro(@CurrentClaims() claims: RequestClaims, @Param("retroId") retroId: string, @Body() dto: ResolvePayrollExceptionDto) {
    return this.retro.dismiss(claims, retroId, dto.note);
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
    @Query("formatId") formatId: string | undefined,
    @Res() res: Response
  ) {
    const { csv, batch, excluded } = await this.payroll.generateDisbursementFile(claims, id, confirmRegenerate === "true", formatId || undefined);
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


  // --- Step 9A: run lifecycle controls (PAY-01, PAY-19, PAY-23) ---------------
  @Post("payroll/runs/:id/pre-validate")
  preValidateRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.preValidate(claims, id);
  }

  @Post("payroll/runs/:id/validate")
  validateRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.validate(claims, id);
  }

  @Post("payroll/runs/:id/close")
  closeRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ClosePayrollRunDto) {
    return this.control.close(claims, id, dto.note);
  }

  @Post("payroll/runs/:id/reopen")
  reopenRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PayrollRunReasonDto) {
    return this.control.reopen(claims, id, dto.reason);
  }

  @Post("payroll/runs/:id/cancel")
  cancelRun(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PayrollRunReasonDto) {
    return this.control.cancel(claims, id, dto.reason);
  }

  @Get("payroll/runs/:id/events")
  listRunEvents(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.listEvents(claims, id);
  }

  @Get("payroll/runs/:id/reversal")
  getRunReversal(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.getReversal(claims, id);
  }

  @Get("payroll/runs/:id/reopens")
  listRunReopens(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.listReopens(claims, id);
  }

  @Get("payroll/runs/:id/population")
  listRunPopulation(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Query("sequence") sequence?: string) {
    return this.control.listPopulation(claims, id, sequence ? Number(sequence) : undefined);
  }

  @Get("payroll/runs/:id/rule-snapshot")
  getRuleSnapshot(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.getRuleSnapshot(claims, id);
  }

  @Get("payroll/runs/:id/overrides")
  listOverrides(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.control.listOverrides(claims, id);
  }

  @Post("payroll/runs/:id/overrides")
  applyOverride(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetPayrollOverrideDto) {
    return this.control.applyOverride(claims, id, dto);
  }

  @Delete("payroll/runs/:id/overrides/:overrideId")
  withdrawOverride(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("overrideId") overrideId: string) {
    return this.control.withdrawOverride(claims, id, overrideId);
  }

  @Get("payslips")
  listPayslips(
    @CurrentClaims() claims: RequestClaims,
    @Query("payrollRunId") payrollRunId?: string,
    @Query("employeeId") employeeId?: string
  ) {
    return this.payroll.listPayslips(claims, { payrollRunId, employeeId });
  }

  @Get("payslips/:id/detail")
  getPayslipDetail(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.getPayslipDetail(claims, id);
  }

  @Get("payroll/ytd/:employeeId")
  getYtd(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Query("taxYear") taxYear?: string) {
    return this.payroll.getYtd(claims, employeeId, taxYear ? Number(taxYear) : undefined);
  }

  @Get("payslips/:id")
  getPayslip(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payroll.getPayslip(claims, id);
  }
}
