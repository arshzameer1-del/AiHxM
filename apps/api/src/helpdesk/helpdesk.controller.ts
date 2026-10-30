import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { FormSettingsService } from "../form-settings/form-settings.service";
import { HelpdeskService } from "./helpdesk.service";

class RaiseDto {
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsString() @MaxLength(200) subject!: string;
  @IsString() @MaxLength(4000) body!: string;
}
class ReplyDto {
  @IsString() @MaxLength(4000) body!: string;
}
class CategoryDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(60) name!: string;
  @IsOptional() @IsInt() @Min(1) @Max(720) slaHours?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller("helpdesk")
@UseGuards(SessionGuard)
export class HelpdeskController {
  constructor(private readonly helpdesk: HelpdeskService, private readonly formSettings: FormSettingsService) {}

  // employee
  @Get("categories") categories(@CurrentClaims() claims: RequestClaims) { return this.helpdesk.categoriesForEmployee(claims); }
  @Get("mine") mine(@CurrentClaims() claims: RequestClaims) { return this.helpdesk.mine(claims); }
  @Post("tickets") @HttpCode(200) async raise(@CurrentClaims() claims: RequestClaims, @Body() dto: RaiseDto) { await this.formSettings.enforce(claims, "helpdesk_ticket", dto as unknown as Record<string, unknown>); return this.helpdesk.raise(claims, dto); }
  @Get("tickets/:id/mine") getMine(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.helpdesk.getMine(claims, id); }

  // HR (static paths first)
  @Get("queue") queue(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string) { return this.helpdesk.queue(claims, status); }
  @Get("summary") summary(@CurrentClaims() claims: RequestClaims) { return this.helpdesk.summary(claims); }
  @Get("categories/admin") categoriesAdmin(@CurrentClaims() claims: RequestClaims) { return this.helpdesk.categoriesAdmin(claims); }
  @Post("categories") @HttpCode(200) saveCategory(@CurrentClaims() claims: RequestClaims, @Body() dto: CategoryDto) { return this.helpdesk.saveCategory(claims, dto); }
  @Post("categories/starter") @HttpCode(200) starter(@CurrentClaims() claims: RequestClaims) { return this.helpdesk.addStarterCategories(claims); }
  @Get("tickets/:id") getAdmin(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.helpdesk.getAdmin(claims, id); }

  // both sides (service decides)
  @Post("tickets/:id/reply") @HttpCode(200) reply(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReplyDto) { return this.helpdesk.reply(claims, id, dto.body); }
  @Post("tickets/:id/resolve") @HttpCode(200) resolve(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.helpdesk.resolve(claims, id); }
}
