import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsNumber, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { KeyResultsService } from "./key-results.service";

class CreateKeyResultDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsNumber() startValue?: number;
  @IsNumber() targetValue!: number;
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @IsOptional() @IsNumber() weight?: number;
}
class UpdateKeyResultDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsNumber() startValue?: number;
  @IsOptional() @IsNumber() targetValue?: number;
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @IsOptional() @IsNumber() weight?: number;
}
class CheckInDto {
  @IsNumber() currentValue!: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
}
class AlignmentQuery {
  @IsUUID() reviewCycleId!: string;
}

/** OKR key results and the goal alignment tree. Authorisation lives in the service. */
@Controller()
@UseGuards(SessionGuard)
export class KeyResultsController {
  constructor(private readonly keyResults: KeyResultsService) {}

  @Get("goal-alignment")
  alignment(@CurrentClaims() claims: RequestClaims, @Query() q: AlignmentQuery) {
    return this.keyResults.alignment(claims, q.reviewCycleId);
  }

  @Get("goals/:id/key-results")
  list(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.keyResults.list(claims, id);
  }

  @Post("goals/:id/key-results")
  create(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: CreateKeyResultDto) {
    return this.keyResults.create(claims, id, dto);
  }

  @Patch("key-results/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: UpdateKeyResultDto) {
    return this.keyResults.update(claims, id, dto);
  }

  @Post("key-results/:id/check-in")
  @HttpCode(200)
  checkIn(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: CheckInDto) {
    return this.keyResults.checkIn(claims, id, dto);
  }

  @Delete("key-results/:id")
  remove(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.keyResults.remove(claims, id);
  }
}
