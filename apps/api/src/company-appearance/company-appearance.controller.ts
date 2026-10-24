import { Body, Controller, Delete, Get, Put, Post, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from "class-validator";
import { HOME_BANNER_PRESETS, type HomeBannerMode, type HomeBannerPresetKey } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CompanyAppearanceService, MAX_BANNER_BYTES } from "./company-appearance.service";

class UpdateAppearanceDto {
  @IsOptional() @IsIn(["default", "preset", "color", "image"]) bannerMode?: HomeBannerMode;
  @IsOptional() @IsIn(HOME_BANNER_PRESETS.map((p) => p.key)) bannerPreset?: HomeBannerPresetKey | null;
  @IsOptional() @IsString() @Matches(/^#[0-9a-fA-F]{6}$/) bannerColor?: string | null;
  @IsOptional() @IsBoolean() photoNeedsHrApproval?: boolean;
}

/** BACKLOG55 - company appearance. Reading is open to the whole company; changing needs company_appearance.manage. */
@Controller("company/appearance")
@UseGuards(SessionGuard)
export class CompanyAppearanceController {
  constructor(private readonly appearance: CompanyAppearanceService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims) {
    return this.appearance.get(claims);
  }

  @Put()
  update(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdateAppearanceDto) {
    return this.appearance.update(claims, dto);
  }

  @Post("banner-image")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BANNER_BYTES + 1024 } }))
  upload(@CurrentClaims() claims: RequestClaims, @UploadedFile() file: Express.Multer.File) {
    return this.appearance.uploadBannerImage(claims, file);
  }

  @Delete("banner-image")
  remove(@CurrentClaims() claims: RequestClaims) {
    return this.appearance.removeBannerImage(claims);
  }

  @Get("banner-image")
  async image(@CurrentClaims() claims: RequestClaims, @Res() res: Response) {
    const { buffer, mimeType } = await this.appearance.bannerImage(claims);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buffer);
  }
}
