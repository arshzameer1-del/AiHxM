import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { IsInt, Min } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { UsageService } from "./usage.service";

class SetStorageQuotaDto {
  @IsInt()
  @Min(0)
  storageQuotaMb!: number;
}

// TM-027/028.
@Controller("platform/companies/:companyId")
@UseGuards(PlatformAdminGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get("usage")
  getSummary(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.usage.getSummary(claims, companyId);
  }

  @Patch("storage/quota")
  setStorageQuota(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Body() dto: SetStorageQuotaDto
  ) {
    return this.usage.setStorageQuota(claims, companyId, dto.storageQuotaMb);
  }
}
