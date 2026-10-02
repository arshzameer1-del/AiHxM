import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollFormulaOverridesService } from "./payroll-formula-overrides.service";
import { CreatePayrollFormulaDto, EndDatePayrollFormulaDto, UpdatePayrollFormulaDto } from "./dto/payroll-formula.dto";

/**
 * Payroll Formula Engine overrides (0105_payroll_formulas.sql).
 * SessionGuard only — the entitlement + `payroll.calculate.all` check (the
 * same permission as payroll settings/tax slabs) lives in
 * PayrollFormulaOverridesService, the split every module since Phase 4 uses.
 */
@Controller("payroll/formulas")
@UseGuards(SessionGuard)
export class PayrollFormulaOverridesController {
  constructor(private readonly overrides: PayrollFormulaOverridesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("formulaKey") formulaKey?: string) {
    return this.overrides.list(claims, { formulaKey });
  }

  // Declared before `:id` routes so "contract" is never captured as an id.
  @Get("contract")
  getContract(@CurrentClaims() claims: RequestClaims) {
    return this.overrides.getContract(claims);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePayrollFormulaDto) {
    return this.overrides.create(claims, dto);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdatePayrollFormulaDto) {
    return this.overrides.update(claims, id, dto);
  }

  @Post(":id/end-date")
  endDate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: EndDatePayrollFormulaDto) {
    return this.overrides.endDate(claims, id, dto);
  }
}
