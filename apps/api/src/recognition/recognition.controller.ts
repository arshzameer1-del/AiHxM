import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RecognitionService } from "./recognition.service";

class GiveDto {
  @IsUUID() toEmployeeId!: string;
  @IsString() @MaxLength(500) message!: string;
  @IsOptional() @IsString() @MaxLength(40) valueTag?: string | null;
}

@Controller("recognition")
@UseGuards(SessionGuard)
export class RecognitionController {
  constructor(private readonly recognition: RecognitionService) {}

  @Get()
  feed(@CurrentClaims() claims: RequestClaims) {
    return this.recognition.feed(claims);
  }

  @Get("colleagues")
  colleagues(@CurrentClaims() claims: RequestClaims, @Query("q") q: string) {
    return this.recognition.colleagues(claims, q);
  }

  @Get("can-moderate")
  async canModerate(@CurrentClaims() claims: RequestClaims) {
    return { canModerate: await this.recognition.canModerate(claims) };
  }

  @Post()
  @HttpCode(200)
  give(@CurrentClaims() claims: RequestClaims, @Body() dto: GiveDto) {
    return this.recognition.give(claims, dto);
  }

  @Post(":id/hide")
  @HttpCode(200)
  hide(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.recognition.hide(claims, id);
  }
}
