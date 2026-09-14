import { Module } from "@nestjs/common";
import { EmployeeGroupsController } from "./employee-groups.controller";
import { EmployeeGroupsService } from "./employee-groups.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";

@Module({
  imports: [RbacModule, EntitlementsModule],
  controllers: [EmployeeGroupsController],
  providers: [EmployeeGroupsService],
  exports: [EmployeeGroupsService],
})
export class EmployeeGroupsModule {}
