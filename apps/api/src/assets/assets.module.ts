import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacModule } from "../rbac/rbac.module";
import { AssetRegisterController } from "./asset-register.controller";
import { AssetRegisterService } from "./asset-register.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, NotificationsModule],
  controllers: [AssetRegisterController],
  providers: [AssetRegisterService],
  exports: [AssetRegisterService],
})
export class AssetsModule {}
