import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { CreateEmployeePaymentAccountDto } from "./dto/create-employee-payment-account.dto";
import { UpdateEmployeePaymentAccountDto } from "./dto/update-employee-payment-account.dto";
import { RejectEmployeePaymentAccountDto, VerifyEmployeePaymentAccountDto } from "./dto/payment-account-workflow.dto";

/** Core Employee Enterprise Phase 8 — the Payment/Bank card's own CRUD surface, outside the hiring flow (editing an existing employee's payment accounts). */
@Controller("employees/payment-accounts")
@UseGuards(SessionGuard)
export class EmployeePaymentAccountsController {
  constructor(private readonly paymentAccounts: EmployeePaymentAccountsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeePaymentAccountDto) {
    return this.paymentAccounts.create(claims, dto);
  }

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("employeeId") employeeId: string,
    @Query("includeHistory") includeHistory?: string
  ) {
    return this.paymentAccounts.list(claims, employeeId, includeHistory === "true");
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeePaymentAccountDto) {
    return this.paymentAccounts.update(claims, id, dto);
  }

  /** EMP-08 maker-checker: a different user approves a pending account/replacement. */
  @Post(":id/approve")
  approve(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.paymentAccounts.approve(claims, id);
  }

  @Post(":id/reject")
  reject(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RejectEmployeePaymentAccountDto) {
    return this.paymentAccounts.reject(claims, id, dto.reason);
  }

  @Post(":id/verify")
  verify(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: VerifyEmployeePaymentAccountDto) {
    return this.paymentAccounts.verify(claims, id, dto.status);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.paymentAccounts.end(claims, id);
  }
}
