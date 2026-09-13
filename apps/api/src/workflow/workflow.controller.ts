import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { WorkflowService } from "./workflow.service";
import { CreateWorkflowTemplateDto } from "./dto/create-workflow-template.dto";
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
  constructor(private readonly workflow: WorkflowService) {}

  @Post("templates")
  createTemplate(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateWorkflowTemplateDto) {
    return this.workflow.createTemplate(claims, dto);
  }

  @Get("templates")
  listTemplates(@CurrentClaims() claims: RequestClaims) {
    return this.workflow.listTemplates(claims);
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
    return this.workflow.decide(claims, stepInstanceId, dto);
  }
}
