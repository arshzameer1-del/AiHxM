import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { CreateEmployeePaymentAccountDto } from "./dto/create-employee-payment-account.dto";
import { UpdateEmployeePaymentAccountDto } from "./dto/update-employee-payment-account.dto";

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
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.paymentAccounts.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeePaymentAccountDto) {
    return this.paymentAccounts.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.paymentAccounts.end(claims, id);
  }
}
