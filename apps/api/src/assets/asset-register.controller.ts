import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import type { AssetCategory, AssetCondition, AssetDisposalMethod } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { AssetRegisterService } from "./asset-register.service";

const CATS = ["laptop", "desktop", "mobile", "tablet", "vehicle", "furniture", "access_card", "uniform", "tool", "other"];
const CONDS = ["new", "good", "fair", "poor", "damaged"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class AssetDto {
  @IsOptional() @IsString() @MaxLength(60) assetTag?: string;
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsIn(CATS) category?: AssetCategory;
  @IsOptional() @IsString() @MaxLength(120) serialNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(160) vendor?: string | null;
  @IsOptional() @Matches(DATE) purchaseDate?: string | null;
  @IsOptional() @IsNumber() purchaseCost?: number | null;
  @IsOptional() @Matches(DATE) warrantyUntil?: string | null;
  @IsOptional() @IsString() @MaxLength(160) location?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}
class AssignDto {
  @IsUUID() employeeId!: string;
  @IsOptional() @Matches(DATE) occurredOn?: string;
  @IsOptional() @IsIn(CONDS) condition?: AssetCondition;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class EventDto {
  @IsOptional() @Matches(DATE) occurredOn?: string;
  @IsOptional() @IsIn(CONDS) condition?: AssetCondition;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsNumber() cost?: number | null;
}
class RetireDto {
  @IsIn(["sold", "scrapped", "donated", "returned_to_vendor"]) disposalMethod!: AssetDisposalMethod;
  @IsOptional() @IsNumber() disposalValue?: number | null;
  @IsOptional() @Matches(DATE) occurredOn?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class VerifyDto {
  @IsArray() @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) ids!: string[];
}

@Controller("asset-register")
@UseGuards(SessionGuard)
export class AssetRegisterController {
  constructor(private readonly assets: AssetRegisterService) {}

  // fixed paths first, so ":id" never swallows them
  @Get("summary")
  summary(@CurrentClaims() claims: RequestClaims) {
    return this.assets.summary(claims);
  }

  @Get("mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.assets.mine(claims);
  }

  @Post("mine/:eventId/acknowledge")
  @HttpCode(204)
  acknowledge(@CurrentClaims() claims: RequestClaims, @Param("eventId", new ParseUUIDPipe()) eventId: string) {
    return this.assets.acknowledge(claims, eventId);
  }

  @Post("verify")
  verify(@CurrentClaims() claims: RequestClaims, @Body() dto: VerifyDto) {
    return this.assets.verify(claims, dto.ids);
  }

  @Get("held-by/:employeeId")
  heldBy(@CurrentClaims() claims: RequestClaims, @Param("employeeId", new ParseUUIDPipe()) employeeId: string) {
    return this.assets.heldBy(claims, employeeId);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string, @Query("category") category?: string, @Query("q") q?: string) {
    return this.assets.list(claims, { status, category, q });
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: AssetDto) {
    return this.assets.create(claims, dto as never);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.assets.get(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: AssetDto) {
    return this.assets.update(claims, id, dto);
  }

  @Post(":id/assign")
  assign(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: AssignDto) {
    return this.assets.assign(claims, id, dto);
  }

  @Post(":id/return")
  return(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: EventDto) {
    return this.assets.return(claims, id, dto);
  }

  @Post(":id/transfer")
  transfer(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: AssignDto) {
    return this.assets.transfer(claims, id, dto);
  }

  @Post(":id/maintenance/start")
  startMaintenance(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: EventDto) {
    return this.assets.startMaintenance(claims, id, dto);
  }

  @Post(":id/maintenance/complete")
  completeMaintenance(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: EventDto) {
    return this.assets.completeMaintenance(claims, id, dto);
  }

  @Post(":id/lost")
  lost(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: EventDto) {
    return this.assets.markLost(claims, id, dto);
  }

  @Post(":id/found")
  found(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: EventDto) {
    return this.assets.markFound(claims, id, dto);
  }

  @Post(":id/retire")
  retire(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: RetireDto) {
    return this.assets.retire(claims, id, dto);
  }
}
