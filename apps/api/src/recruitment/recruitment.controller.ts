import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import type { ApplicationStage } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RecruitmentService } from "./recruitment.service";
import { CreateJobRequisitionDto } from "./dto/create-job-requisition.dto";
import { CreateCandidateDto } from "./dto/create-candidate.dto";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { MoveApplicationStageDto } from "./dto/move-application-stage.dto";
import { ExtendOfferDto } from "./dto/extend-offer.dto";
import { DecideOfferDto } from "./dto/decide-offer.dto";
import { DecideLeaveRequestDto } from "../leave/dto/decide-leave-request.dto";

/**
 * Any real session can call these (SessionGuard) — RecruitmentService's
 * own entitlement + `recruitment.manage.all` (and, for requisition
 * decisions, workflow-routing) checks are what actually decide who
 * succeeds, the same split every module since Phase 4 has used.
 * `DecideLeaveRequestDto` reused for requisition decisions — same
 * {decision, comment?} shape, no reason for a near-identical DTO.
 */
@Controller()
@UseGuards(SessionGuard)
export class RecruitmentController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Post("job-requisitions")
  createRequisition(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateJobRequisitionDto) {
    return this.recruitment.createRequisition(claims, dto);
  }

  @Get("job-requisitions")
  listRequisitions(@CurrentClaims() claims: RequestClaims) {
    return this.recruitment.listRequisitions(claims);
  }

  @Get("job-requisitions/:id")
  getRequisition(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.recruitment.getRequisition(claims, id);
  }

  @Post("job-requisitions/:id/submit")
  submitRequisition(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.recruitment.submitRequisition(claims, id);
  }

  @Patch("job-requisitions/:id/decision")
  decideRequisition(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideLeaveRequestDto) {
    return this.recruitment.decideRequisition(claims, id, dto);
  }

  @Post("candidates")
  createCandidate(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCandidateDto) {
    return this.recruitment.createCandidate(claims, dto);
  }

  @Get("candidates")
  listCandidates(@CurrentClaims() claims: RequestClaims) {
    return this.recruitment.listCandidates(claims);
  }

  @Post("applications")
  createApplication(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateApplicationDto) {
    return this.recruitment.createApplication(claims, dto);
  }

  @Get("applications")
  listApplications(@CurrentClaims() claims: RequestClaims, @Query("requisitionId") requisitionId?: string) {
    return this.recruitment.listApplications(claims, requisitionId);
  }

  @Patch("applications/:id/stage")
  moveApplicationStage(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: MoveApplicationStageDto) {
    return this.recruitment.moveApplicationStage(claims, id, dto.stage as ApplicationStage);
  }

  @Post("offers")
  extendOffer(@CurrentClaims() claims: RequestClaims, @Body() dto: ExtendOfferDto) {
    return this.recruitment.extendOffer(claims, dto);
  }

  @Post("offers/:id/rescind")
  rescindOffer(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.recruitment.rescindOffer(claims, id);
  }

  @Patch("offers/:id/decision")
  decideOffer(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideOfferDto) {
    return this.recruitment.decideOffer(claims, id, dto.decision);
  }
}
