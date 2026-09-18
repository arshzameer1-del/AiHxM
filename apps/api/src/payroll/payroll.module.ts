import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { ImportExportModule } from "../import-export/import-export.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, ImportExportModule, EffectiveDatingModule],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
