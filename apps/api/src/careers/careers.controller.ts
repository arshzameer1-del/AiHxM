import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import type { CareersEmploymentType } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CareersService, type ApplyInput } from "./careers.service";

class SaveCareersDto {
  @IsBoolean() publish!: boolean;
  @IsOptional() @IsString() @MaxLength(8000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(200) location?: string | null;
  @IsOptional() @IsIn(["full_time", "part_time", "contract", "internship"]) employmentType?: CareersEmploymentType | null;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) closesOn?: string | null;
}

class ParseResumeDto {
  @IsString() @MaxLength(60000) text!: string;
}

/** HR: which approved requisitions are on the careers page. */
@Controller("recruitment/careers")
@UseGuards(SessionGuard)
export class CareersAdminController {
  constructor(private readonly careers: CareersService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.careers.listForRequisitions(claims);
  }

  @Post("parse-resume")
  parseResume(@CurrentClaims() claims: RequestClaims, @Body() dto: ParseResumeDto) {
    return this.careers.parseResume(claims, dto.text);
  }

  @Put(":requisitionId")
  save(@CurrentClaims() claims: RequestClaims, @Param("requisitionId", new ParseUUIDPipe()) id: string, @Body() dto: SaveCareersDto) {
    return this.careers.save(claims, id, dto);
  }
}

/**
 * Public: no session, by design. Every route is rate-limited per address; the application form has a honeypot, a size
 * limit and a file-content check.
 */
@Controller("public/careers")
export class PublicCareersController {
  constructor(private readonly careers: CareersService) {}

  @Get(":slug")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  page(@Param("slug") slug: string) {
    return this.careers.page(slug);
  }

  @Get(":slug/feed.xml")
  @Header("Content-Type", "application/xml; charset=utf-8")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  feed(@Param("slug") slug: string, @Req() req: { protocol: string; get(h: string): string | undefined }) {
    return this.careers.feedXml(slug, `${req.protocol}://${req.get("host") ?? ""}/careers`);
  }

  @Get(":slug/jobs/:jobId")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  job(@Param("slug") slug: string, @Param("jobId", new ParseUUIDPipe()) jobId: string) {
    return this.careers.job(slug, jobId);
  }

  @Post(":slug/jobs/:jobId/apply")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor("resume", { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  apply(
    @Param("slug") slug: string,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Body() body: ApplyInput,
    @UploadedFile() file: Express.Multer.File | undefined
  ) {
    return this.careers.apply(slug, jobId, body ?? {}, file);
  }
}
