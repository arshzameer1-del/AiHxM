import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAssetsService } from "./employee-assets.service";
import { CreateEmployeeAssetDto } from "./dto/create-employee-asset.dto";
import { UpdateEmployeeAssetDto } from "./dto/update-employee-asset.dto";
import { ReturnEmployeeAssetDto } from "./dto/return-employee-asset.dto";

/** Core Employee Enterprise Phase 9 — the Assets card's own CRUD surface, outside the hiring flow. */
@Controller("employees/assets")
@UseGuards(SessionGuard)
export class EmployeeAssetsController {
  constructor(private readonly assets: EmployeeAssetsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeAssetDto) {
    return this.assets.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.assets.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeAssetDto) {
    return this.assets.update(claims, id, dto);
  }

  @Post(":id/return")
  returnAsset(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ReturnEmployeeAssetDto) {
    return this.assets.returnAsset(claims, id, dto?.returnedDate);
  }
}
