import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { HeadcountService } from "./headcount.service";

class LineDto {
  @IsUUID() orgUnitId!: string;
  @IsInt() @Min(0) @Max(100000) plannedCount!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}
class PlanDto {
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(20) fiscalYear!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
}

@Controller("headcount-plans")
@UseGuards(SessionGuard)
export class HeadcountController {
  constructor(private readonly headcount: HeadcountService) {}
  @Get() list(@CurrentClaims() claims: RequestClaims) { return this.headcount.list(claims); }
  @Post() @HttpCode(200) create(@CurrentClaims() claims: RequestClaims, @Body() dto: PlanDto) { return this.headcount.create(claims, dto); }
  @Delete(":id") @HttpCode(204) async remove(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { await this.headcount.remove(claims, id); }
}
