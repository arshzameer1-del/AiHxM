import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { IsString, MaxLength } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { SmartChecksService } from "./smart-checks.service";

class DismissDto {
  @IsString() @MaxLength(80) ruleKey!: string;
  @IsString() @MaxLength(200) subjectKey!: string;
  @IsString() @MaxLength(500) reason!: string;
}

/** Rule-based scans of HR and payroll data. Permission is decided in the service. */
@Controller("smart-checks")
@UseGuards(SessionGuard)
export class SmartChecksController {
  constructor(private readonly checks: SmartChecksService) {}

  @Get()
  run(@CurrentClaims() claims: RequestClaims) {
    return this.checks.run(claims);
  }

  @Get("dismissed")
  dismissed(@CurrentClaims() claims: RequestClaims) {
    return this.checks.listDismissed(claims);
  }

  @Post("dismiss")
  @HttpCode(200)
  dismiss(@CurrentClaims() claims: RequestClaims, @Body() dto: DismissDto) {
    return this.checks.dismiss(claims, dto);
  }

  @Delete("dismissed/:id")
  @HttpCode(204)
  restore(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.checks.restore(claims, id);
  }
}
