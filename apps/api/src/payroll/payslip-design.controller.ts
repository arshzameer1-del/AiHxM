import { Body, Controller, Delete, Get, Put, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayslipDesignService } from "./payslip-design.service";

/** Payslip print design. Reading is open to the company's own sessions (their paystub is drawn from it); changing it needs payroll configuration. */
@Controller("payroll/payslip-design")
@UseGuards(SessionGuard)
export class PayslipDesignController {
  constructor(private readonly design: PayslipDesignService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims) {
    return this.design.get(claims);
  }

  /** The body is the design itself; it is validated against the shared design rules, not a DTO class. */
  @Put()
  save(@CurrentClaims() claims: RequestClaims, @Body() body: unknown) {
    return this.design.save(claims, body);
  }

  @Delete()
  reset(@CurrentClaims() claims: RequestClaims) {
    return this.design.reset(claims);
  }
}
