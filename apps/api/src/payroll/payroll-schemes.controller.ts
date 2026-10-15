import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { FinalSettlementStatus, PayrollSchemeParameters } from "@aihxm/shared-types";
import { PayrollSchemesService } from "./payroll-schemes.service";
import { PayrollFinalSettlementService } from "./payroll-final-settlement.service";
import { OpenSchemeAccountDto, PostSchemeLedgerEntryDto, SchemeReasonDto, UpdateSettlementSettingsDto, UpsertPayrollSchemeDto } from "./dto/payroll-schemes.dto";

/** PAY-14 final settlements and PAY-15 scheme ledgers. Permissions are decided in the services (existing payroll.* permissions). */
@Controller()
@UseGuards(SessionGuard)
export class PayrollSchemesController {
  constructor(
    private readonly schemes: PayrollSchemesService,
    private readonly settlements: PayrollFinalSettlementService
  ) {}

  @Get("payroll/schemes")
  listSchemes(@CurrentClaims() claims: RequestClaims, @Query("history") history?: string) {
    return this.schemes.listSchemes(claims, history === "true");
  }

  @Post("payroll/schemes")
  upsertScheme(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertPayrollSchemeDto) {
    return this.schemes.upsertScheme(claims, { ...dto, parameters: dto.parameters as PayrollSchemeParameters | undefined });
  }

  @Get("payroll/settlement-settings")
  getSettlementSettings(@CurrentClaims() claims: RequestClaims) {
    return this.schemes.getSettlementSettings(claims);
  }

  @Patch("payroll/settlement-settings")
  updateSettlementSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdateSettlementSettingsDto) {
    return this.schemes.updateSettlementSettings(claims, dto);
  }

  @Get("payroll/employees/:employeeId/scheme-accounts")
  listAccounts(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.schemes.listAccounts(claims, employeeId);
  }

  @Post("payroll/employees/:employeeId/scheme-accounts")
  openAccount(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: OpenSchemeAccountDto) {
    return this.schemes.openAccount(claims, employeeId, dto.schemeCode);
  }

  @Get("payroll/scheme-accounts/:id/ledger")
  listLedger(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.schemes.listLedger(claims, id);
  }

  @Post("payroll/scheme-accounts/:id/ledger")
  postEntry(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PostSchemeLedgerEntryDto) {
    return this.schemes.postEntry(claims, id, dto);
  }

  @Post("payroll/scheme-ledger/:entryId/reverse")
  reverseEntry(@CurrentClaims() claims: RequestClaims, @Param("entryId") entryId: string, @Body() dto: SchemeReasonDto) {
    return this.schemes.reverseEntry(claims, entryId, dto.reason);
  }

  @Get("payroll/final-settlements")
  listSettlements(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string, @Query("employeeId") employeeId?: string) {
    return this.settlements.list(claims, { status: status as FinalSettlementStatus | undefined, employeeId });
  }

  @Get("payroll/final-settlements/:id")
  getSettlement(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.settlements.get(claims, id);
  }

  @Post("payroll/final-settlements/:id/calculate")
  calculate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.settlements.calculate(claims, id);
  }

  @Post("payroll/final-settlements/:id/approve")
  approve(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.settlements.approve(claims, id);
  }

  @Post("payroll/final-settlements/:id/withdraw-approval")
  withdraw(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SchemeReasonDto) {
    return this.settlements.withdrawApproval(claims, id, dto.reason);
  }

  @Post("payroll/final-settlements/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SchemeReasonDto) {
    return this.settlements.cancel(claims, id, dto.reason);
  }
}
