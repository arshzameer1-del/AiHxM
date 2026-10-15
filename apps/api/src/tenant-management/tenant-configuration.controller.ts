import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { TenantConfigurationService } from "./tenant-configuration.service";

class SetOverrideDto {
  @IsNotEmpty()
  value!: unknown;
}

class ScheduleDto {
  @IsNotEmpty()
  value!: unknown;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

class CancelDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

class RollbackDto {
  @IsString()
  versionId!: string;
}

// TM-018/019/020. Mounted under /platform/companies/:id to match this
// codebase's existing company-scoped route style (the spec's own routes
// use a /platform/tenants/:id shape that doesn't otherwise exist here —
// "tenant" and "company" are the same row, see companies.controller.ts).
@Controller("platform/companies/:companyId/configuration")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class TenantConfigurationController {
  constructor(private readonly config: TenantConfigurationService) {}

  @Get()
  getEffective(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.config.getEffective(claims, companyId);
  }

  @Get("scheduled")
  listScheduled(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.config.listScheduled(claims, companyId);
  }

  @Post("scheduled/apply-due")
  async applyDue(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return { applied: await this.config.applyDue(claims, companyId) };
  }

  @Post("scheduled/:versionId/cancel")
  cancelScheduled(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string, @Param("versionId") versionId: string, @Body() dto: CancelDto) {
    return this.config.cancelScheduled(claims, companyId, versionId, dto.reason);
  }

  @Get(":category/:settingKey/as-of/:asOf")
  resolveAsOf(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("category") category: string,
    @Param("settingKey") settingKey: string,
    @Param("asOf") asOf: string
  ) {
    return this.config.resolveAsOf(claims, companyId, category, settingKey, asOf);
  }

  @Post(":category/:settingKey/schedule")
  schedule(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("category") category: string,
    @Param("settingKey") settingKey: string,
    @Body() dto: ScheduleDto
  ) {
    return this.config.scheduleChange(claims, companyId, category, settingKey, dto.value, dto.effectiveFrom, dto.reason);
  }

  @Post(":category/:settingKey")
  setOverride(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("category") category: string,
    @Param("settingKey") settingKey: string,
    @Body() dto: SetOverrideDto
  ) {
    return this.config.setOverride(claims, companyId, category, settingKey, dto.value);
  }

  @Post(":category/:settingKey/reset")
  async resetToDefault(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("category") category: string,
    @Param("settingKey") settingKey: string
  ) {
    await this.config.resetToDefault(claims, companyId, category, settingKey);
    return { message: "Reset to default." };
  }

  @Get(":category/:settingKey/history")
  getHistory(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("category") category: string,
    @Param("settingKey") settingKey: string
  ) {
    return this.config.getHistory(claims, companyId, category, settingKey);
  }

  @Post("rollback")
  rollback(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string, @Body() dto: RollbackDto) {
    return this.config.rollback(claims, companyId, dto.versionId);
  }
}
