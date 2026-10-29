import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { IsBoolean, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import type { GeofenceMode, SelfieMode } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { AttendancePolicyService } from "./attendance-policy.service";

class UpdatePolicyDto {
  @IsOptional() @IsIn(["off", "flag", "block"]) geofenceMode?: GeofenceMode;
  @IsOptional() @IsIn(["off", "optional", "required"]) selfieMode?: SelfieMode;
  @IsOptional() @IsBoolean() blockSuspectLocation?: boolean;
  @IsOptional() @IsInt() maxGpsAccuracyM?: number | null;
  @IsOptional() @IsInt() maxTravelSpeedKmh?: number;
}
class GeofenceDto {
  @IsString() @MaxLength(120) name!: string;
  @IsNumber() @IsLatitude() latitude!: number;
  @IsNumber() @IsLongitude() longitude!: number;
  @IsInt() @Min(20) @Max(50000) radiusM!: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Location checks, selfies and the HR review list. The service decides who may do what. */
@Controller("attendance-policy")
@UseGuards(SessionGuard)
export class AttendancePolicyController {
  constructor(private readonly policy: AttendancePolicyService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims) {
    return this.policy.getPolicy(claims);
  }

  @Put()
  update(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdatePolicyDto) {
    return this.policy.updatePolicy(claims, dto);
  }

  @Get("clock")
  clock(@CurrentClaims() claims: RequestClaims) {
    return this.policy.getClockPolicy(claims);
  }

  @Post("geofences")
  createGeofence(@CurrentClaims() claims: RequestClaims, @Body() dto: GeofenceDto) {
    return this.policy.saveGeofence(claims, null, dto);
  }

  @Put("geofences/:id")
  updateGeofence(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: GeofenceDto) {
    return this.policy.saveGeofence(claims, id, dto);
  }

  @Delete("geofences/:id")
  @HttpCode(204)
  deleteGeofence(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.policy.deleteGeofence(claims, id);
  }

  @Get("exceptions")
  exceptions(@CurrentClaims() claims: RequestClaims, @Query("from") from: string, @Query("to") to: string) {
    return this.policy.listExceptions(claims, from, to);
  }

  @Get("selfies/:recordId")
  async selfie(@CurrentClaims() claims: RequestClaims, @Param("recordId", new ParseUUIDPipe()) recordId: string, @Res() res: Response) {
    const { buffer, mimeType } = await this.policy.readSelfie(claims, recordId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buffer);
  }
}
