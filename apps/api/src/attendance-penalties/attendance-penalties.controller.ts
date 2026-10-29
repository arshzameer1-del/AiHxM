import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import type { AttendancePenaltyTrigger, AttendancePenaltyType } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { AttendancePenaltiesService } from "./attendance-penalties.service";

class RuleDto {
  @IsString() @MaxLength(120) name!: string;
  @IsIn(["late", "early_leave"]) triggerKind!: AttendancePenaltyTrigger;
  @IsInt() minMinutes!: number;
  @IsInt() everyN!: number;
  @IsIn(["leave_deduction", "salary_deduction"]) penaltyType!: AttendancePenaltyType;
  @IsOptional() @IsString() @MaxLength(40) leaveType?: string | null;
  @IsOptional() @IsNumber() penaltyDays?: number | null;
  @IsOptional() @IsNumber() penaltyAmount?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class ApplyDto {
  @IsUUID() ruleId!: string;
  @IsUUID() employeeId!: string;
  @Matches(/^\d{4}-\d{2}$/) month!: string;
}

@Controller("attendance-penalties")
@UseGuards(SessionGuard)
export class AttendancePenaltiesController {
  constructor(private readonly penalties: AttendancePenaltiesService) {}

  @Get("rules")
  rules(@CurrentClaims() claims: RequestClaims) {
    return this.penalties.listRules(claims);
  }

  @Post("rules")
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: RuleDto) {
    return this.penalties.saveRule(claims, null, dto);
  }

  @Put("rules/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: RuleDto) {
    return this.penalties.saveRule(claims, id, dto);
  }

  @Delete("rules/:id")
  @HttpCode(204)
  remove(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.penalties.deleteRule(claims, id);
  }

  @Get("preview")
  preview(@CurrentClaims() claims: RequestClaims, @Query("month") month: string) {
    return this.penalties.preview(claims, month);
  }

  @Post("apply")
  apply(@CurrentClaims() claims: RequestClaims, @Body() dto: ApplyDto) {
    return this.penalties.apply(claims, dto);
  }

  @Post(":id/reverse")
  @HttpCode(204)
  reverse(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.penalties.reverse(claims, id);
  }
}
