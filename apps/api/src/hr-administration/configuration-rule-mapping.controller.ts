import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ConfigurationRuleMappingService } from "./configuration-rule-mapping.service";
import { CreateConfigurationRuleMappingDto } from "./dto/create-configuration-rule-mapping.dto";
import { UpdateConfigurationRuleMappingDto } from "./dto/update-configuration-rule-mapping.dto";

/**
 * HR Administration — the Configuration Hierarchy & Resolution / Mapping
 * Engine's own API surface ("then 2" Phases 4+5, items #11+#12), sitting
 * alongside `HrBusinessPolicyController`/`HrReferenceCatalogController`
 * under the same `/hr-administration` prefix — see
 * `configuration-rule-mapping.service.ts`'s own class doc comment for why
 * items #11 and #12 are one engine here rather than two.
 *
 * `list`/`create`/`update` are a management surface for ANY registered
 * `configDomain`/`configKey` pair — the frontend scopes which pairs it
 * shows (today: `configDomain=hr_business_policy`, one `configKey` per
 * registered policy type) rather than this controller enumerating them,
 * the same "generic engine, caller decides which domain" shape
 * `HrReferenceCatalogController` already uses for catalog types.
 */
@Controller("hr-administration/rule-mappings")
@UseGuards(SessionGuard)
export class ConfigurationRuleMappingController {
  constructor(private readonly mappings: ConfigurationRuleMappingService) {}

  @Get(":configDomain/:configKey")
  list(
    @CurrentClaims() claims: RequestClaims,
    @Param("configDomain") configDomain: string,
    @Param("configKey") configKey: string,
    @Query("includeInactive") includeInactive?: string
  ) {
    return this.mappings.list(claims, configDomain, configKey, includeInactive === "true");
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateConfigurationRuleMappingDto) {
    return this.mappings.create(claims, dto);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateConfigurationRuleMappingDto) {
    return this.mappings.update(claims, id, dto);
  }
}
