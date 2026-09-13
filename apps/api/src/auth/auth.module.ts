import { Module } from "@nestjs/common";
import { PlatformAuthController } from "./platform-auth.controller";
import { PlatformAdminGuard } from "./platform-admin.guard";

@Module({
  controllers: [PlatformAuthController],
  providers: [PlatformAdminGuard],
  exports: [PlatformAdminGuard],
})
export class AuthModule {}
