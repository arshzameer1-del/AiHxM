import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RuleRegistryService } from "./rule-registry.service";
import { CreateRuleDefinitionDto, CreateRuleVersionDto, EvaluateRuleDto } from "./dto/rule-registry.dto";
import { PublishConfigurationVersionDto } from "./dto/publish-configuration-version.dto";

/** CFG-14 -- central rule registry. */
@Controller("hr-administration/rules")
@UseGuards(SessionGuard)
export class RuleRegistryController {
  constructor(private readonly rules: RuleRegistryService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("ruleType") ruleType?: string) {
    return this.rules.listDefinitions(claims, ruleType);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateRuleDefinitionDto) {
    return this.rules.createDefinition(claims, dto);
  }

  @Post("evaluate")
  evaluate(@CurrentClaims() claims: RequestClaims, @Body() dto: EvaluateRuleDto) {
    return this.rules.evaluate(claims, dto.ruleKey, dto.context, dto.asOf);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.rules.setActive(claims, id, true);
  }

  @Post(":id/deactivate")
  deactivate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.rules.setActive(claims, id, false);
  }

  @Get(":id/versions")
  versions(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.rules.listVersions(claims, id);
  }

  @Post(":id/versions")
  createVersion(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CreateRuleVersionDto) {
    return this.rules.createVersion(claims, id, dto);
  }

  @Post("versions/:versionId/publish")
  publish(@CurrentClaims() claims: RequestClaims, @Param("versionId") versionId: string, @Body() dto: PublishConfigurationVersionDto) {
    return this.rules.publishVersion(claims, versionId, dto.effectiveFrom);
  }

  @Post("versions/:versionId/retire")
  retire(@CurrentClaims() claims: RequestClaims, @Param("versionId") versionId: string, @Body() dto: PublishConfigurationVersionDto) {
    return this.rules.retireVersion(claims, versionId, dto.reason);
  }
}
