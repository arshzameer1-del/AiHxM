import { Module } from "@nestjs/common";
import { SystemAdminController } from "./system-admin.controller";
import { SystemAdminService } from "./system-admin.service";
import { RbacModule } from "../rbac/rbac.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [RbacModule, AuditModule],
  controllers: [SystemAdminController],
  providers: [SystemAdminService],
  exports: [SystemAdminService],
})
export class SystemAdminModule {}
