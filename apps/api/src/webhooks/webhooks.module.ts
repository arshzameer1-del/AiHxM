import { Module } from "@nestjs/common";
import { WebhookDispatchService } from "./webhook-dispatch.service";
import { AuditModule } from "../audit/audit.module";

/**
 * Phase 3 item #4 — Webhooks & Eventing. A deliberately slim module that
 * exports only `WebhookDispatchService` — no controller of its own (the
 * admin-facing list/replay/test routes live in `TenantManagementModule`,
 * see `webhooks-admin.controller.ts`).
 *
 * This exists as its own module, rather than folding the service into
 * `TenantManagementModule`, specifically so a real HR-domain module like
 * `EmployeesModule` can call `enqueue()` at the 2-3 genuinely valuable
 * trigger points (see `EmployeesService`'s own comment on which and why)
 * without importing the whole of `TenantManagementModule` — which owns a
 * dozen unrelated controllers/services and, per the "rule of three, don't
 * over-build ahead of demand" discipline this codebase already applies
 * elsewhere (see onboarding-offboarding's own module doc comments), is
 * not something `EmployeesModule` has ever needed before and shouldn't
 * gain a dependency on now just to send a webhook. `WebhooksModule`
 * itself imports nothing from `EmployeesModule` or `TenantManagementModule`,
 * so both can safely import this one without any circular-import risk.
 */
@Module({
  imports: [AuditModule],
  providers: [WebhookDispatchService],
  exports: [WebhookDispatchService],
})
export class WebhooksModule {}
