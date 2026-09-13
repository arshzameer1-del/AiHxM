import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PlatformAdminGuard } from "./platform-admin.guard";

@Module({
  controllers: [AuthController],
  providers: [AuthService, PlatformAdminGuard],
  exports: [AuthService, PlatformAdminGuard],
})
export class AuthModule {}
