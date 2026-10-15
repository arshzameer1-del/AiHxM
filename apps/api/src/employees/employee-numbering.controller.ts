import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeNumberingService } from "./employee-numbering.service";
import { UpdateEmployeeNumberPolicyDto } from "./dto/employee-number-policy.dto";

/** Configuration Center - employee numbering policy and the issued-number ledger (CFG-13). */
@Controller("configuration/core-employee/numbering")
@UseGuards(SessionGuard)
export class EmployeeNumberingController {
  constructor(private readonly numbering: EmployeeNumberingService) {}

  @Get()
  policy(@CurrentClaims() claims: RequestClaims) {
    return this.numbering.getPolicy(claims);
  }

  @Put()
  update(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdateEmployeeNumberPolicyDto) {
    return this.numbering.updatePolicy(claims, dto);
  }

  @Get("ledger")
  ledger(@CurrentClaims() claims: RequestClaims, @Query("state") state?: string, @Query("limit") limit?: string) {
    return this.numbering.list(claims, { state, limit: limit ? Number(limit) : undefined });
  }
}
