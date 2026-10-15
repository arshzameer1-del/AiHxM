import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ConfigurationVersionService } from "./configuration-version.service";
import { CreateConfigurationVersionDto } from "./dto/create-configuration-version.dto";
import { PublishConfigurationVersionDto } from "./dto/publish-configuration-version.dto";

/** CFG-02 -- immutable configuration versions (snapshot, validate, publish, retire, as-of read). */
@Controller("hr-administration/configuration-versions")
@UseGuards(SessionGuard)
export class ConfigurationVersionController {
  constructor(private readonly versions: ConfigurationVersionService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("domain") domain?: string, @Query("status") status?: string) {
    return this.versions.list(claims, domain, status);
  }

  @Get("effective")
  effective(@CurrentClaims() claims: RequestClaims, @Query("domain") domain: string, @Query("asOf") asOf?: string) {
    return this.versions.getEffective(claims, domain, asOf);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.versions.get(claims, id);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateConfigurationVersionDto) {
    return this.versions.createDraft(claims, dto);
  }

  @Post(":id/validate")
  validate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.versions.validate(claims, id);
  }

  @Post(":id/publish")
  publish(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PublishConfigurationVersionDto) {
    return this.versions.publish(claims, id, dto.effectiveFrom);
  }

  @Post(":id/retire")
  retire(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PublishConfigurationVersionDto) {
    return this.versions.retire(claims, id, dto.reason);
  }
}
