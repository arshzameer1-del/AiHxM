import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { FieldPermissionRulesService } from "./field-permission-rules.service";
import { CreateFieldPermissionRuleDto } from "./dto/field-permission-rule.dto";

/** ACC-01 -- tenant field-level security rules. */
@Controller("rbac/field-permission-rules")
@UseGuards(SessionGuard)
export class FieldPermissionRulesController {
  constructor(private readonly rules: FieldPermissionRulesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("roleId") roleId?: string, @Query("objectKey") objectKey?: string) {
    return this.rules.list(claims, roleId, objectKey);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateFieldPermissionRuleDto) {
    return this.rules.create(claims, dto);
  }

  @Delete(":id")
  async remove(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.rules.remove(claims, id);
    return { message: "Field rule removed." };
  }
}
