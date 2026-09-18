import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { OffboardingService } from "./offboarding.service";
import { CreateChecklistItemTemplateDto, UpdateChecklistItemTemplateDto } from "./dto/checklist-item-template.dto";
import { UpdateChecklistItemDto } from "./dto/update-checklist-item.dto";
import { InitiateOffboardingDto } from "./dto/initiate-offboarding.dto";

@Controller()
@UseGuards(SessionGuard)
export class OffboardingController {
  constructor(private readonly offboarding: OffboardingService) {}

  @Post("offboarding/item-templates")
  createItemTemplate(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateChecklistItemTemplateDto) {
    return this.offboarding.createItemTemplate(claims, dto);
  }

  @Get("offboarding/item-templates")
  listItemTemplates(@CurrentClaims() claims: RequestClaims) {
    return this.offboarding.listItemTemplates(claims);
  }

  @Patch("offboarding/item-templates/:id")
  updateItemTemplate(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateChecklistItemTemplateDto
  ) {
    return this.offboarding.updateItemTemplate(claims, id, dto);
  }

  @Patch("offboarding/item-templates/:id/deactivate")
  deactivateItemTemplate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.offboarding.deactivateItemTemplate(claims, id);
  }

  @Get("offboarding")
  listInProgress(@CurrentClaims() claims: RequestClaims) {
    return this.offboarding.listInProgress(claims);
  }

  @Post("employees/:employeeId/offboarding")
  initiate(
    @CurrentClaims() claims: RequestClaims,
    @Param("employeeId") employeeId: string,
    @Body() dto: InitiateOffboardingDto
  ) {
    return this.offboarding.initiateOffboarding(claims, employeeId, dto);
  }

  @Get("employees/:employeeId/offboarding")
  getForEmployee(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.offboarding.getForEmployee(claims, employeeId);
  }

  @Patch("offboarding-items/:itemId")
  updateItem(@CurrentClaims() claims: RequestClaims, @Param("itemId") itemId: string, @Body() dto: UpdateChecklistItemDto) {
    return this.offboarding.updateItem(claims, itemId, dto);
  }

  @Post("employees/:employeeId/offboarding/complete")
  complete(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.offboarding.completeOffboarding(claims, employeeId);
  }
}
