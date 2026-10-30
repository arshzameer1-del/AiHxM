import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { HeadcountController } from "./headcount.controller";
import { HeadcountService } from "./headcount.service";

@Module({ imports: [RbacModule, EntitlementsModule, AuditModule], controllers: [HeadcountController], providers: [HeadcountService], exports: [HeadcountService] })
export class HeadcountModule {}
