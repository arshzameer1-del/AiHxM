import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { PayrollReconciliationKind } from "@aihxm/shared-types";
import { PayrollPaymentsService } from "./payroll-payments.service";
import { PayrollReconciliationService } from "./payroll-reconciliation.service";
import { AcknowledgePaymentBatchDto, ReissuePaymentItemsDto, ResolvePayrollReconciliationDto, RunPayrollReconciliationDto, UpsertBankFileFormatDto } from "./dto/payroll-payments.dto";

/** PAY-16 payment lifecycle and PAY-18 reconciliations. Permissions are decided in the services (existing payroll.* permissions). */
@Controller()
@UseGuards(SessionGuard)
export class PayrollPaymentsController {
  constructor(
    private readonly payments: PayrollPaymentsService,
    private readonly reconciliations: PayrollReconciliationService
  ) {}

  @Get("payroll/bank-file-formats")
  listFormats(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.payments.listFormats(claims, includeInactive === "true");
  }

  @Post("payroll/bank-file-formats")
  createFormat(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertBankFileFormatDto) {
    return this.payments.createFormat(claims, dto);
  }

  @Patch("payroll/bank-file-formats/:id")
  updateFormat(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpsertBankFileFormatDto) {
    return this.payments.updateFormat(claims, id, dto);
  }

  @Get("payroll/runs/:id/payment-items")
  listRunItems(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payments.listRunItems(claims, id);
  }

  @Get("payroll/payment-batches/:id/items")
  listBatchItems(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payments.listBatchItems(claims, id);
  }

  @Post("payroll/payment-batches/:id/approve")
  approve(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payments.approveBatch(claims, id);
  }

  @Post("payroll/payment-batches/:id/release")
  release(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payments.releaseBatch(claims, id);
  }

  @Post("payroll/payment-batches/:id/acknowledge")
  acknowledge(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AcknowledgePaymentBatchDto) {
    return this.payments.acknowledgeBatch(claims, id, dto);
  }

  @Post("payroll/payment-batches/:id/reissue")
  reissue(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ReissuePaymentItemsDto) {
    return this.payments.reissueRejected(claims, id, dto);
  }

  @Get("payroll/runs/:id/reconciliations")
  listReconciliations(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.reconciliations.list(claims, id);
  }

  @Post("payroll/runs/:id/reconciliations")
  runReconciliations(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RunPayrollReconciliationDto) {
    return this.reconciliations.run(claims, id, dto.kinds as PayrollReconciliationKind[] | undefined);
  }

  @Post("payroll/reconciliations/:id/resolve")
  resolveReconciliation(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ResolvePayrollReconciliationDto) {
    return this.reconciliations.resolve(claims, id, dto.note);
  }
}
