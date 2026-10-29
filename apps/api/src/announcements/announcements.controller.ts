import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import type { AnnouncementAudienceType, AnnouncementPriority } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { AnnouncementsService } from "./announcements.service";

class SaveAnnouncementDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(10000) body!: string;
  @IsOptional() @IsIn(["normal", "important", "urgent"]) priority?: AnnouncementPriority;
  @IsOptional() @IsIn(["all", "org_unit", "location"]) audienceType?: AnnouncementAudienceType;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID("all", { each: true }) audienceIds?: string[];
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() requireAck?: boolean;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) expiresOn?: string | null;
  @IsOptional() @IsBoolean() sendEmail?: boolean;
  @IsOptional() @IsBoolean() sendSms?: boolean;
  @IsOptional() @IsBoolean() sendWhatsapp?: boolean;
  @IsOptional() @IsBoolean() publish?: boolean;
}

/** Company announcements: the notice board every employee reads, and HR's tools to write it. */
@Controller("announcements")
@UseGuards(SessionGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get("mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.announcements.mine(claims);
  }

  @Get("mine/summary")
  summary(@CurrentClaims() claims: RequestClaims) {
    return this.announcements.summary(claims);
  }

  @Post(":id/read")
  async read(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.announcements.markRead(claims, id);
    return { ok: true };
  }

  @Post(":id/acknowledge")
  async acknowledge(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.announcements.acknowledge(claims, id);
    return { ok: true };
  }

  @Get("channels")
  channels() {
    return this.announcements.channels();
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.announcements.listAdmin(claims);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: SaveAnnouncementDto) {
    return this.announcements.create(claims, dto);
  }

  @Put(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SaveAnnouncementDto) {
    return this.announcements.update(claims, id, dto);
  }

  @Post(":id/publish")
  publish(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.announcements.publish(claims, id);
  }

  @Post(":id/archive")
  archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.announcements.archive(claims, id);
  }

  @Get(":id/receipts")
  receipts(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.announcements.receipts(claims, id);
  }
}
