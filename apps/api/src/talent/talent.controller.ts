import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import type { SuccessionReadiness, TalentBand } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { TalentService } from "./talent.service";

class SkillDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class RequirementDto {
  @IsUUID() jobId!: string;
  @IsUUID() skillId!: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) requiredLevel?: number | null;
}
class LevelDto {
  @IsInt() @Min(1) @Max(5) level!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}
class AssessDto {
  @IsUUID() employeeId!: string;
  @IsIn(["low", "medium", "high"]) potential!: TalentBand;
  @IsOptional() @IsIn(["low", "medium", "high"]) performanceBand?: TalentBand | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class CandidateDto {
  @IsUUID() employeeId!: string;
  @IsIn(["ready_now", "one_to_two_years", "three_plus_years"]) readiness!: SuccessionReadiness;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}
class PoolDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
}

@Controller("talent")
@UseGuards(SessionGuard)
export class TalentController {
  constructor(private readonly talent: TalentService) {}

  @Get("skills") skills(@CurrentClaims() claims: RequestClaims, @Query("all") all?: string) { return this.talent.listSkills(claims, all === "true"); }
  @Post("skills") @HttpCode(200) saveSkill(@CurrentClaims() claims: RequestClaims, @Body() dto: SkillDto) { return this.talent.saveSkill(claims, dto); }
  @Get("skills/requirements") requirements(@CurrentClaims() claims: RequestClaims) { return this.talent.listRequirements(claims); }
  @Post("skills/requirements") @HttpCode(200) setRequirement(@CurrentClaims() claims: RequestClaims, @Body() dto: RequirementDto) { return this.talent.setRequirement(claims, dto.jobId, dto.skillId, dto.requiredLevel ?? null); }
  @Get("skills/mine") mine(@CurrentClaims() claims: RequestClaims) { return this.talent.mySkills(claims); }
  @Put("skills/mine/:skillId") setMine(@CurrentClaims() claims: RequestClaims, @Param("skillId", ParseUUIDPipe) skillId: string, @Body() dto: LevelDto) { return this.talent.setMySkill(claims, skillId, dto.level); }
  @Put("skills/employee/:employeeId/:skillId") setFor(@CurrentClaims() claims: RequestClaims, @Param("employeeId", ParseUUIDPipe) e: string, @Param("skillId", ParseUUIDPipe) s: string, @Body() dto: LevelDto) { return this.talent.setEmployeeSkill(claims, e, s, dto.level, dto.note); }
  @Get("skills/gaps/:jobId") gaps(@CurrentClaims() claims: RequestClaims, @Param("jobId", ParseUUIDPipe) jobId: string) { return this.talent.gaps(claims, jobId); }

  @Get("nine-box") nineBox(@CurrentClaims() claims: RequestClaims) { return this.talent.nineBox(claims); }
  @Post("nine-box") @HttpCode(200) assess(@CurrentClaims() claims: RequestClaims, @Body() dto: AssessDto) { return this.talent.saveAssessment(claims, dto); }
  @Delete("nine-box/:employeeId") remove(@CurrentClaims() claims: RequestClaims, @Param("employeeId", ParseUUIDPipe) id: string) { return this.talent.removeAssessment(claims, id); }

  @Get("succession") succession(@CurrentClaims() claims: RequestClaims) { return this.talent.succession(claims); }
  @Put("succession/:positionId") addCandidate(@CurrentClaims() claims: RequestClaims, @Param("positionId", ParseUUIDPipe) p: string, @Body() dto: CandidateDto) { return this.talent.addCandidate(claims, p, dto.employeeId, dto.readiness, dto.note); }
  @Delete("succession/:positionId/:employeeId") removeCandidate(@CurrentClaims() claims: RequestClaims, @Param("positionId", ParseUUIDPipe) p: string, @Param("employeeId", ParseUUIDPipe) e: string) { return this.talent.removeCandidate(claims, p, e); }

  @Get("pools") pools(@CurrentClaims() claims: RequestClaims) { return this.talent.pools(claims); }
  @Post("pools") @HttpCode(200) createPool(@CurrentClaims() claims: RequestClaims, @Body() dto: PoolDto) { return this.talent.createPool(claims, dto.name, dto.description); }
  @Delete("pools/:id") deletePool(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.talent.deletePool(claims, id); }
  @Put("pools/:id/members/:employeeId") addMember(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) e: string) { return this.talent.setPoolMember(claims, id, e, true); }
  @Delete("pools/:id/members/:employeeId") removeMember(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) e: string) { return this.talent.setPoolMember(claims, id, e, false); }
}
