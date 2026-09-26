import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DataScopeAssignmentsService } from "./data-scope-assignments.service";
import { AssignDataScopeDto } from "./dto/assign-data-scope.dto";

@Controller("platform/data-scope-assignments")
@UseGuards(PlatformAdminGuard)
export class DataScopeAssignmentsController {
  constructor(private readonly dataScopeAssignments: DataScopeAssignmentsService) {}

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("companyId") companyId?: string,
    @Query("userAccountId") userAccountId?: string
  ) {
    return this.dataScopeAssignments.list(claims, companyId || undefined, userAccountId || undefined);
  }

  @Post()
  assign(@CurrentClaims() claims: RequestClaims, @Body() dto: AssignDataScopeDto) {
    return this.dataScopeAssignments.assign(claims, dto);
  }

  @Delete(":id")
  async revoke(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.dataScopeAssignments.revoke(claims, id);
    return { message: "Data scope assignment revoked." };
  }
}
