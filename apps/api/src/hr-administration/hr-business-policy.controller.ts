import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { HrBusinessPolicyService } from "./hr-business-policy.service";
import { CreateHrBusinessPolicyDto } from "./dto/create-hr-business-policy.dto";
import { UpdateHrBusinessPolicyDto } from "./dto/update-hr-business-policy.dto";
import { ReorderHrBusinessPoliciesDto } from "./dto/reorder-hr-business-policies.dto";

/**
 * HR Administration — the business-policy workspace's own API surface
 * ("then 2" Phase 2, item #8), sitting alongside
 * `HrReferenceCatalogController` under the same `/hr-administration`
 * prefix — see `hr-business-policy.service.ts`'s own class doc comment
 * for why a policy gets its own table/service rather than reusing the
 * reference-catalog engine.
 */
@Controller("hr-administration/business-policies")
@UseGuards(SessionGuard)
export class HrBusinessPolicyController {
  constructor(private readonly policies: HrBusinessPolicyService) {}

  @Get("types")
  listTypes(@CurrentClaims() claims: RequestClaims) {
    return this.policies.listPolicyTypes(claims);
  }

  @Get(":policyType")
  listPolicies(
    @CurrentClaims() claims: RequestClaims,
    @Param("policyType") policyType: string,
    @Query("includeInactive") includeInactive?: string
  ) {
    return this.policies.listPolicies(claims, policyType, includeInactive === "true");
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateHrBusinessPolicyDto) {
    return this.policies.create(claims, dto);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateHrBusinessPolicyDto) {
    return this.policies.update(claims, id, dto);
  }

  @Patch(":policyType/reorder")
  reorder(
    @CurrentClaims() claims: RequestClaims,
    @Param("policyType") policyType: string,
    @Body() dto: ReorderHrBusinessPoliciesDto
  ) {
    return this.policies.reorder(claims, policyType, dto.orderedIds);
  }
}
