import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import type { ApplicationStage, JobRequisitionAction } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RecruitmentService } from "./recruitment.service";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { CreateJobRequisitionDto } from "./dto/create-job-requisition.dto";
import { RequisitionActionDto, UpdateJobRequisitionDto } from "./dto/update-job-requisition.dto";
import { AnonymiseCandidateDto, CandidateDuplicateCheckDto, CreateCandidateDto, UpdateCandidateDto } from "./dto/create-candidate.dto";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { MoveApplicationStageDto } from "./dto/move-application-stage.dto";
import { ExtendOfferDto, GenerateOfferLetterDto, RescindOfferDto } from "./dto/extend-offer.dto";
import {
  CreatePreEmploymentCheckDto,
  EventAttendanceDto,
  EventAttendeeDto,
  ScheduleInterviewDto,
  SubmitInterviewFeedbackDto,
  UpdateInterviewDto,
  UpdatePreEmploymentCheckDto,
  UpdateRecruitmentSettingsDto,
  UploadCandidateDocumentDto,
  UpsertRecruitmentEventDto,
} from "./dto/recruitment-pipeline.dto";
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
  constructor(
    private readonly recruitment: RecruitmentService,
    private readonly pipeline: RecruitmentPipelineService
  ) {}

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

  @Patch("job-requisitions/:id")
  updateRequisition(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateJobRequisitionDto) {
    return this.recruitment.updateRequisition(claims, id, dto);
  }

  @Post("job-requisitions/:id/actions/:action")
  requisitionAction(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("action") action: JobRequisitionAction,
    @Body() dto: RequisitionActionDto
  ) {
    return this.recruitment.applyRequisitionAction(claims, id, action, dto?.reason);
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

  @Post("candidates/duplicate-check")
  checkDuplicates(@CurrentClaims() claims: RequestClaims, @Body() dto: CandidateDuplicateCheckDto) {
    return this.recruitment.checkCandidateDuplicates(claims, dto);
  }

  @Get("candidates/:id")
  getCandidate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.recruitment.getCandidate(claims, id);
  }

  @Patch("candidates/:id")
  updateCandidate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateCandidateDto) {
    return this.recruitment.updateCandidate(claims, id, dto);
  }

  @Post("candidates/:id/anonymise")
  anonymiseCandidate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AnonymiseCandidateDto) {
    return this.pipeline.anonymiseCandidate(claims, id, dto.reason);
  }

  @Get("candidates/:id/timeline")
  candidateTimeline(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.pipeline.getCandidateTimeline(claims, id);
  }

  @Post("candidates/:id/documents")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadCandidateDocument(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UploadCandidateDocumentDto,
    @UploadedFile() file: Express.Multer.File
  ) {
    return this.pipeline.addDocument(claims, id, dto.docType, file);
  }

  @Get("candidates/:id/documents")
  listCandidateDocuments(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.pipeline.listDocuments(claims, id);
  }

  @Get("candidates/:id/documents/:documentId")
  async downloadCandidateDocument(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Res() res: Response
  ) {
    const { buffer, fileName, mimeType } = await this.pipeline.downloadDocument(claims, id, documentId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    res.send(buffer);
  }

  @Delete("candidates/:id/documents/:documentId")
  deleteCandidateDocument(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("documentId") documentId: string) {
    return this.pipeline.deleteDocument(claims, id, documentId);
  }

  @Get("recruitment/settings")
  getSettings(@CurrentClaims() claims: RequestClaims) {
    return this.pipeline.getSettings(claims);
  }

  @Put("recruitment/settings")
  updateSettings(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdateRecruitmentSettingsDto) {
    return this.pipeline.updateSettings(claims, dto);
  }

  @Post("applications")
  createApplication(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateApplicationDto) {
    return this.recruitment.createApplication(claims, dto);
  }

  @Get("applications")
  listApplications(@CurrentClaims() claims: RequestClaims, @Query("requisitionId") requisitionId?: string) {
    return this.recruitment.listApplications(claims, requisitionId);
  }

  @Get("applications/:id/timeline")
  applicationTimeline(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.pipeline.getApplicationTimeline(claims, id);
  }

  @Patch("applications/:id/stage")
  moveApplicationStage(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: MoveApplicationStageDto) {
    return this.recruitment.moveApplicationStage(claims, id, dto.stage as ApplicationStage, dto.reason);
  }

  @Get("offers")
  listOffers(@CurrentClaims() claims: RequestClaims, @Query("applicationId") applicationId?: string) {
    return this.recruitment.listOffers(claims, applicationId);
  }

  @Post("offers")
  extendOffer(@CurrentClaims() claims: RequestClaims, @Body() dto: ExtendOfferDto) {
    return this.recruitment.extendOffer(claims, dto);
  }

  @Post("offers/:id/rescind")
  rescindOffer(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RescindOfferDto) {
    return this.recruitment.rescindOffer(claims, id, dto.reason);
  }

  @Post("offers/:id/letters")
  generateLetter(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: GenerateOfferLetterDto) {
    return this.pipeline.generateOfferLetter(claims, id, dto);
  }

  @Get("offers/:id/letters")
  listLetters(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.pipeline.listOfferLetters(claims, id);
  }

  @Patch("offers/:id/decision")
  decideOffer(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideOfferDto) {
    return this.recruitment.decideOffer(claims, id, dto.decision, dto.reason);
  }

  // --- interviews, feedback, checks -------------------------------------

  @Post("interviews")
  scheduleInterview(@CurrentClaims() claims: RequestClaims, @Body() dto: ScheduleInterviewDto) {
    return this.pipeline.scheduleInterview(claims, dto);
  }

  @Get("interviews")
  listInterviews(@CurrentClaims() claims: RequestClaims, @Query("applicationId") applicationId?: string) {
    return this.pipeline.listInterviews(claims, applicationId);
  }

  @Get("interviews/mine")
  myInterviews(@CurrentClaims() claims: RequestClaims) {
    return this.pipeline.listMyInterviews(claims);
  }

  @Patch("interviews/:id")
  updateInterview(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateInterviewDto) {
    return this.pipeline.updateInterview(claims, id, dto);
  }

  @Post("interviews/:id/feedback")
  submitFeedback(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SubmitInterviewFeedbackDto) {
    return this.pipeline.submitFeedback(claims, id, dto);
  }

  @Post("pre-employment-checks")
  createCheck(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePreEmploymentCheckDto) {
    return this.pipeline.createCheck(claims, dto);
  }

  @Get("pre-employment-checks")
  listChecks(@CurrentClaims() claims: RequestClaims, @Query("applicationId") applicationId: string) {
    return this.pipeline.listChecks(claims, applicationId);
  }

  @Patch("pre-employment-checks/:id")
  updateCheck(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdatePreEmploymentCheckDto) {
    return this.pipeline.updateCheck(claims, id, dto);
  }

  // --- events and calendar ----------------------------------------------

  @Get("recruitment-events")
  listEvents(@CurrentClaims() claims: RequestClaims) {
    return this.pipeline.listEvents(claims);
  }

  @Post("recruitment-events")
  createEvent(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertRecruitmentEventDto) {
    return this.pipeline.createEvent(claims, dto);
  }

  @Put("recruitment-events/:id")
  updateEvent(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpsertRecruitmentEventDto) {
    return this.pipeline.updateEvent(claims, id, dto);
  }

  @Get("recruitment-events/:id/attendees")
  listAttendees(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.pipeline.listEventAttendees(claims, id);
  }

  @Post("recruitment-events/:id/attendees")
  addAttendee(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: EventAttendeeDto) {
    return this.pipeline.addEventAttendee(claims, id, dto.candidateId);
  }

  @Patch("recruitment-events/:id/attendees/:candidateId")
  markAttendance(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("candidateId") candidateId: string,
    @Body() dto: EventAttendanceDto
  ) {
    return this.pipeline.markEventAttendance(claims, id, candidateId, dto.attended);
  }

  @Delete("recruitment-events/:id/attendees/:candidateId")
  removeAttendee(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("candidateId") candidateId: string) {
    return this.pipeline.removeEventAttendee(claims, id, candidateId);
  }

  @Get("recruitment-calendar")
  calendar(@CurrentClaims() claims: RequestClaims, @Query("from") from: string, @Query("to") to: string) {
    return this.pipeline.getCalendar(claims, from, to);
  }
}
