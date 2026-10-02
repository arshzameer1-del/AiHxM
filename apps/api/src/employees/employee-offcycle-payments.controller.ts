import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeOffCyclePaymentsService } from "./employee-offcycle-payments.service";
import { CreateEmployeeOffCyclePaymentDto } from "./dto/create-employee-offcycle-payment.dto";

/** Payroll Enterprise Gap Analysis Phase P4 — Additional Off-Cycle
 * Payments (SAP IT0267 equivalent) CRUD surface. Listed by `payrollRunId`
 * (not `employeeId` — the natural admin screen here is "everything
 * queued for this off-cycle run", building it up before calculating). */
@Controller("employees/offcycle-payments")
@UseGuards(SessionGuard)
export class EmployeeOffCyclePaymentsController {
  constructor(private readonly payments: EmployeeOffCyclePaymentsService) {}

  @Get()
  listForRun(@CurrentClaims() claims: RequestClaims, @Query("payrollRunId") payrollRunId: string) {
    return this.payments.listForRun(claims, payrollRunId);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeOffCyclePaymentDto) {
    return this.payments.create(claims, dto);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.payments.cancel(claims, id);
  }
}
