import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollPayslipNoticesService } from "./payroll-payslip-notices.service";

/** Emails employees that their payslip is ready. Permissions are decided in the service (payroll-area scoped). */
@Controller()
@UseGuards(SessionGuard)
export class PayrollPayslipNoticesController {
  constructor(private readonly notices: PayrollPayslipNoticesService) {}

  @Post("payroll/runs/:runId/notify-payslips")
  notify(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string) {
    return this.notices.notifyRun(claims, runId);
  }
}
