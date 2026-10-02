import { Module } from "@nestjs/common";
import { AuditModule } from "../../audit/audit.module";
import { EffectiveDatingModule } from "../../effective-dating/effective-dating.module";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { OrgOccupancyService } from "./org-occupancy.service";

/**
 * Cross-module integration audit (2026-10-01) — deliberately slim, the
 * same shape `WebhooksModule` already uses: imports only shared
 * infrastructure modules that themselves import nothing of ours, and
 * exports exactly one provider. That is what lets BOTH `EmployeesModule`
 * (hiring completion, lifecycle transactions) and `OrganizationModule`
 * (Position Workbench, reorganization cascade) import it without the
 * `EmployeesModule` <-> `OrganizationModule` cycle a direct import would
 * create — see `OrgOccupancyService`'s own class doc comment for the full
 * rationale versus an event or `forwardRef()`.
 */
@Module({
  imports: [AuditModule, EffectiveDatingModule, WebhooksModule],
  providers: [OrgOccupancyService],
  exports: [OrgOccupancyService],
})
export class OrgOccupancyModule {}
