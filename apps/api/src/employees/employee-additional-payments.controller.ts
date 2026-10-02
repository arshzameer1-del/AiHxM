import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAdditionalPaymentsService } from "./employee-additional-payments.service";
import { CreateEmployeeAdditionalPaymentDto } from "./dto/create-employee-additional-payment.dto";

/** Payroll Enterprise Gap Analysis Phase P3, Section 6 — Additional
 * Payments (SAP IT0015 equivalent) CRUD surface, on the employee's own
 * profile. */
@Controller("employees/additional-payments")
@UseGuards(SessionGuard)
export class EmployeeAdditionalPaymentsController {
  constructor(private readonly payments: EmployeeAdditionalPaymentsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.payments.list(claims, employeeId);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeAdditionalPaymentDto) {
    return this.payments.create(claims, dto);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payments.cancel(claims, id);
  }
}
