import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { WorkflowService } from "./workflow.service";
import { InboxService } from "./inbox.service";
import { CreateWorkflowTemplateDto, UpdateWorkflowTemplateDto } from "./dto/create-workflow-template.dto";
import { CancelWorkflowDto, ResubmitDto, SetTemplateActiveDto, WorkflowCommentDto } from "./dto/inbox.dto";
import { ApprovalDecisionDto, SubmitForApprovalDto } from "./dto/submit-for-approval.dto";

/**
 * Any real session can call these — same posture as DummyController.
 * WorkflowService itself enforces the finer-grained rules: template
 * management needs `workflow_template.manage.all`, and only a step's
 * actual resolved approver (or, once overdue, its escalation target) can
 * record a decision on it.
 */
@Controller("workflow")
@UseGuards(SessionGuard)
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService, private readonly inbox: InboxService) {}

  @Post("templates")
  createTemplate(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateWorkflowTemplateDto) {
    return this.workflow.createTemplate(claims, dto);
  }

  @Get("templates")
  listTemplates(@CurrentClaims() claims: RequestClaims) {
    return this.workflow.listTemplates(claims);
  }

  // BACKLOG56 - pickers for the template editor; same permission as editing templates. Declared before `templates/:key`.
  @Get("approver-options")
  approverOptions(@CurrentClaims() claims: RequestClaims) {
    return this.workflow.listApproverOptions(claims);
  }

  @Get("templates/:key/versions")
  listVersions(@CurrentClaims() claims: RequestClaims, @Param("key") key: string) {
    return this.workflow.listTemplateVersions(claims, key);
  }

  @Put("templates/:key")
  updateTemplate(@CurrentClaims() claims: RequestClaims, @Param("key") key: string, @Body() dto: UpdateWorkflowTemplateDto) {
    return this.workflow.updateTemplate(claims, key, dto);
  }

  @Post("templates/:key/active")
  setActive(@CurrentClaims() claims: RequestClaims, @Param("key") key: string, @Body() dto: SetTemplateActiveDto) {
    return this.workflow.setTemplateActive(claims, key, dto.isActive);
  }

  @Get("templates/:key")
  getTemplate(@CurrentClaims() claims: RequestClaims, @Param("key") key: string) {
    return this.workflow.getTemplateByKey(claims, key);
  }

  @Post("submissions")
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitForApprovalDto) {
    return this.workflow.submitForApproval(claims, dto);
  }

  @Get("submissions/:id")
  getInstance(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.workflow.getInstance(claims, id);
  }

  @Get("submissions")
  listForRecord(
    @CurrentClaims() claims: RequestClaims,
    @Query("objectKey") objectKey: string,
    @Query("recordId") recordId: string
  ) {
    return this.workflow.listInstancesForRecord(claims, objectKey, recordId);
  }

  @Post("steps/:stepInstanceId/decision")
  decide(
    @CurrentClaims() claims: RequestClaims,
    @Param("stepInstanceId") stepInstanceId: string,
    @Body() dto: ApprovalDecisionDto
  ) {
    // WFL-01: a step that belongs to a module-owned record is decided through that module
    // (or the engine's in-transaction outcome adapter) so the record is never left out of step.
    return this.inbox.decideStep(claims, stepInstanceId, dto);
  }

  @Post("submissions/:id/respond")
  respond(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: WorkflowCommentDto) {
    return this.workflow.respondToInfo(claims, id, dto.body);
  }

  @Post("submissions/:id/resubmit")
  resubmit(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ResubmitDto) {
    return this.workflow.resubmit(claims, id, dto);
  }

  @Post("submissions/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CancelWorkflowDto) {
    return this.workflow.cancel(claims, id, dto.reason);
  }
}
