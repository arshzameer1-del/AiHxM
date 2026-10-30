import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EmployeesModule } from "../employees/employees.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { CompensationCyclesController } from "./compensation-cycles.controller";
import { CompensationCyclesService } from "./compensation-cycles.service";

@Module({ imports: [RbacModule, EntitlementsModule, AuditModule, EmployeesModule], controllers: [CompensationCyclesController], providers: [CompensationCyclesService], exports: [CompensationCyclesService] })
export class CompensationCyclesModule {}
