import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollBenefitsService } from "./payroll-benefits.service";
import { EndBenefitEnrolmentDto, EnrolBenefitDto, UpsertBenefitPlanDto } from "./dto/payroll-benefits.dto";

/** PAY-22 benefits. Permissions are decided in the service (existing payroll.* permissions). */
@Controller()
@UseGuards(SessionGuard)
export class PayrollBenefitsController {
  constructor(private readonly benefits: PayrollBenefitsService) {}

  @Get("payroll/benefit-plans")
  plans(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.benefits.listPlans(claims, includeInactive === "true");
  }

  @Post("payroll/benefit-plans")
  upsertPlan(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertBenefitPlanDto) {
    return this.benefits.upsertPlan(claims, dto);
  }

  @Get("payroll/benefit-plans/:planId/eligibility/:employeeId")
  eligibility(
    @CurrentClaims() claims: RequestClaims,
    @Param("planId", ParseUUIDPipe) planId: string,
    @Param("employeeId", ParseUUIDPipe) employeeId: string,
    @Query("asOf") asOf?: string
  ) {
    return this.benefits.checkEligibility(claims, planId, employeeId, asOf);
  }

  @Get("payroll/benefit-enrolments")
  enrolments(@CurrentClaims() claims: RequestClaims, @Query("planId") planId?: string, @Query("employeeId") employeeId?: string, @Query("status") status?: string) {
    return this.benefits.listEnrolments(claims, { planId, employeeId, status });
  }

  @Post("payroll/benefit-enrolments")
  enrol(@CurrentClaims() claims: RequestClaims, @Body() dto: EnrolBenefitDto) {
    return this.benefits.enrol(claims, dto);
  }

  @Post("payroll/benefit-enrolments/:id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: EndBenefitEnrolmentDto) {
    return this.benefits.endEnrolment(claims, id, dto);
  }

  @Get("payroll/benefit-contributions")
  contributions(@CurrentClaims() claims: RequestClaims, @Query("planId") planId?: string, @Query("employeeId") employeeId?: string, @Query("runId") runId?: string) {
    return this.benefits.listContributions(claims, { planId, employeeId, runId });
  }
}
