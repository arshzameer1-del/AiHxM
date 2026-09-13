import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { SessionGuard } from "./session.guard";

@Module({
  controllers: [AuthController],
  providers: [AuthService, PlatformAdminGuard, SessionGuard],
  exports: [AuthService, PlatformAdminGuard, SessionGuard],
})
export class AuthModule {}
