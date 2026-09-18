import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { OnboardingService } from "./onboarding.service";
import { CreateChecklistItemTemplateDto, UpdateChecklistItemTemplateDto } from "./dto/checklist-item-template.dto";
import { UpdateChecklistItemDto } from "./dto/update-checklist-item.dto";

/**
 * Any real session can call these (SessionGuard) — OnboardingService's
 * own entitlement + RBAC checks decide who succeeds, the same split
 * every module since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post("onboarding/item-templates")
  createItemTemplate(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateChecklistItemTemplateDto) {
    return this.onboarding.createItemTemplate(claims, dto);
  }

  @Get("onboarding/item-templates")
  listItemTemplates(@CurrentClaims() claims: RequestClaims) {
    return this.onboarding.listItemTemplates(claims);
  }

  @Patch("onboarding/item-templates/:id")
  updateItemTemplate(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateChecklistItemTemplateDto
  ) {
    return this.onboarding.updateItemTemplate(claims, id, dto);
  }

  @Patch("onboarding/item-templates/:id/deactivate")
  deactivateItemTemplate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.onboarding.deactivateItemTemplate(claims, id);
  }

  @Get("onboarding")
  listInProgress(@CurrentClaims() claims: RequestClaims) {
    return this.onboarding.listInProgress(claims);
  }

  @Post("employees/:employeeId/onboarding")
  initiate(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.onboarding.initiateOnboarding(claims, employeeId);
  }

  @Get("employees/:employeeId/onboarding")
  getForEmployee(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.onboarding.getForEmployee(claims, employeeId);
  }

  @Patch("onboarding-items/:itemId")
  updateItem(@CurrentClaims() claims: RequestClaims, @Param("itemId") itemId: string, @Body() dto: UpdateChecklistItemDto) {
    return this.onboarding.updateItem(claims, itemId, dto);
  }
}
