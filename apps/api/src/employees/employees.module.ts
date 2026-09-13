import { Module } from "@nestjs/common";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { FileStorageModule } from "../file-storage/file-storage.module";

@Module({
  imports: [RbacModule, EntitlementsModule, FileStorageModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
