import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import type { AnnouncementAudienceType, SurveyQuestionKind } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { SurveysService } from "./surveys.service";

class SurveyQuestionDto {
  @IsIn(["rating", "nps", "yes_no", "text"]) kind!: SurveyQuestionKind;
  @IsString() @MaxLength(500) prompt!: string;
  @IsOptional() @IsBoolean() required?: boolean;
}

class SaveSurveyDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsIn(["all", "org_unit", "location"]) audienceType?: AnnouncementAudienceType;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID("all", { each: true }) audienceIds?: string[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) closesOn?: string | null;
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => SurveyQuestionDto) questions!: SurveyQuestionDto[];
  @IsOptional() @IsBoolean() open?: boolean;
}

class AnswerDto {
  @IsUUID() questionId!: string;
  @IsOptional() value?: number | boolean;
  @IsOptional() @IsString() @MaxLength(2000) text?: string;
}

class SubmitSurveyDto {
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[];
}

/** Anonymous pulse surveys: HR builds and reads totals, everyone else answers once. */
@Controller("surveys")
@UseGuards(SessionGuard)
export class SurveysController {
  constructor(private readonly surveys: SurveysService) {}

  @Get("mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.surveys.mine(claims);
  }

  @Get("mine/count")
  count(@CurrentClaims() claims: RequestClaims) {
    return this.surveys.count(claims);
  }

  @Post(":id/respond")
  @HttpCode(200)
  respond(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SubmitSurveyDto) {
    return this.surveys.respond(claims, id, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.surveys.listAdmin(claims);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: SaveSurveyDto) {
    return this.surveys.create(claims, dto);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.surveys.getAdmin(claims, id);
  }

  @Put(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SaveSurveyDto) {
    return this.surveys.update(claims, id, dto);
  }

  @Post(":id/open")
  @HttpCode(200)
  open(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.surveys.open(claims, id);
  }

  @Post(":id/close")
  @HttpCode(200)
  close(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.surveys.close(claims, id);
  }

  @Delete(":id")
  async remove(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.surveys.remove(claims, id);
    return { ok: true };
  }

  @Get(":id/results")
  results(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.surveys.results(claims, id);
  }
}
