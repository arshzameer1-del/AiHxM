import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import type { LevyKind } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ComplianceService } from "./compliance.service";

class MinimumWageDto {
  @IsString() @MaxLength(80) province!: string;
  @IsNumber() monthlyAmount!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) effectiveFrom!: string;
  @IsOptional() @IsString() @MaxLength(500) sourceNote?: string | null;
}

class LevyDto {
  @IsIn(["wwf", "wppf"]) kind!: LevyKind;
  @IsString() @MaxLength(20) fiscalYear!: string;
  @IsString() @MaxLength(120) baseLabel!: string;
  @IsNumber() baseAmount!: number;
  @IsNumber() ratePercent!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}

/** Minimum-wage table, WWF / WPPF worksheets and the annual salary statement. Permissions are decided in the service. */
@Controller("compliance")
@UseGuards(SessionGuard)
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get("minimum-wages")
  minimumWages(@CurrentClaims() claims: RequestClaims) {
    return this.compliance.listMinimumWages(claims);
  }

  @Post("minimum-wages")
  addMinimumWage(@CurrentClaims() claims: RequestClaims, @Body() dto: MinimumWageDto) {
    return this.compliance.saveMinimumWage(claims, dto);
  }

  @Delete("minimum-wages/:id")
  removeMinimumWage(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.compliance.deleteMinimumWage(claims, id);
  }

  @Get("levies")
  levies(@CurrentClaims() claims: RequestClaims) {
    return this.compliance.listLevies(claims);
  }

  @Post("levies")
  createLevy(@CurrentClaims() claims: RequestClaims, @Body() dto: LevyDto) {
    return this.compliance.createLevy(claims, dto);
  }

  @Post("levies/:id/finalize")
  @HttpCode(200)
  finalizeLevy(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.compliance.finalizeLevy(claims, id);
  }

  @Delete("levies/:id")
  @HttpCode(204)
  async deleteLevy(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    await this.compliance.deleteLevy(claims, id);
  }

  @Get("annual-salary-statement")
  annual(@CurrentClaims() claims: RequestClaims, @Query("year") year: string) {
    return this.compliance.annualSalaryStatement(claims, Number(year));
  }

  @Get("annual-salary-statement/csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  annualCsv(@CurrentClaims() claims: RequestClaims, @Query("year") year: string) {
    return this.compliance.annualSalaryStatementCsv(claims, Number(year));
  }
}
