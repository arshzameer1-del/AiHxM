import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { FormSettingsService } from "./form-settings.service";
import { FormLayoutService } from "./form-layout.service";

class UpdateDto {
  @IsOptional() @IsString() @MaxLength(200) label?: string | null;
  @IsOptional() @IsString() @MaxLength(400) helpText?: string | null;
  @IsOptional() @IsString() @MaxLength(200) placeholder?: string | null;
  @IsOptional() @IsBoolean() hidden?: boolean;
  @IsOptional() @IsBoolean() required?: boolean | null;
  @IsOptional() @IsInt() @Min(1) @Max(20000) maxLength?: number | null;
}

@Controller("form-settings")
@UseGuards(SessionGuard)
export class FormSettingsController {
  constructor(private readonly settings: FormSettingsService) {}

  @Get() all(@CurrentClaims() claims: RequestClaims) { return this.settings.forms(claims); }
  @Get("history") history(@CurrentClaims() claims: RequestClaims, @Query("form") form?: string) { return this.settings.history(claims, form); }
  @Post("history/:id/restore") @HttpCode(200) restore(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.settings.restore(claims, id); }
  @Get(":form") one(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.settings.form(claims, form); }
  @Put(":form/:field") update(@CurrentClaims() claims: RequestClaims, @Param("form") form: string, @Param("field") field: string, @Body() dto: UpdateDto) { return this.settings.update(claims, form, field, dto); }
  @Delete(":form/:field") reset(@CurrentClaims() claims: RequestClaims, @Param("form") form: string, @Param("field") field: string) { return this.settings.reset(claims, form, field); }
}

/** The form designer: what a screen needs to draw a form, and the draft / publish / reset steps for the people who design it. */
@Controller("form-layouts")
@UseGuards(SessionGuard)
export class FormLayoutController {
  constructor(private readonly layouts: FormLayoutService) {}

  @Get(":form") view(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.layouts.view(claims, form); }
  @Get(":form/designer") designer(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.layouts.designer(claims, form); }
  @Get(":form/history") history(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.layouts.history(claims, form); }
  @Put(":form/draft") saveDraft(@CurrentClaims() claims: RequestClaims, @Param("form") form: string, @Body() body: { layout: unknown }) { return this.layouts.saveDraft(claims, form, body?.layout); }
  @Delete(":form/draft") discardDraft(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.layouts.discardDraft(claims, form); }
  @Post(":form/publish") @HttpCode(200) publish(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.layouts.publish(claims, form); }
  @Delete(":form") reset(@CurrentClaims() claims: RequestClaims, @Param("form") form: string) { return this.layouts.reset(claims, form); }
  @Post(":form/history/:id/load") @HttpCode(200) load(@CurrentClaims() claims: RequestClaims, @Param("form") form: string, @Param("id", ParseUUIDPipe) id: string) { return this.layouts.restoreToDraft(claims, form, id); }
}
