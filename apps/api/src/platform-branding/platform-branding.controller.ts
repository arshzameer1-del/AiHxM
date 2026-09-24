import {
  BadRequestException,
  Controller,
  Delete,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PlatformBrandingService } from "./platform-branding.service";

/**
 * Platform-Admin-only writes to the platform's own logo (migration
 * 0046_platform_branding.sql) — reads (including the image itself) go
 * through public-branding-style, no-auth routes instead, since a real
 * logo isn't sensitive and three different pages need it before or
 * without any session: see PublicPlatformBrandingController.
 */
@Controller("platform/branding")
@UseGuards(PlatformAdminGuard)
export class PlatformBrandingController {
  constructor(private readonly branding: PlatformBrandingService) {}

  @Post("logo")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadLogo(@CurrentClaims() claims: RequestClaims, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded");
    return this.branding.uploadLogo(claims, file);
  }

  @Delete("logo")
  removeLogo(@CurrentClaims() claims: RequestClaims) {
    return this.branding.removeLogo(claims);
  }
}
