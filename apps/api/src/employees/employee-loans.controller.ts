import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeLoansService } from "./employee-loans.service";
import {
  CancelEmployeeLoanDto,
  CreateEmployeeLoanDto,
  GenerateLoanScheduleDto,
  HoldEmployeeLoanDto,
  ResumeEmployeeLoanDto,
  SettleEmployeeLoanDto,
  SkipLoanInstallmentsDto,
  UpsertLoanTypeDto,
} from "./dto/create-employee-loan.dto";

/** Payroll Enterprise Gap Analysis Phase P3 + PAY-13 - Loans & Salary Advances on the employee's own profile
 * (the SAP IT0045 equivalent is Personnel Administration data, not a Payroll transaction screen). */
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

  // catalogue (declared before the :id routes)
  @Get("types")
  listTypes(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.loans.listTypes(claims, includeInactive === "true");
  }

  @Post("types")
  createType(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertLoanTypeDto) {
    return this.loans.createType(claims, dto);
  }

  @Patch("types/:typeId")
  updateType(@CurrentClaims() claims: RequestClaims, @Param("typeId") typeId: string, @Body() dto: UpsertLoanTypeDto) {
    return this.loans.updateType(claims, typeId, dto);
  }

  @Get(":id/schedule")
  schedule(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.loans.getSchedule(claims, id);
  }

  @Get(":id/repayments")
  repayments(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.loans.listRepayments(claims, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CancelEmployeeLoanDto) {
    return this.loans.cancel(claims, id, dto);
  }

  @Post(":id/hold")
  hold(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: HoldEmployeeLoanDto) {
    return this.loans.hold(claims, id, dto);
  }

  @Post(":id/resume")
  resume(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ResumeEmployeeLoanDto) {
    return this.loans.resume(claims, id, dto);
  }

  @Post(":id/skip")
  skip(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SkipLoanInstallmentsDto) {
    return this.loans.skipInstallments(claims, id, dto);
  }

  @Post(":id/settle")
  settle(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SettleEmployeeLoanDto) {
    return this.loans.settle(claims, id, dto);
  }

  @Post(":id/generate-schedule")
  generateSchedule(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: GenerateLoanScheduleDto) {
    return this.loans.generateSchedule(claims, id, dto);
  }
}
