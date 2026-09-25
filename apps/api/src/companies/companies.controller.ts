import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import type { Response } from "express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CompaniesService } from "./companies.service";
import { CreateCompanyDto } from "./dto/create-company.dto";
import { UpdateCompanyDto } from "./dto/update-company.dto";
import { UpdateCompanyConfigDto } from "./dto/update-company-config.dto";
import { UpdateCompanyProfileDto } from "./dto/update-company-profile.dto";
import { CreateCompanyAdminDto } from "./dto/create-company-admin.dto";
import { UpdateCompanyAdminDto } from "./dto/update-company-admin.dto";
import { CreateLoginDto } from "../auth/dto/create-login.dto";
import { ResetAdminPasswordDto } from "./dto/reset-admin-password.dto";
import type { BrandingAssetSlot, CompanyStatus, PackageTier } from "@aihxm/shared-types";

const BRANDING_SLOTS: BrandingAssetSlot[] = ["logo", "favicon", "login-background"];

function parseBrandingSlot(value: string): BrandingAssetSlot {
  if (!BRANDING_SLOTS.includes(value as BrandingAssetSlot)) {
    throw new BadRequestException(`Unknown branding slot "${value}"`);
  }
  return value as BrandingAssetSlot;
}

function toStringArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : value.split(",");
  const cleaned = raw.map((v) => v.trim()).filter((v) => v.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

class RequestDeletionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  graceDays?: number;
}

// Tenant Management gap-fill Phase 1 item #4 — "Login As" now requires a
// reason, same as every other high-risk action here (Suspend/Lock via
// UpdateCompanyDto, deletion via RequestDeletionDto above).
class ImpersonateRequestDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

@Controller("platform/companies")
@UseGuards(PlatformAdminGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCompanyDto) {
    return this.companies.create(claims, dto);
  }

  // TM-002/TM-003 — Tenant Directory search + filters. Accepts either
  // repeated query keys (?status=active&status=trial, what a native
  // <select multiple> or most API clients send) or one comma-separated
  // value (?status=active,trial) — both are common enough on real
  // frontends that requiring one specific style would just push the
  // parsing into the client instead of removing it.
  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("search") search?: string,
    @Query("status") status?: string | string[],
    @Query("packageTier") packageTier?: string | string[],
    @Query("country") country?: string | string[]
  ) {
    return this.companies.list(claims, {
      search,
      status: toStringArray(status) as CompanyStatus[] | undefined,
      packageTier: toStringArray(packageTier) as PackageTier[] | undefined,
      country: toStringArray(country),
    });
  }

  @Get(":id")
  getDetail(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.getDetail(claims, id);
  }

  @Patch(":id")
  update(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompanyDto
  ) {
    return this.companies.updateCompany(claims, id, dto);
  }

  @Get(":id/modules")
  listModules(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.listModules(claims, id);
  }

  @Patch(":id/profile")
  updateProfile(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompanyProfileDto
  ) {
    return this.companies.updateProfile(claims, id, dto);
  }

  @Patch(":id/config")
  updateConfig(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompanyConfigDto
  ) {
    return this.companies.updateConfig(claims, id, dto);
  }

  // TM-015 — real file uploads for branding assets.
  @Post(":id/branding/:slot")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadBranding(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("slot") slot: string,
    @UploadedFile() file: Express.Multer.File
  ) {
    if (!file) throw new BadRequestException("No file was uploaded");
    return this.companies.uploadBrandingAsset(claims, id, parseBrandingSlot(slot), file);
  }

  @Get(":id/branding/:slot")
  async downloadBranding(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("slot") slot: string,
    @Res() res: Response
  ) {
    const { buffer, mimeType } = await this.companies.downloadBrandingAsset(claims, id, parseBrandingSlot(slot));
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", "inline");
    res.send(buffer);
  }

  @Post(":id/admins")
  addAdmin(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: CreateCompanyAdminDto
  ) {
    return this.companies.addAdmin(claims, id, dto);
  }

  @Patch(":id/admins/:adminId")
  setAdminStatus(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string,
    @Body() dto: UpdateCompanyAdminDto
  ) {
    return this.companies.setAdminStatus(claims, id, adminId, dto.status);
  }

  @Post(":id/admins/:adminId/account")
  createAdminLogin(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string,
    @Body() dto: CreateLoginDto
  ) {
    return this.companies.createAdminLogin(claims, id, adminId, dto.initialPassword, dto.loginId);
  }

  @Post(":id/admins/:adminId/account/reset-password")
  resetAdminPassword(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string,
    @Body() dto: ResetAdminPasswordDto
  ) {
    return this.companies.resetAdminPassword(claims, id, adminId, dto.newPassword);
  }

  // Tenant Management gap-fill batch 1, Phase 1 item #2 — the MFA
  // counterpart to reset-password above, for an admin who's lost their
  // authenticator device AND their recovery codes. No request body: this
  // always forces a fresh enrollment, there's nothing else to configure.
  @Post(":id/admins/:adminId/account/reset-mfa")
  resetAdminMfa(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string
  ) {
    return this.companies.resetAdminMfa(claims, id, adminId);
  }

  // Tenant Management gap-fill batch 1, Phase 1 item #3 — clears the
  // automatic password-lockout counters without touching the password or
  // MFA enrollment. No request body: nothing to configure.
  @Post(":id/admins/:adminId/account/unlock")
  unlockAdminAccount(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string
  ) {
    return this.companies.unlockAdminAccount(claims, id, adminId);
  }

  // Tenant Management gap-fill Phase 1 item #8 — the "Revoke" half of
  // login/invitation lifecycle visibility. No body: nothing to configure.
  @Post(":id/admins/:adminId/account/revoke")
  revokeAdminLogin(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string
  ) {
    return this.companies.revokeAdminLogin(claims, id, adminId);
  }

  // Tenant Management gap-fill Phase 1 item #7 — periodic access-review
  // attestation. No body: nothing to configure, just a timestamp + who.
  @Post(":id/admins/:adminId/access-review")
  markAdminAccessReviewed(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string
  ) {
    return this.companies.markAdminAccessReviewed(claims, id, adminId);
  }

  @Post(":id/impersonate")
  impersonate(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: ImpersonateRequestDto
  ) {
    return this.companies.impersonate(claims, id, dto.reason);
  }

  // --- Lifecycle: TM-005 Suspend / TM-030 Tenant Lock go through the
  // existing PATCH :id above (status + required reason). These two are
  // the Danger Zone / TM-038 deletion workflow specifically.

  // Tenant Management gap-fill Phase 1 item #5 — read-only, so the
  // Danger Zone can show what a deletion would affect BEFORE a Platform
  // Admin ever types a reason. No body, no side effects.
  @Get(":id/deletion-impact")
  getDeletionImpact(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.getDeletionImpact(claims, id);
  }

  @Post(":id/deletion-request")
  requestDeletion(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: RequestDeletionDto
  ) {
    return this.companies.requestDeletion(claims, id, dto);
  }

  @Delete(":id/deletion-request")
  cancelDeletion(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.cancelDeletion(claims, id);
  }

  // Phase 1 item #5 — the second-approver action. No body: everything
  // needed (the grace period) was already stashed at request time.
  @Post(":id/deletion-request/approve")
  approveDeletion(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.approveDeletion(claims, id);
  }
}
