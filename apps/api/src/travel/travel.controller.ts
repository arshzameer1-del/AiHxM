import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { FormSettingsService } from "../form-settings/form-settings.service";
import { TravelService } from "./travel.service";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class RateDto {
  @IsString() @MaxLength(80) name!: string;
  @IsIn(["per_diem", "mileage"]) rateKind!: "per_diem" | "mileage";
  @IsIn(["domestic", "international"]) tripType!: "domestic" | "international";
  @IsNumber() amount!: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class SubmitDto {
  @IsUUID() employeeId!: string;
  @IsString() @MaxLength(160) destination!: string;
  @IsString() @MaxLength(1000) purpose!: string;
  @IsOptional() @IsIn(["domestic", "international"]) tripType?: "domestic" | "international";
  @IsOptional() @IsIn(["air", "car", "bus", "train", "other"]) travelMode?: "air" | "car" | "bus" | "train" | "other";
  @Matches(DATE) startDate!: string;
  @Matches(DATE) endDate!: string;
  @IsOptional() @IsNumber() estDistanceKm?: number | null;
  @IsOptional() @IsNumber() estOtherCost?: number | null;
  @IsOptional() @IsNumber() advanceRequested?: number | null;
}
class DecideDto {
  @IsIn(["approved", "rejected"]) decision!: "approved" | "rejected";
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}
class AdvanceDto {
  @IsNumber() amount!: number;
}
class SettleDto {
  @IsInt() @Min(1) @Max(90) actualDays!: number;
  @IsOptional() @IsNumber() actualKm?: number | null;
  @IsOptional() @IsNumber() otherCost?: number | null;
  @IsOptional() @IsString() @MaxLength(500) otherCostNote?: string | null;
}

@Controller("travel")
@UseGuards(SessionGuard)
export class TravelController {
  constructor(private readonly travel: TravelService, private readonly formSettings: FormSettingsService) {}

  @Get("rates")
  rates(@CurrentClaims() claims: RequestClaims) {
    return this.travel.listRates(claims);
  }

  @Post("rates")
  createRate(@CurrentClaims() claims: RequestClaims, @Body() dto: RateDto) {
    return this.travel.saveRate(claims, null, dto);
  }

  @Put("rates/:id")
  updateRate(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: RateDto) {
    return this.travel.saveRate(claims, id, dto);
  }

  @Post("requests")
  async submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitDto) {
    await this.formSettings.enforce(claims, "travel_request", dto as unknown as Record<string, unknown>);
    return this.travel.submit(claims, dto);
  }

  @Get("requests/mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.travel.listMine(claims);
  }

  @Get("requests/pending")
  pending(@CurrentClaims() claims: RequestClaims) {
    return this.travel.listPending(claims);
  }

  @Get("requests")
  all(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string) {
    return this.travel.listAll(claims, status);
  }

  @Post("requests/:id/decide")
  decide(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: DecideDto) {
    return this.travel.decide(claims, id, dto);
  }

  @Post("requests/:id/cancel")
  @HttpCode(200)
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.travel.cancel(claims, id);
  }

  @Post("requests/:id/advance")
  advance(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: AdvanceDto) {
    return this.travel.issueAdvance(claims, id, dto);
  }

  @Post("requests/:id/settlement-preview")
  @HttpCode(200)
  preview(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: SettleDto) {
    return this.travel.previewSettlement(claims, id, dto);
  }

  @Post("requests/:id/settle")
  settle(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: SettleDto) {
    return this.travel.settle(claims, id, dto);
  }
}
