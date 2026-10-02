import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeLoansService } from "./employee-loans.service";
import { CancelEmployeeLoanDto, CreateEmployeeLoanDto } from "./dto/create-employee-loan.dto";

/** Payroll Enterprise Gap Analysis Phase P3 — Loans & Salary Advances
 * CRUD surface, on the employee's own profile (the SAP IT0045 equivalent
 * is Personnel Administration data, not a Payroll transaction screen). */
@Controller("employees/loans")
@UseGuards(SessionGuard)
export class EmployeeLoansController {
  constructor(private readonly loans: EmployeeLoansService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.loans.list(claims, employeeId);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeLoanDto) {
    return this.loans.create(claims, dto);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CancelEmployeeLoanDto) {
    return this.loans.cancel(claims, id, dto);
  }
}
