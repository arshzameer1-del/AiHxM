import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PerformanceService } from "./performance.service";
import { CreateReviewCycleDto } from "./dto/create-review-cycle.dto";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";
import { SubmitSelfAssessmentDto } from "./dto/submit-self-assessment.dto";
import { SubmitManagerAssessmentDto } from "./dto/submit-manager-assessment.dto";
import { CalibrateReviewDto } from "./dto/calibrate-review.dto";

/**
 * Any real session can call these (SessionGuard) — PerformanceService's
 * own entitlement + permission checks are what actually decide who
 * succeeds, the same split every module since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Post("review-cycles")
  createCycle(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateReviewCycleDto) {
    return this.performance.createCycle(claims, dto);
  }

  @Get("review-cycles")
  listCycles(@CurrentClaims() claims: RequestClaims) {
    return this.performance.listCycles(claims);
  }

  @Get("review-cycles/:id")
  getCycle(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.getCycle(claims, id);
  }

  @Post("review-cycles/:id/launch")
  launchCycle(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.launchCycle(claims, id);
  }

  @Post("review-cycles/:id/begin-calibration")
  beginCalibration(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.beginCalibration(claims, id);
  }

  @Post("review-cycles/:id/close")
  closeCycle(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.closeCycle(claims, id);
  }

  @Get("review-cycles/:id/rating-distribution")
  getRatingDistribution(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.getRatingDistribution(claims, id);
  }

  @Post("goals")
  createGoal(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateGoalDto) {
    return this.performance.createGoal(claims, dto);
  }

  @Get("goals")
  listGoals(
    @CurrentClaims() claims: RequestClaims,
    @Query("reviewCycleId") reviewCycleId?: string,
    @Query("employeeId") employeeId?: string
  ) {
    return this.performance.listGoals(claims, { reviewCycleId, employeeId });
  }

  @Patch("goals/:id")
  updateGoal(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateGoalDto) {
    return this.performance.updateGoal(claims, id, dto);
  }

  @Get("performance-reviews")
  listReviews(
    @CurrentClaims() claims: RequestClaims,
    @Query("reviewCycleId") reviewCycleId?: string,
    @Query("employeeId") employeeId?: string
  ) {
    return this.performance.listReviews(claims, { reviewCycleId, employeeId });
  }

  @Get("performance-reviews/:id")
  getReview(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.getReview(claims, id);
  }

  @Patch("performance-reviews/:id/self-assessment")
  submitSelfAssessment(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SubmitSelfAssessmentDto) {
    return this.performance.submitSelfAssessment(claims, id, dto);
  }

  @Patch("performance-reviews/:id/manager-assessment")
  submitManagerAssessment(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SubmitManagerAssessmentDto) {
    return this.performance.submitManagerAssessment(claims, id, dto);
  }

  @Patch("performance-reviews/:id/calibrate")
  calibrateReview(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CalibrateReviewDto) {
    return this.performance.calibrateReview(claims, id, dto);
  }
}
