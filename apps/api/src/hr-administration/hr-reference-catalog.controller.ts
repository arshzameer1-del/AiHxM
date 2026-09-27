import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { HrReferenceCatalogService } from "./hr-reference-catalog.service";
import { CreateHrReferenceCatalogItemDto } from "./dto/create-hr-reference-catalog-item.dto";
import { UpdateHrReferenceCatalogItemDto } from "./dto/update-hr-reference-catalog-item.dto";
import { ReorderHrReferenceCatalogItemsDto } from "./dto/reorder-hr-reference-catalog-items.dto";

/**
 * HR Administration — the reference-catalog workspace's own API surface,
 * deliberately under `/hr-administration`, not `/configuration/...` — see
 * `hr-reference-catalog.service.ts`'s class doc comment for why the two
 * stay separate per the v2 spec's own Section 7.
 */
@Controller("hr-administration/reference-catalog")
@UseGuards(SessionGuard)
export class HrReferenceCatalogController {
  constructor(private readonly catalog: HrReferenceCatalogService) {}

  @Get("types")
  listTypes(@CurrentClaims() claims: RequestClaims) {
    return this.catalog.listCatalogTypes(claims);
  }

  @Get(":catalogType")
  listItems(
    @CurrentClaims() claims: RequestClaims,
    @Param("catalogType") catalogType: string,
    @Query("includeInactive") includeInactive?: string
  ) {
    return this.catalog.listItems(claims, catalogType, includeInactive === "true");
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateHrReferenceCatalogItemDto) {
    return this.catalog.create(claims, dto);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateHrReferenceCatalogItemDto) {
    return this.catalog.update(claims, id, dto);
  }

  @Patch(":catalogType/reorder")
  reorder(
    @CurrentClaims() claims: RequestClaims,
    @Param("catalogType") catalogType: string,
    @Body() dto: ReorderHrReferenceCatalogItemsDto
  ) {
    return this.catalog.reorder(claims, catalogType, dto.orderedIds);
  }
}
