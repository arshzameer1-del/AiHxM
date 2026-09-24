import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { CompanyListFilters } from "@aihxm/shared-types";
import { SavedViewsService } from "./saved-views.service";

class CreateSavedViewDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsObject()
  filters?: CompanyListFilters;
}

@Controller("platform/saved-views")
@UseGuards(PlatformAdminGuard)
export class SavedViewsController {
  constructor(private readonly savedViews: SavedViewsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.savedViews.list(claims);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateSavedViewDto) {
    return this.savedViews.create(claims, dto.name, dto.filters ?? {});
  }

  @Delete(":id")
  async delete(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.savedViews.delete(claims, id);
    return { message: "Saved view deleted." };
  }
}
