import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { TalentController } from "./talent.controller";
import { TalentService } from "./talent.service";

@Module({ imports: [RbacModule, EntitlementsModule, AuditModule], controllers: [TalentController], providers: [TalentService], exports: [TalentService] })
export class TalentModule {}
