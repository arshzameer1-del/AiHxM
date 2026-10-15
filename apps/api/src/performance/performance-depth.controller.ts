import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PerformanceService } from "./performance.service";
import { PerformanceDepthService } from "./performance-depth.service";
import {
  CreateDevelopmentPlanDto,
  DevelopmentItemDto,
  EvidenceDto,
  GiveFeedbackDto,
  GoalPlanDto,
  RequestFeedbackDto,
  ReopenGoalPlanDto,
  RespondFeedbackDto,
  SetPhasesDto,
  SetReviewRatingsDto,
  UpdateDevelopmentItemDto,
  UpdateDevelopmentPlanDto,
  UpdatePerformanceSettingsDto,
  UpsertCompetencyDto,
} from "./dto/performance-depth.dto";

/**
 * TAL-05/06/07 routes: goal history and plans, review phases, competencies, per-goal/per-competency ratings, feedback and
 * multi-rater requests, development plans and the tenant performance settings. Authorisation lives in the services.
 */
@Controller()
@UseGuards(SessionGuard)
export class PerformanceDepthController {
  constructor(
    private readonly performance: PerformanceService,
    private readonly depth: PerformanceDepthService
  ) {}

  // --- goals: history, evidence, plans (TAL-05) ---
  @Get("goals/:id/updates")
  listGoalUpdates(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.listGoalUpdates(claims, id);
  }

  @Get("goals/:id/evidence")
  listGoalEvidence(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.listGoalEvidence(claims, id);
  }

  @Post("goals/:id/evidence")
  addGoalEvidence(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: EvidenceDto) {
    return this.performance.addGoalEvidence(claims, id, dto);
  }

  @Delete("goals/:id/evidence/:evidenceId")
  removeGoalEvidence(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("evidenceId") evidenceId: string) {
    return this.performance.removeGoalEvidence(claims, id, evidenceId);
  }

  @Get("goal-plans")
  getGoalPlan(@CurrentClaims() claims: RequestClaims, @Query("reviewCycleId") reviewCycleId: string, @Query("employeeId") employeeId: string) {
    return this.performance.getGoalPlan(claims, reviewCycleId, employeeId);
  }

  @Post("goal-plans/finalise")
  finaliseGoalPlan(@CurrentClaims() claims: RequestClaims, @Body() dto: GoalPlanDto) {
    return this.performance.finaliseGoalPlan(claims, dto);
  }

  @Post("goal-plans/reopen")
  reopenGoalPlan(@CurrentClaims() claims: RequestClaims, @Body() dto: ReopenGoalPlanDto) {
    return this.performance.reopenGoalPlan(claims, dto);
  }

  // --- phases (TAL-07) ---
  @Get("review-cycles/:id/phases")
  getPhases(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.performance.getPhases(claims, id);
  }

  @Put("review-cycles/:id/phases")
  setPhases(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetPhasesDto) {
    return this.performance.setPhases(claims, id, dto);
  }

  // --- settings ---
  @Get("performance/settings")
  getSettings(@CurrentClaims() claims: RequestClaims) {
    return this.depth.getSettings(claims);
  }

  @Put("performance/settings")
  updateSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdatePerformanceSettingsDto) {
    return this.depth.updateSettings(claims, dto);
  }

  // --- competencies ---
  @Get("competencies")
  listCompetencies(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.depth.listCompetencies(claims, includeInactive === "true");
  }

  @Post("competencies")
  createCompetency(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertCompetencyDto) {
    return this.depth.createCompetency(claims, dto);
  }

  @Patch("competencies/:id")
  updateCompetency(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpsertCompetencyDto) {
    return this.depth.updateCompetency(claims, id, dto);
  }

  // --- ratings and scorecard ---
  @Put("performance-reviews/:id/ratings")
  setRatings(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetReviewRatingsDto) {
    return this.depth.setRatings(claims, id, dto);
  }

  @Get("performance-reviews/:id/scorecard")
  getScorecard(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.depth.getScorecard(claims, id);
  }

  // --- feedback ---
  @Post("feedback")
  giveFeedback(@CurrentClaims() claims: RequestClaims, @Body() dto: GiveFeedbackDto) {
    return this.depth.giveFeedback(claims, dto);
  }

  @Get("feedback/given")
  listFeedbackGiven(@CurrentClaims() claims: RequestClaims) {
    return this.depth.listFeedbackGiven(claims);
  }

  @Get("feedback")
  listFeedbackAbout(@CurrentClaims() claims: RequestClaims, @Query("subjectEmployeeId") subjectEmployeeId: string) {
    return this.depth.listFeedbackAbout(claims, subjectEmployeeId);
  }

  @Post("performance-reviews/:id/feedback-requests")
  requestFeedback(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RequestFeedbackDto) {
    return this.depth.requestFeedback(claims, id, dto);
  }

  @Get("performance-reviews/:id/feedback-requests")
  listRequestsForReview(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.depth.listRequestsForReview(claims, id);
  }

  @Get("feedback-requests/mine")
  listMyRequests(@CurrentClaims() claims: RequestClaims) {
    return this.depth.listMyRequests(claims);
  }

  @Post("feedback-requests/:id/respond")
  respond(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RespondFeedbackDto) {
    return this.depth.respondToRequest(claims, id, dto);
  }

  @Post("feedback-requests/:id/decline")
  decline(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.depth.declineRequest(claims, id);
  }

  @Post("feedback-requests/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.depth.cancelRequest(claims, id);
  }

  // --- development plans ---
  @Post("development-plans")
  createPlan(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateDevelopmentPlanDto) {
    return this.depth.createPlan(claims, dto);
  }

  @Get("development-plans")
  listPlans(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.depth.listPlans(claims, employeeId);
  }

  @Get("development-plans/:id")
  getPlan(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.depth.getPlan(claims, id);
  }

  @Patch("development-plans/:id")
  updatePlan(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateDevelopmentPlanDto) {
    return this.depth.updatePlan(claims, id, dto);
  }

  @Post("development-plans/:id/items")
  addPlanItem(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DevelopmentItemDto) {
    return this.depth.addPlanItem(claims, id, dto);
  }

  @Patch("development-plan-items/:itemId")
  updatePlanItem(@CurrentClaims() claims: RequestClaims, @Param("itemId") itemId: string, @Body() dto: UpdateDevelopmentItemDto) {
    return this.depth.updatePlanItem(claims, itemId, dto);
  }

  @Delete("development-plan-items/:itemId")
  removePlanItem(@CurrentClaims() claims: RequestClaims, @Param("itemId") itemId: string) {
    return this.depth.removePlanItem(claims, itemId);
  }
}
