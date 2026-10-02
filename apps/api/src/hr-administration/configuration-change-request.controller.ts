import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ConfigurationChangeRequestService } from "./configuration-change-request.service";
import { CreateConfigurationChangeRequestDto } from "./dto/create-configuration-change-request.dto";
import { RejectConfigurationChangeRequestDto } from "./dto/reject-configuration-change-request.dto";

/**
 * HR Administration — the Configuration Publish Lifecycle's own API
 * surface ("then 2" Phase 6, item #13), sitting alongside the other HR
 * Administration controllers under the same `/hr-administration` prefix.
 * See `configuration-change-request.service.ts`'s own class doc comment
 * for the full Draft -> Validate -> Approve -> Publish -> Retire state
 * machine this wraps around.
 */
@Controller("hr-administration/change-requests")
@UseGuards(SessionGuard)
export class ConfigurationChangeRequestController {
  constructor(private readonly changes: ConfigurationChangeRequestService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("configDomain") configDomain?: string, @Query("status") status?: string) {
    return this.changes.list(claims, configDomain, status);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.get(claims, id);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateConfigurationChangeRequestDto) {
    return this.changes.create(claims, dto);
  }

  @Post(":id/validate")
  validate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.validate(claims, id);
  }

  @Post(":id/submit")
  submit(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.submitForApproval(claims, id);
  }

  @Post(":id/approve")
  approve(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.approve(claims, id);
  }

  @Post(":id/reject")
  reject(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RejectConfigurationChangeRequestDto) {
    return this.changes.reject(claims, id, dto.reason);
  }

  @Post(":id/publish")
  publish(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.publish(claims, id);
  }

  @Post(":id/retire")
  retire(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.retire(claims, id);
  }

  @Post(":id/rollback")
  rollback(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.changes.rollback(claims, id);
  }
}
