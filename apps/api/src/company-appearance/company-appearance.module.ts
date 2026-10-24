import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { RbacModule } from "../rbac/rbac.module";
import { CompanyAppearanceController } from "./company-appearance.controller";
import { CompanyAppearanceService } from "./company-appearance.service";

@Module({
  imports: [RbacModule, AuditModule, FileStorageModule],
  controllers: [CompanyAppearanceController],
  providers: [CompanyAppearanceService],
  exports: [CompanyAppearanceService],
})
export class CompanyAppearanceModule {}
