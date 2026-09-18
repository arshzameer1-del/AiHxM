import { Module } from "@nestjs/common";
import { EmployeeGroupsController } from "./employee-groups.controller";
import { EmployeeGroupsService } from "./employee-groups.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";
import { RulesEngineModule } from "../rules-engine/rules-engine.module";

@Module({
  imports: [RbacModule, EntitlementsModule, EffectiveDatingModule, RulesEngineModule],
  controllers: [EmployeeGroupsController],
  providers: [EmployeeGroupsService],
  exports: [EmployeeGroupsService],
})
export class EmployeeGroupsModule {}
