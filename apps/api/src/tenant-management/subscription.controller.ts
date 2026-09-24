import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsIn, IsInt, Min } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { PackageTier } from "@aihxm/shared-types";
import { SubscriptionService } from "./subscription.service";

const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

class ChangePlanDto {
  @IsIn(PACKAGE_TIERS)
  toTier!: PackageTier;
}

class SetSeatsDto {
  @IsInt()
  @Min(0)
  seatsPurchased!: number;
}

// TM-025/026.
@Controller("platform/companies/:companyId/subscription")
@UseGuards(PlatformAdminGuard)
export class SubscriptionController {
  constructor(private readonly subscription: SubscriptionService) {}

  @Get()
  getSummary(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.subscription.getSummary(claims, companyId);
  }

  @Post("change-plan")
  changePlan(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Body() dto: ChangePlanDto
  ) {
    return this.subscription.changePlan(claims, companyId, dto.toTier);
  }

  @Post("seats")
  setSeats(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string, @Body() dto: SetSeatsDto) {
    return this.subscription.setSeats(claims, companyId, dto.seatsPurchased);
  }
}
