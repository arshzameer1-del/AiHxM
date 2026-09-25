import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { AuditLogFilters, CompanyListFilters, PlatformSavedViewType } from "@aihxm/shared-types";
import { SavedViewsService } from "./saved-views.service";

const VIEW_TYPES: PlatformSavedViewType[] = ["tenant_directory", "audit_log"];

class CreateSavedViewDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  // Tenant Management gap-fill Phase 1 item #6 — defaults to
  // 'tenant_directory' so the existing Tenant Directory "save view" call
  // site (which never sent this field) keeps working unchanged.
  @IsOptional()
  @IsIn(VIEW_TYPES)
  viewType?: PlatformSavedViewType;

  @IsOptional()
  @IsObject()
  filters?: CompanyListFilters | AuditLogFilters;
}

@Controller("platform/saved-views")
@UseGuards(PlatformAdminGuard)
export class SavedViewsController {
  constructor(private readonly savedViews: SavedViewsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("viewType") viewType?: string) {
    return this.savedViews.list(claims, viewType as PlatformSavedViewType | undefined);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateSavedViewDto) {
    return this.savedViews.create(claims, dto.name, dto.viewType ?? "tenant_directory", dto.filters ?? {});
  }

  @Delete(":id")
  async delete(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.savedViews.delete(claims, id);
    return { message: "Saved view deleted." };
  }
}
