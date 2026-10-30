import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EsignService } from "./esign.service";

class CreateDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(20000) body!: string;
  @IsArray() @ArrayMaxSize(1000) @IsUUID("all", { each: true }) employeeIds!: string[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueOn?: string | null;
}
class SignDto {
  @IsString() @MaxLength(200) name!: string;
}
class DeclineDto {
  @IsString() @MaxLength(500) reason!: string;
}

@Controller("esign")
@UseGuards(SessionGuard)
export class EsignController {
  constructor(private readonly esign: EsignService) {}
  @Get("mine") mine(@CurrentClaims() claims: RequestClaims) { return this.esign.mine(claims); }
  @Get("mine/count") count(@CurrentClaims() claims: RequestClaims) { return this.esign.count(claims); }
  @Post(":id/sign") @HttpCode(200) sign(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: SignDto) { return this.esign.sign(claims, id, dto.name); }
  @Post(":id/decline") @HttpCode(200) decline(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: DeclineDto) { return this.esign.decline(claims, id, dto.reason); }
  @Get() list(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string) { return this.esign.list(claims, status); }
  @Post() @HttpCode(200) create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateDto) { return this.esign.create(claims, dto); }
  @Post(":id/cancel") @HttpCode(200) cancel(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.esign.cancel(claims, id); }
  @Get(":id/verify") verify(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.esign.verify(claims, id); }
}
