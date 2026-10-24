import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { InboxService, type InboxFilter } from "./inbox.service";
import { WorkflowService } from "./workflow.service";
import { DelegationsService } from "./delegations.service";
import { AttachmentVisibilityDto, CancelWorkflowDto, CreateDelegationDto, InboxDecisionDto, ResubmitDto, WorkflowCommentDto } from "./dto/inbox.dto";

/** My Inbox: any session; the services decide what each caller may see and do. */
@Controller("inbox")
@UseGuards(SessionGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly workflow: WorkflowService
  ) {}

  @Get("items")
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("tab") tab?: InboxFilter["tab"],
    @Query("objectKey") objectKey?: string,
    @Query("priority") priority?: InboxFilter["priority"],
    @Query("overdue") overdue?: string,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.inbox.list(claims, {
      tab,
      objectKey,
      priority,
      overdueOnly: overdue === "true",
      q,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get("counts")
  counts(@CurrentClaims() claims: RequestClaims) {
    return this.inbox.counts(claims);
  }

  @Get("items/:instanceId")
  get(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string) {
    return this.inbox.get(claims, instanceId);
  }

  @Post("items/:instanceId/decision")
  decide(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string, @Body() dto: InboxDecisionDto) {
    return this.inbox.decide(claims, instanceId, dto);
  }

  @Post("items/:instanceId/respond")
  respond(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string, @Body() dto: WorkflowCommentDto) {
    return this.workflow.respondToInfo(claims, instanceId, dto.body);
  }

  @Post("items/:instanceId/resubmit")
  resubmit(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string, @Body() dto: ResubmitDto) {
    return this.workflow.resubmit(claims, instanceId, dto);
  }

  @Post("items/:instanceId/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string, @Body() dto: CancelWorkflowDto) {
    return this.workflow.cancel(claims, instanceId, dto.reason);
  }

  @Get("items/:instanceId/comments")
  comments(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string) {
    return this.workflow.listComments(claims, instanceId);
  }

  @Post("items/:instanceId/comments")
  addComment(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string, @Body() dto: WorkflowCommentDto) {
    return this.workflow.addComment(claims, instanceId, dto.body, dto.visibility);
  }

  @Post("items/:instanceId/attachments")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  addAttachment(
    @CurrentClaims() claims: RequestClaims,
    @Param("instanceId", ParseUUIDPipe) instanceId: string,
    @Body() dto: AttachmentVisibilityDto,
    @UploadedFile() file: Express.Multer.File
  ) {
    return this.inbox.addAttachment(claims, instanceId, file, dto.visibility);
  }

  @Get("items/:instanceId/attachments")
  attachments(@CurrentClaims() claims: RequestClaims, @Param("instanceId", ParseUUIDPipe) instanceId: string) {
    return this.inbox.listAttachments(claims, instanceId);
  }

  @Get("items/:instanceId/attachments/:attachmentId")
  async download(
    @CurrentClaims() claims: RequestClaims,
    @Param("instanceId", ParseUUIDPipe) instanceId: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
    @Res() res: Response
  ) {
    const { buffer, fileName, mimeType } = await this.inbox.downloadAttachment(claims, instanceId, attachmentId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`);
    res.send(buffer);
  }
}

@Controller("delegations")
@UseGuards(SessionGuard)
export class DelegationsController {
  constructor(private readonly delegations: DelegationsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("all") all?: string) {
    return this.delegations.list(claims, { all: all === "true" });
  }

  @Get("candidates")
  candidates(@CurrentClaims() claims: RequestClaims, @Query("q") q?: string) {
    return this.delegations.candidates(claims, q ?? "");
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateDelegationDto) {
    return this.delegations.create(claims, dto);
  }

  @Post(":id/revoke")
  revoke(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.delegations.revoke(claims, id);
  }
}
